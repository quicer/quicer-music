/* ============================================================
 *  settings.js — QuiMusic 设置面板 + QuiID 账号同步
 *  ------------------------------------------------------------
 *  职责边界（刻意分得很清，方便以后各自演进）：
 *    1) 定义有哪些设置项、默认值是什么、怎么做类型校正
 *    2) 本地持久化（localStorage）—— 打开页面立刻生效，不等网络
 *    3) 渲染设置面板的账号区，绑定全部开关/分段的交互
 *    4) 登录 QuiID 后把设置推到云端 / 从云端拉回，实现跨设备同步
 *
 *  ★ 同步时机（2026-10-01 改）：
 *    改设置时**不再**打接口，只写 localStorage 并标一个 pending 标记；
 *    真正的推送发生在「离开 QuiMusic」的时候 —— visibilitychange→hidden
 *    （切标签 / 切后台 / 关页面，移动端最可靠）与 pagehide（真正卸载）。
 *    这样连续拨动开关也只会产生 0 次请求，离开时最多 1 次。
 *    详见下面的 pushOnExit()。
 *
 *  本模块**不碰播放器**。它只负责“知道设置是什么”并广播变更，
 *  真正的应用逻辑在 main.js 里监听 quimusic:settings 事件完成。
 *
 *  对外接口：window.QuiMusicSettings
 *    all()            取全部设置的副本
 *    get(key)         取单项
 *    set(key, value)  改单项（自动持久化 + 广播；云端同步推迟到离开页面时）
 *    patch(obj)       批量改
 *    onChange(fn)     监听变更
 *    ready(fn)        设置就绪后回调（首次读盘完成）
 *    user()           当前 QuiID 用户（未登录为 null）
 *    login() / logout()
 *    syncState()      'local' | 'dirty' | 'syncing' | 'synced' | 'offline'
 * ============================================================ */
(function (global) {
  'use strict';

  var STORE_KEY = 'quimusic_settings';

  // QuiID 侧登记的应用 id（见 QuiID worker.js 的 builtins）
  var QUIID_APP_ID = 'music';
  // SDK 地址：可被 config.js 的 quiidSdkUrl 覆盖
  var DEFAULT_SDK_URL = 'https://id.quicer.top/quiid.js';

  /* ------------------------------------------------------------
   *  设置项定义
   *  加新设置只需在这里加一行 + 在 index.html 加对应的 DOM，
   *  JS 侧的读写/持久化/同步全部自动覆盖，无需改其它地方。
   * ---------------------------------------------------------- */
  var DEFAULTS = {
    visualizer: true,    // 音乐可视化（上下两条频谱）
    lyrics: true,        // 歌词面板
    coverBg: true,       // 封面模糊背景
    coverColor: true,    // 从封面取主色（有网络请求，关掉省流量）
    volumeMemory: true,  // 记住上次音量
    autoplay: false,     // 打开页面自动播放
    order: 'random',     // 播放顺序：list 顺序 / random 随机 / single 单曲
    volume: 0.8          // 被记住的音量值（0~1）
  };

  var ORDER_VALUES = ['list', 'random', 'single'];

  var state = {};
  var listeners = [];
  var readyQueue = [];
  var isReady = false;

  // QuiID 相关
  var sdkLoading = null;
  var currentUser = null;
  var syncState = 'local';   // local | dirty | syncing | synced | offline
  /**
   * 本地是否有「已经改了、但还没成功推到云端」的设置。
   * 它有两个作用，缺一不可：
   *   ① 去重 —— 没改过就不发请求，切几次标签页也不会产生多余的推送；
   *   ② 防丢 —— 万一离开时的推送失败（离线、被系统杀进程），
   *      下次打开拉云端时凭它判断「本地更新」，不会被云端旧值覆盖回去。
   * 必须持久化到 localStorage，否则进程被杀后这个标记就跟着没了。
   */
  var pending = false;
  /** 最近一次「设置被改动」的时间戳。用来判断一次推送期间有没有又发生新改动 */
  var lastChangeAt = 0;

  /* ------------------------------------------------------------
   *  类型校正：本地存储和云端数据都不可信，读进来一律过一遍
   *  （用户手改 localStorage、旧版本残留、云端脏数据都要能兜住）
   * ---------------------------------------------------------- */
  /**
   * 类型校正。
   * 约定：返回 undefined 表示「这个值不可用」，由调用方决定怎么处理 ——
   *   · 加载本地 / 拉云端时回落默认值（sanitize）
   *   · 运行时改设置时保持原值不动（set / patch）
   * 这样区分的意义：云端万一存了脏值（如 order 写成 "shuffle"），
   * 不会把用户当前可用的设置一并冲掉。
   */
  function normalize(key, value) {
    var def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    }
    if (key === 'order') {
      return ORDER_VALUES.indexOf(value) >= 0 ? value : undefined;
    }
    if (key === 'volume') {
      var n = parseFloat(value);
      if (isNaN(n)) return undefined;
      return Math.min(1, Math.max(0, n));          // 夹到 0~1
    }
    return value;
  }

  /** 把任意来源的原始设置对象，校正成一份完整、可直接使用的设置 */
  function sanitize(raw) {
    var out = {};
    for (var k in DEFAULTS) {
      var v = (raw && raw[k] !== undefined) ? normalize(k, raw[k]) : undefined;
      out[k] = (v === undefined) ? DEFAULTS[k] : v;
    }
    return out;
  }

  function loadLocal() {
    var raw = null;
    var pend = false;
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (s) {
        var parsed = JSON.parse(s);
        // 兼容两种格式：早期直接存设置，后来包了一层 {settings, updatedAt, pending}
        raw = (parsed && parsed.settings) ? parsed.settings : parsed;
        // 只有「外层包装」这一种形态才带 pending；早期裸设置对象读出来自然是 false
        pend = !!(parsed && parsed.pending);
      }
    } catch (e) { /* 存储不可用或内容损坏 → 用默认值，不影响播放 */ }
    pending = pend;
    return sanitize(raw);
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        settings: state,
        updatedAt: Date.now(),
        pending: pending
      }));
    } catch (e) { /* 隐私模式/配额满：忽略，本次会话仍可用 */ }
  }

  /** 改 pending 标记并落盘（值没变就不写，避免无谓的 localStorage 写入） */
  function setPending(v) {
    v = !!v;
    if (pending === v) return;
    pending = v;
    saveLocal();
  }

  /* ------------------------------------------------------------
   *  变更广播
   * ---------------------------------------------------------- */
  function emit(changed) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state, changed); } catch (e) { console.warn('[settings] 回调异常', e); }
    }
    // 同时发一个 DOM 事件：给不依赖本模块引用的代码（如 main.js）用
    try {
      global.dispatchEvent(new CustomEvent('quimusic:settings', {
        detail: { settings: state, changed: changed }
      }));
    } catch (e) { /* 老浏览器没有 CustomEvent 构造器 */ }
  }

  function flushReady() {
    isReady = true;
    var q = readyQueue.slice();
    readyQueue.length = 0;
    q.forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  /* ============================================================
   *  QuiID 接入
   * ============================================================ */

  /** 按需加载 SDK：失败不能影响设置与播放，所以全部兜住 */
  function loadSdk() {
    if (sdkLoading) return sdkLoading;
    sdkLoading = new Promise(function (resolve) {
      if (global.QuiID) return resolve(global.QuiID);
      var url = (typeof global.quiidSdkUrl !== 'undefined' && global.quiidSdkUrl)
        ? global.quiidSdkUrl : DEFAULT_SDK_URL;
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(global.QuiID || null); };
      s.onerror = function () {
        console.warn('[settings] QuiID SDK 加载失败（离线或被拦截），仅使用本地设置');
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return sdkLoading;
  }

  function setSyncState(next) {
    if (syncState === next) return;
    syncState = next;
    renderAccount();
    emit({});
  }

  /** 初始化账号：换取回调 code → 静默 SSO → 拉云端偏好 */
  function initAccount() {
    loadSdk().then(function (SDK) {
      if (!SDK) { setSyncState('local'); return; }
      try {
        SDK.init({
          clientId: QUIID_APP_ID,
          redirectUri: location.origin + location.pathname,
          // apiBase 刻意不写死：留空时由 SDK 自行推导（当前默认 https://id.quicer.top，
          // 与其它子项目保持一致）。需要指向别的环境时，在 config.js 里加一行
          // `var quiidApiBase = "https://..."` 覆盖即可，不用动本文件。
          apiBase: (typeof global.quiidApiBase !== 'undefined' && global.quiidApiBase)
            ? global.quiidApiBase : undefined
        });
      } catch (e) {
        console.warn('[settings] QuiID 初始化失败', e);
        setSyncState('local');
        return;
      }

      // 1) 授权回跳：URL 带 ?code= 时先换取令牌
      //    注意顺序：必须 await 完再往下读登录态，否则第一次算不出已登录
      Promise.resolve()
        .then(function () { return SDK.exchangeCode(); })
        .catch(function () { return null; })
        .then(function () {
          // 2) 静默 SSO：浏览器里已登录 QuiID 时自动带过来
          return Promise.resolve(SDK.checkSso()).catch(function () { return null; });
        })
        .then(function () {
          return SDK.fetchUser();
        })
        .catch(function () { return null; })
        .then(function (user) {
          currentUser = user || null;
          notifySessionChanged();
          if (currentUser) pullFromCloud();
          else setSyncState('local');
        });

      // SDK 内部的登录态变化（如别处退出）也要跟着走
      SDK.onChange(function (sess) {
        var next = sess && sess.user ? sess.user : null;
        var was = currentUser ? currentUser.uid : null;
        var now = next ? next.uid : null;
        currentUser = next;
        if (now && now !== was) { notifySessionChanged(); pullFromCloud(); }
        else if (!now && was) { notifySessionChanged(); setSyncState('local'); }
      });
    });
  }

  /** 拉云端设置：云端为准；云端为空则把本地推上去做首次播种 */
  function pullFromCloud() {
    var SDK = global.QuiID;
    if (!SDK || !currentUser) return;
    setSyncState('syncing');
    SDK.api('/api/prefs?app_id=' + encodeURIComponent(QUIID_APP_ID), { token: SDK.token() })
      .then(function (d) {
        var cloud = d && d.data && d.data.settings ? d.data.settings : null;

        // ★ 本地还有「已改、但上次离开时没推上去」的设置（pending）—— 以**本地**为准并补推。
        //   这是「只在离开时同步」这个策略的必备兜底：离开时的推送可能失败
        //   （离线、移动端被系统直接杀进程），若照旧让云端覆盖本地，
        //   用户就会看到「改了设置 → 切后台 → 再打开全还原了」。
        //   注意这不改变正常语义：pending 只在「确有未同步改动」时为真。
        if (pending) { pushToCloud(); return; }

        if (cloud) {
          var merged = sanitize(cloud);
          var changed = {};
          for (var k in merged) {
            if (state[k] !== merged[k]) { changed[k] = merged[k]; }
          }
          state = merged;
          saveLocal();
          setSyncState('synced');
          emit(changed);
        } else {
          // 云端还没有这份偏好 → 用本地值播种
          pushToCloud();
        }
      })
      .catch(function (e) {
        console.warn('[settings] 拉取云端设置失败', e);
        setSyncState('offline');
      });
  }

  /**
   * 离开页面时的推送通道：带 keepalive 的原生 fetch。
   *
   * 为什么不能直接用 SDK.api()：它内部就是一句普通 `fetch`，页面一卸载浏览器会**取消在途请求**，
   * 而这恰恰是唯一需要它的时刻。keepalive 让请求脱离页面生命周期、继续跑完再销毁。
   * 请求形状与 SDK.api('/api/prefs') 保持一致（同一 URL、同一 Authorization 头、同一 body）。
   * 这里只发 POST：QuiID 侧 POST 与 PUT 语义一致（见下面降级注释），少一个方法就少一种 CORS 变数。
   */
  function keepalivePrefsPush(SDK, payload) {
    var base = '';
    var token = '';
    try { base = (typeof SDK.apiBase === 'function') ? SDK.apiBase() : ''; } catch (e) {}
    try { token = SDK.token(); } catch (e) {}
    if (!base || !token) return Promise.reject(new Error('缺少 apiBase 或令牌'));

    return fetch(base + '/api/prefs', {
      method: 'POST',
      keepalive: true,          // ★ 关键：请求不随页面销毁而取消
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    });
  }

  /**
   * 推送当前设置到云端。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepalive] 离开页面时用（见 keepalivePrefsPush）
   * @returns {Promise<boolean>} 是否成功。**永远 resolve**，调用方不需要 catch。
   */
  function pushToCloud(opts) {
    opts = opts || {};
    var SDK = global.QuiID;
    if (!SDK || !currentUser) return Promise.resolve(false);

    var payload = {
      app_id: QUIID_APP_ID,
      data: { settings: state, updatedAt: Date.now() }
    };
    // 记下这一份数据的「版本」，用于判断推送期间用户有没有又改过设置
    var snapshotAt = payload.data.updatedAt;

    setSyncState('syncing');

    var req;
    if (opts.keepalive) {
      req = keepalivePrefsPush(SDK, payload);
    } else {
      // 先 PUT，失败再降级 POST。
      // ★ 为什么要降级：PUT 会触发 CORS 预检，一旦服务端 Allow-Methods 里漏了 PUT，
      //   浏览器**直接阻断请求**（服务端零日志，控制台只有一句 CORS 报错），
      //   表现就是「云端不可达，已存本机」但登录一切正常 —— 极难排查。
      //   POST 是通行度更高的方法，通常必在 Allow-Methods 里；QuiID 侧两者语义一致。
      req = SDK.api('/api/prefs', { method: 'PUT', token: SDK.token(), body: payload })
        .catch(function (e) {
          console.warn('[settings] PUT 保存失败，改用 POST 重试', e);
          return SDK.api('/api/prefs', { method: 'POST', token: SDK.token(), body: payload });
        });
    }

    return req.then(function () {
      // 只有「推完之后没有再改过」才能清 pending ——
      // 否则会把推送期间产生的新改动一并误标成「已同步」。
      if (lastChangeAt <= snapshotAt) setPending(false);
      setSyncState(pending ? 'dirty' : 'synced');
      return true;
    }).catch(function (e) {
      console.warn('[settings] 保存到云端失败', e);
      setPending(true);        // 保住本地改动，避免下次打开被云端旧值冲掉
      setSyncState('offline');
      return false;
    });
  }

  /**
   * 设置被改动时调用：只落本地 + 打待同步标记，**不发任何请求**。
   *
   * 未登录时直接返回，即 pending 保持为假 —— 这是刻意维持原有语义：
   * 游客期的设置不参与同步，登录后仍然以云端为准，不会被游客期的本地值反向覆盖。
   */
  function markDirty() {
    if (!currentUser) return;
    lastChangeAt = Date.now();
    setPending(true);
    setSyncState('dirty');
  }

  /**
   * ★ 「离开 QuiMusic」= 把设置同步到云端的唯一时机。
   *   · visibilitychange → hidden：切标签 / 切后台 / 关页面都会**先**触发，
   *     而且此刻页面还活着 —— 移动端「切后台后被系统杀掉」往往只有这一枪机会。
   *   · pagehide：真正卸载（关页面、前进后退、被 bfcache 收走）时的兜底。
   * 两个事件都挂，靠 pending 去重：第一次推成功后 pending 被清掉，
   * 紧接着的第二个事件自然不会重复发请求。
   */
  function pushOnExit() {
    if (!currentUser || !pending || !global.QuiID) return;
    pushToCloud({ keepalive: true });
  }

  function bindExitSync() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') pushOnExit();
    });
    global.addEventListener('pagehide', pushOnExit);
  }

  /* ============================================================
   *  设置面板渲染与交互
   * ============================================================ */

  /**
   * 登录态发生变化的统一出口。
   * 为什么不只依赖 setSyncState 的广播：它内部有「值相同就不广播」的短路
   * （如 syncState 本来就是 'local' 时再登出一次就不发事件），
   * 而登录态本身是必须被 main.js 感知的 —— 否则退出登录后音乐可视化不会停。
   */
  function notifySessionChanged() {
    renderAccount();
    renderControls();
    emit({});
  }

  /** 账号区：根据登录态渲染三种形态 */
  function renderAccount() {
    // 登录态一变，除了账号区，还要同步「音乐可视化」那一行的可用性
    renderVisualizerLock();

    var box = document.getElementById('heo-account');
    if (!box) return;

    var syncLabel = {
      local: '设置仅保存在本机',
      // 同步时机改成「离开页面时」，所以改完设置后必须如实告诉用户「还没上云」，
      // 否则面板一直显示「已同步」会让人以为已经跨设备生效了。
      dirty: '改动已存本机，退出时同步',
      syncing: '正在同步…',
      synced: '设置已同步到账号',
      offline: '云端不可达，已存本机'
    }[syncState] || '';

    if (currentUser) {
      var name = escapeHtml(currentUser.name || '用户');
      var avatar = currentUser.avatar
        ? '<img class="heo-account-avatar" src="' + escapeHtml(currentUser.avatar) + '" alt="" referrerpolicy="no-referrer">'
        : '<span class="heo-account-avatar heo-account-avatar--text">' + escapeHtml(String(name).slice(0, 1)) + '</span>';
      box.innerHTML =
        '<div class="heo-account-user">' + avatar +
          '<div class="heo-account-meta"><b>' + name + '</b><span>' + escapeHtml(syncLabel) + '</span></div>' +
        '</div>' +
        '<button type="button" class="heo-btn-ghost" id="heo-logout">退出</button>';
      var out = document.getElementById('heo-logout');
      if (out) out.addEventListener('click', function () { api.logout(); });
    } else {
      box.innerHTML =
        '<div class="heo-account-user">' +
          '<span class="heo-account-avatar heo-account-avatar--text">Q</span>' +
          '<div class="heo-account-meta"><b>未登录</b><span>' + escapeHtml(syncLabel) + '</span></div>' +
        '</div>' +
        '<button type="button" class="heo-btn-primary" id="heo-login">登录 QuiID</button>';
      var btn = document.getElementById('heo-login');
      if (btn) btn.addEventListener('click', function () { api.login(); });
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 「音乐可视化」需要登录 QuiID 才可用。
   * 未登录时把这一行置灰、禁用 checkbox，并显示「需登录 QuiID 后可用」。
   *
   * 注意：这里**只改控件可用性，不改设置值**。用户之前的开关偏好原样保留在
   * state.visualizer 里，重新登录后立即恢复，不会因为登出一次就被重置成关闭。
   * 真正的「不启动绘制」判断在 main.js 的 applyVisualizer 里。
   */
  function renderVisualizerLock() {
    var input = document.querySelector('[data-setting="visualizer"]');
    if (!input) return;
    var row = input.closest ? input.closest('.heo-row') : null;
    var locked = !currentUser;
    input.disabled = locked;
    if (row) row.classList.toggle('is-locked', locked);
  }

  /** 把当前设置回填到面板控件上 */
  function renderControls() {
    var boxes = document.querySelectorAll('[data-setting]');
    Array.prototype.forEach.call(boxes, function (el) {
      var key = el.getAttribute('data-setting');
      if (!(key in DEFAULTS)) return;
      if (el.type === 'checkbox') {
        el.checked = !!state[key];
        // 同时同步无障碍状态与实际开关样式（CSS 用 :checked 驱动，这里只兜底类名）
        var wrap = el.closest ? el.closest('.heo-row') : null;
        if (wrap) wrap.classList.toggle('is-on', !!state[key]);
      }
    });
    // 分段控件（播放模式）
    var seg = document.querySelectorAll('[data-seg="order"] [data-value]');
    Array.prototype.forEach.call(seg, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-value') === state.order);
    });
  }

  /** 绑定面板上的所有交互（一次性） */
  function bindPanel() {
    // 开关类：任何 [data-setting] 的 checkbox
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute || !el.getAttribute('data-setting')) return;
      var key = el.getAttribute('data-setting');
      if (!(key in DEFAULTS)) return;
      api.set(key, el.type === 'checkbox' ? el.checked : el.value);
      var wrap = el.closest ? el.closest('.heo-row') : null;
      if (wrap) wrap.classList.toggle('is-on', !!el.checked);
    });

    // 分段控件
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-seg] [data-value]') : null;
      if (!b) return;
      var group = b.closest('[data-seg]');
      if (!group) return;
      var key = group.getAttribute('data-seg');
      if (!(key in DEFAULTS)) return;
      api.set(key, b.getAttribute('data-value'));
      renderControls();
    });

    // 打开 / 关闭面板
    var panel = document.getElementById('heo-settings-panel');
    var opener = document.getElementById('heo-settings-btn');
    if (opener && panel) {
      opener.addEventListener('click', function (ev) {
        ev.stopPropagation();
        togglePanel(!panel.classList.contains('is-open'));
      });
      var closer = document.getElementById('heo-settings-close');
      if (closer) closer.addEventListener('click', function () { togglePanel(false); });
      // 点击面板外部关闭（移动端友好）
      document.addEventListener('click', function (ev) {
        if (!panel.classList.contains('is-open')) return;
        if (panel.contains(ev.target)) return;
        if (opener.contains(ev.target)) return;
        togglePanel(false);
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') togglePanel(false);
      });
    }
  }

  function togglePanel(open) {
    var panel = document.getElementById('heo-settings-panel');
    var opener = document.getElementById('heo-settings-btn');
    if (!panel) return;
    panel.classList.toggle('is-open', !!open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (opener) opener.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderControls();
  }

  /* ============================================================
   *  对外 API
   * ============================================================ */
  var api = {
    DEFAULTS: DEFAULTS,

    all: function () {
      var out = {};
      for (var k in state) out[k] = state[k];
      return out;
    },

    get: function (key) { return state[key]; },

    set: function (key, value) {
      if (!(key in DEFAULTS)) return;
      var v = normalize(key, value);
      if (v === undefined) return;           // 非法值：保持原值，不做任何变更
      if (state[key] === v) return;          // 无变化不广播，避免无谓重绘
      state[key] = v;
      saveLocal();
      emit((function () { var o = {}; o[key] = v; return o; })());
      markDirty();                           // ★ 只打待同步标记，推送推迟到离开页面时
    },

    patch: function (obj) {
      var changed = {};
      var dirty = false;
      for (var k in obj) {
        if (!(k in DEFAULTS)) continue;
        var v = normalize(k, obj[k]);
        if (v === undefined) continue;       // 非法值跳过，保留该项原有设置
        if (state[k] !== v) { state[k] = v; changed[k] = v; dirty = true; }
      }
      if (!dirty) return;
      saveLocal();
      emit(changed);
      markDirty();                           // ★ 同上：不在这里发请求
    },

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    ready: function (fn) {
      if (typeof fn !== 'function') return;
      if (isReady) fn(state); else readyQueue.push(fn);
    },

    // ---- 账号 ----
    user: function () { return currentUser; },
    syncState: function () { return syncState; },
    /** 是否已登录 QuiID。音乐可视化等功能以此为准入门槛 */
    isLoggedIn: function () { return !!currentUser; },

    login: function () {
      loadSdk().then(function (SDK) {
        if (!SDK) { alert('QuiID 暂时不可用，请稍后再试'); return; }
        SDK.login();
      });
    },

    /** 退出登录：先补推一次设置，再清理本地、通知刷新 UI */
    logout: function () {
      var SDK = global.QuiID;
      // ★ 为什么登出也要推：同步时机已改成「只在离开时」，登出同样是一次离开；
      //   而且必须赶在 currentUser 被清空**之前**推 —— 清完就没身份了。
      //   这里用普通通道即可（页面还在，不需要 keepalive）。
      //   推失败也不阻塞登出，pending 会保留下来，下次登录时自动补推。
      var flush = (currentUser && SDK) ? pushToCloud() : Promise.resolve(false);
      return flush
        .catch(function () {})
        .then(function () {
          // ★ 必须 await：SDK 的清理可能是异步的，不等它做完就读存储会读到残留会话
          return Promise.resolve(SDK && SDK.logout ? SDK.logout() : null);
        })
        .catch(function () {})
        .then(function () {
          try { localStorage.removeItem('quiid_session'); } catch (e) {}
          currentUser = null;
          setSyncState('local');
          notifySessionChanged();
          // 通知其它持有登录态的组件（另起事件名，避免与 SDK 的变更事件形成自激循环）
          try {
            global.dispatchEvent(new CustomEvent('quiid:session-ended'));
          } catch (e) {}
        });
    },

    /** 手动推送一次（面板里不需要，留给控制台调试） */
    syncNow: function () {
      return currentUser ? pushToCloud() : Promise.resolve(false);
    },

    // 面板控制（供外部按需打开）
    open: function () { togglePanel(true); },
    close: function () { togglePanel(false); }
  };

  /* ------------------------------------------------------------
   *  启动
   * ---------------------------------------------------------- */
  state = loadLocal();

  function boot() {
    bindPanel();
    bindExitSync();        // ★ 离开页面时同步设置（本模块唯一的主动推送时机）
    renderControls();
    renderAccount();
    flushReady();          // 先让播放器用本地设置跑起来，不等网络
    initAccount();         // 再异步接账号与云同步
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.QuiMusicSettings = api;
})(window);
