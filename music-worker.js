// ============================================================
//  Cloudflare Worker —— 音乐馆音频代理（用于「真实音乐可视化」）
//
//  目的：
//    1) 代理 meting-api 的歌单 JSON（默认上游 music.zhheo.com），并用 Cache API 缓存
//    2) 把每首歌的音频 url 改写成走本 Worker，由 Worker 转发音频流
//       并带上 Access-Control-Allow-Origin，使音频对浏览器成为「CORS 干净」，
//       这样前端 Web Audio 的 AnalyserNode 才能读到真实频谱（否则恒为 0）
//
//  部署：登录 dash.cloudflare.com → Workers & Pages → 创建/编辑 Worker
//        → 粘贴本文件 → 保存并部署 → 绑定自定义域（可选）
//
//  前端调用：
//    · 歌单：  GET https://你的Worker地址/?server=netease&type=playlist&id=13908245149&r=0.x
//    · 音频：  GET https://你的Worker地址/?audio=<编码后的原始音频地址>
//  返回：歌单为 JSON 数组；音频为原始音频流（带 CORS 头）
// ============================================================

// 上游 meting-api 默认地址（与 HeoMusic 默认一致）
const METING_API = 'https://music.zhheo.com/meting-api';

// 歌单 JSON 的缓存时长（秒）。
// 前端每次打开页面都会带一个随机参数 r 请求歌单，缓存键刻意剔除 r，
// 让同一歌单在 TTL 内命中缓存、不再穿透到上游。5 分钟：吸收短时间内的重复访问，
// 又不至于让歌单新增歌曲长时间不生效。
const PLAYLIST_CACHE_TTL = 300;

// Cache API 的 key 用内部伪域名（只作 key 使用，不会真的发起网络请求）
const CACHE_KEY_ORIGIN = 'https://music-playlist-cache.internal';

// 转发时需要保留的音频响应头
const AUDIO_HEADERS = [
  'content-type',
  'content-length',
  'accept-ranges',
  'content-range',
  'cache-control',
  'etag',
  'last-modified',
];

// 转发时需要保留的图片响应头（用于专辑封面取色：代理封面图并加 CORS 头，
// 使前端能用 crossOrigin='anonymous' 读取像素、提取主色，否则 canvas 会被 taint）
const IMAGE_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

// 把歌单 JSON 里每首歌的 url 改写成走本 Worker 的音频代理
function rewriteUrls(list, proxyBase) {
  if (Array.isArray(list)) {
    return list.map((item) => ({
      ...item,
      url: item.url ? `${proxyBase}?audio=${encodeURIComponent(item.url)}` : item.url,
    }));
  }
  // 部分接口返回单对象（如 url 直链模式）
  if (list && typeof list === 'object' && list.url) {
    return { ...list, url: `${proxyBase}?audio=${encodeURIComponent(list.url)}` };
  }
  return list;
}

// 拉取上游歌单 JSON，并走 Cache API 缓存。设计要点：
//   · 缓存键剔除随机参数 r —— 前端每次请求都带不同的 r，算进 key 会导致缓存永不命中。
//   · 缓存内容存「上游原始 JSON」；音频 url 的改写依赖当前请求的域名与路径（proxyBase），
//     所以改写放在命中之后再做，这样同一份缓存可服务不同域名/路径下的访问。
//   · Cache API 不可用、读写失败时全部静默降级为直接穿透上游，保证功能不受影响。
async function fetchPlaylist(server, type, id, r, ctx) {
  const cacheKeyUrl =
    CACHE_KEY_ORIGIN + '/playlist' +
    '?server=' + encodeURIComponent(server) +
    '&type=' + encodeURIComponent(type) +
    '&id=' + encodeURIComponent(id);

  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }

  if (cache) {
    try {
      const hit = await cache.match(new Request(cacheKeyUrl, { method: 'GET' }));
      if (hit) return await hit.json();
    } catch (e) { /* 读缓存失败：忽略，继续走上游 */ }
  }

  const apiUrl =
    METING_API + '/' +
    '?server=' + encodeURIComponent(server) +
    '&type=' + encodeURIComponent(type) +
    '&id=' + encodeURIComponent(id) +
    '&r=' + encodeURIComponent(r);
  const resp = await fetch(apiUrl);
  const data = await resp.json();

  // 仅在拿到正常歌单时写缓存：上游报错不缓存，避免把错误状态固化 TTL 这么久
  if (cache && data && !data.error) {
    const putKey = new Request(cacheKeyUrl, { method: 'GET' });
    const toCache = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=' + PLAYLIST_CACHE_TTL,
      },
    });
    // 写缓存失败绝不能影响本次响应。
    // 注意：ctx.waitUntil 收到的是 promise，必须在传入前就挂上 catch ——
    // 否则 put 失败会变成「未处理的 promise 拒绝」，外层 try/catch 抓不到异步拒绝。
    const putPromise = cache.put(putKey, toCache).catch(() => {});
    try {
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(putPromise); // 异步写，不拖慢本次响应
      } else {
        await putPromise;
      }
    } catch (e) { /* waitUntil 本身异常：忽略 */ }
  }

  return data;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: '仅支持 GET' }, 405);
    }

    // 音频流代理
    const audioTarget = url.searchParams.get('audio');
    if (audioTarget) {
      try {
        // 仅在有 Range 时透传（避免发送空的 Range 头导致上游报错）
        const upstreamHeaders = new Headers();
        const range = request.headers.get('Range');
        if (range) upstreamHeaders.set('Range', range);

        const upstream = await fetch(audioTarget, {
          headers: upstreamHeaders,
          redirect: 'follow',
        });
        const headers = new Headers();
        for (const [k, v] of upstream.headers.entries()) {
          if (AUDIO_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
        }
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) {
        return jsonResponse({ error: `音频代理失败: ${e.message}` }, 502);
      }
    }

    // 图片代理（专辑封面取色用）：转发封面图并加 CORS 头
    const imgTarget = url.searchParams.get('img');
    if (imgTarget) {
      try {
        const upstream = await fetch(imgTarget, { redirect: 'follow' });
        const headers = new Headers();
        for (const [k, v] of upstream.headers.entries()) {
          if (IMAGE_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
        }
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', 'public, max-age=86400');
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) {
        return jsonResponse({ error: `图片代理失败: ${e.message}` }, 502);
      }
    }

    // 歌单 JSON 代理（走 Cache API 缓存，命中时不再穿透上游）
    const server = url.searchParams.get('server') || 'netease';
    const type = url.searchParams.get('type') || 'playlist';
    const id = url.searchParams.get('id');
    const r = url.searchParams.get('r') || Math.random();

    if (!id) {
      return jsonResponse({ error: '缺少 id 参数' }, 400);
    }

    try {
      const data = await fetchPlaylist(server, type, id, r, ctx);
      const proxyBase = `${url.origin}${url.pathname}`;
      const rewritten = rewriteUrls(data, proxyBase);
      return new Response(JSON.stringify(rewritten), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return jsonResponse({ error: `歌单代理失败: ${e.message}` }, 502);
    }
  },
};
