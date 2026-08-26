// ============================================================
//  Cloudflare Worker —— 音乐馆音频代理（用于「真实音乐可视化」）
//
//  目的：
//    1) 代理 meting-api 的歌单 JSON（默认上游 music.zhheo.com）
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

export default {
  async fetch(request) {
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

    // 歌单 JSON 代理
    const server = url.searchParams.get('server') || 'netease';
    const type = url.searchParams.get('type') || 'playlist';
    const id = url.searchParams.get('id');
    const r = url.searchParams.get('r') || Math.random();

    if (!id) {
      return jsonResponse({ error: '缺少 id 参数' }, 400);
    }

    const apiUrl = `${METING_API}/?server=${encodeURIComponent(server)}&type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&r=${encodeURIComponent(r)}`;
    try {
      const resp = await fetch(apiUrl);
      const data = await resp.json();
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
