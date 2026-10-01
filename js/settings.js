/* ============================================================
 *  settings.js — QuiMusic 设置面板 + QuiID 账号同步
 *  ------------------------------------------------------------
 *  职责边界（刻意分得很清，方便以后各自演进）：
 *    1) 定义有哪些设置项、默认值是什么、怎么做类型校正
 *    2) 本地持久化（localStorage）—— 打开页面立刻生效，不等网络
 *    3) 渲染设置面板的账号区，绑定全部开关/分段的交互
 *    4) 登录 QuiID 后把设置推到云端 / 从云端拉回，实现跨设备同步
 *
 *  本模块**不碰播放器**。它只负责“知道设置是什么”并广播变更，
 *  真正的应用逻辑在 main.js 里监听 quimusic:settings 事件完成。
 *
 *  对外接口：window.QuiMusicSettings
 *    all()            取全部设置的副本
 *    get(key)         取单项
 *    set(key, value)  改单项（自动持久化 + 广播 + 云同步）
 *    patch(obj)       批量改
 *    onChange(fn)     监听变更
 *    ready(fn)        设置就绪后回调（首次读盘完成）
 *    user()           当前 QuiID 用户（未登录为 null）
 *    login() / logout()
 *    syncState()      'local' | 'syncing' | 'synced' | 'offline'
 * ============================================================ */
(function (global) {
  'use strict';

  var STORE_KEY = 'quimusic_settings';

  // QuiID 侧登记的应用 id（见 QuiID worker.js 的 builtins）
  var QUIID_APP_ID = 'music';
  // SDK 地址：可被 config.js 的 quiidSdkUrl 覆盖
  var DEFAULT_SDK_URL = 'https://id.quicer.top/quiid.js';
  // 设置推送防抖：拖动音量时不要每动一下就打一次接口
  var PUSH_DEBOUNCE_MS = 900;

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
  var syncState = 'local';   // local | syncing | synced | offline
  var pushTimer = null;

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
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (s) {
        var parsed = JSON.parse(s);
        // 兼容两种格式：早期直接存设置，后来包了一层 {settings, updatedAt}
        raw = (parsed && parsed.settings) ? parsed.settings : parsed;
      }
    } catch (e) { /* 存储不可用或内容损坏 → 用默认值，不影响播放 */ }
    return sanitize(raw);
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        settings: state,
        updatedAt: Date.now()
      }));
    } catch (e) { /* 隐私模式/配额满：忽略，本次会话仍可用 */ }
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
          renderAccount();
          if (currentUser) pullFromCloud();
          else { setSyncState('local'); renderAccount(); }
        });

      // SDK 内部的登录态变化（如别处退出）也要跟着走
      SDK.onChange(function (sess) {
        var next = sess && sess.user ? sess.user : null;
        var was = currentUser ? currentUser.uid : null;
        var now = next ? next.uid : null;
        currentUser = next;
        if (now && now !== was) { renderAccount(); pullFromCloud(); }
        else if (!now && was) { renderAccount(); setSyncState('local'); }
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
          pushToCloud(true);
        }
      })
      .catch(function (e) {
        console.warn('[settings] 拉取云端设置失败', e);
        setSyncState('offline');
      });
  }

  /** 推送本地设置到云端（默认防抖，播种时立即） */
  function pushToCloud(immediate) {
    var SDK = global.QuiID;
    if (!SDK || !currentUser) return;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }

    function doPush() {
      setSyncState('syncing');
      var payload = {
        app_id: QUIID_APP_ID,
        data: { settings: state, updatedAt: Date.now() }
      };
      // 先 PUT，失败再降级 POST。
      // ★ 为什么要降级：PUT 会触发 CORS 预检，一旦服务端 Allow-Methods 里漏了 PUT，
      //   浏览器**直接阻断请求**（服务端零日志，控制台只有一句 CORS 报错），
      //   表现就是「云端不可达，已存本机」但登录一切正常 —— 极难排查。
      //   POST 是通行度更高的方法，通常必在 Allow-Methods 里；QuiID 侧两者语义一致。
      SDK.api('/api/prefs', { method: 'PUT', token: SDK.token(), body: payload })
        .catch(function (e) {
          console.warn('[settings] PUT 保存失败，改用 POST 重试', e);
          return SDK.api('/api/prefs', { method: 'POST', token: SDK.token(), body: payload });
        })
        .then(function () {
          setSyncState('synced');
        })
        .catch(function (e) {
          console.warn('[settings] 保存到云端失败', e);
          setSyncState('offline');
        });
    }

    if (immediate) doPush();
    else pushTimer = setTimeout(doPush, PUSH_DEBOUNCE_MS);
  }

  /* ============================================================
   *  设置面板渲染与交互
   * ============================================================ */

  /** 账号区：根据登录态渲染三种形态 */
  function renderAccount() {
    var box = document.getElementById('heo-account');
    if (!box) return;

    var syncLabel = {
      local: '设置仅保存在本机',
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
      pushToCloud();
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
      pushToCloud();
    },

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    ready: function (fn) {
      if (typeof fn !== 'function') return;
      if (isReady) fn(state); else readyQueue.push(fn);
    },

    // ---- 账号 ----
    user: function () { return currentUser; },
    syncState: function () { return syncState; },

    login: function () {
      loadSdk().then(function (SDK) {
        if (!SDK) { alert('QuiID 暂时不可用，请稍后再试'); return; }
        SDK.login();
      });
    },

    /** 退出登录：必须先把本地清理干净，再通知刷新 UI */
    logout: function () {
      // ★ 必须 await：SDK 的清理可能是异步的，不等它做完就读存储会读到残留会话
      var SDK = global.QuiID;
      Promise.resolve(SDK && SDK.logout ? SDK.logout() : null)
        .catch(function () {})
        .then(function () {
          try { localStorage.removeItem('quiid_session'); } catch (e) {}
          currentUser = null;
          setSyncState('local');
          renderAccount();
          renderControls();
          // 通知其它持有登录态的组件（另起事件名，避免与 SDK 的变更事件形成自激循环）
          try {
            global.dispatchEvent(new CustomEvent('quiid:session-ended'));
          } catch (e) {}
        });
    },

    /** 手动触发一次同步（面板里不需要，留给控制台调试） */
    syncNow: function () {
      if (currentUser) pushToCloud(true);
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
