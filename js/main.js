console.log("\n %c HeoMusic 开源静态音乐播放器 %c https://github.com/zhheo/HeoMusic \n", "color: #fadfa3; background: #030307; padding:5px 0;", "background: #fadfa3; padding:5px 0;")
var local = false;
var isScrolling = false; // 添加全局变量 isScrolling，默认为 false
var scrollTimer = null; // 添加定时器变量
var animationFrameId = null; // 添加变量用于跟踪动画帧ID

if (typeof userId === 'undefined') {
  var userId = "13908245149"; // 替换为实际的默认值
}
if (typeof userServer === 'undefined') {
  var userServer = "netease"; // 替换为实际的默认值
}
if (typeof userType === 'undefined') {
  var userType = "playlist"; // 替换为实际的默认值
}
if (typeof homeUrl === 'undefined') {
  var homeUrl = "https://quicer.top"; // 替换为你的主页地址
}

// 音乐馆「真实频谱」音频代理 Worker 地址（对应仓库内 music-worker.js）。
// 部署 Cloudflare Worker 后把地址填到下面；留空则回落到默认 meting-api（仅有程序动画频谱，声音正常）。
// 填值后：歌单请求与音频流都走该 Worker，Worker 为音频加上 Access-Control-Allow-Origin，
// 浏览器才能通过 Web Audio 的 AnalyserNode 读取真实频谱（否则跨域音频会被静音）。
if (typeof musicWorkerUrl === 'undefined') {
  var musicWorkerUrl = "https://musichall-visualization.worker.quicer.top"; // ← 在此填入 Worker 地址
}
if (musicWorkerUrl) {
  window.meting_api = musicWorkerUrl.replace(/\/+$/, '') + "/?server=:server&type=:type&id=:id&r=:r";
}

if (typeof remoteMusic !== 'undefined' && remoteMusic) {
  fetch(remoteMusic)
    .then(response => response.json())
    .then(data => {
      if (Array.isArray(data)) {
        localMusic = data;
      }
      loadMusicScript();
    })
    .catch(error => {
      console.error('Error fetching remoteMusic:', error);
      loadMusicScript();
    });
} else {
  loadMusicScript();
}

function loadMusicScript() {
  if (typeof localMusic === 'undefined' || !Array.isArray(localMusic) || localMusic.length === 0) {
    // 如果 localMusic 为空数组或未定义，加载 Meting2.min.js
    var script = document.createElement('script');
    script.src = './js/Meting.js';
    document.body.appendChild(script);
  } else {
    // 否则加载 localEngine.js
    var script = document.createElement('script');
    script.src = './js/localEngine.js';
    document.body.appendChild(script);
    local = true;
  }
}

// ============================================================
//  用户设置接入
//  ------------------------------------------------------------
//  设置的真身在 js/settings.js（面板交互、持久化、QuiID 云同步都在那边）。
//  这里只做两件事：读值、应用。settings.js 没加载时全部回落到默认值，
//  所以本文件单独拿出来也能跑，不会因为缺依赖而报错。
// ============================================================
var QS = window.QuiMusicSettings || null;

function quiSetting(key, fallback) {
  if (QS && typeof QS.get === 'function') {
    var v = QS.get(key);
    return (v === undefined) ? fallback : v;
  }
  return fallback;
}

/* ------------------------------------------------------------
 *  通用弹窗：目前只有「设备性能较差」这一处用，所以做成通用小工具，
 *  以后要加别的提示直接复用（DOM 见 index.html 的 #qui-modal）。
 * ---------------------------------------------------------- */
function showQuiModal(opts) {
  var box = document.getElementById('qui-modal');
  if (!box) return;
  var textEl = document.getElementById('qui-modal-text');
  var okBtn = document.getElementById('qui-modal-ok');
  var cancelBtn = document.getElementById('qui-modal-cancel');
  if (textEl) textEl.textContent = opts.text || '';
  if (okBtn) okBtn.textContent = opts.okText || '确定';

  // 每次打开都重新绑定（用 onclick 覆盖，避免多次调用叠加监听）
  if (okBtn) okBtn.onclick = function () { hideQuiModal(); if (opts.onOk) opts.onOk(); };
  if (cancelBtn) {
    if (opts.cancelText) {
      cancelBtn.textContent = opts.cancelText;
      cancelBtn.style.display = '';
      cancelBtn.onclick = function () { hideQuiModal(); if (opts.onCancel) opts.onCancel(); };
    } else {
      cancelBtn.style.display = 'none';
    }
  }
  box.classList.add('is-open');
  box.setAttribute('aria-hidden', 'false');
  // 点遮罩空白处等同「取消」
  box.onclick = function (ev) {
    if (ev.target === box) { hideQuiModal(); if (opts.onCancel) opts.onCancel(); }
  };
}

function hideQuiModal() {
  var box = document.getElementById('qui-modal');
  if (!box) return;
  box.classList.remove('is-open');
  box.setAttribute('aria-hidden', 'true');
}

/* ------------------------------------------------------------
 *  轻提示（toast）
 *  ------------------------------------------------------------
 *  和 showQuiModal 的分工：
 *    · modal  —— 需要用户点一下才能继续的（如「要不要关掉可视化」）
 *    · toast  —— 只是告知，不打断操作的（如「这首只能试听 30 秒」）
 *  连续调用只替换文案并重新计时，不会叠出好几个气泡。
 * ---------------------------------------------------------- */
var quiToastTimer = null;
function showQuiToast(text, duration) {
  var el = document.getElementById('qui-toast');
  if (!el) return;
  el.textContent = text || '';
  el.classList.add('is-open');
  if (quiToastTimer) clearTimeout(quiToastTimer);
  quiToastTimer = setTimeout(function () {
    quiToastTimer = null;
    el.classList.remove('is-open');
  }, duration || 3600);
}

/**
 * 「设备性能较差」提示。文案固定，按钮只做两件事：
 *   · 关闭可视化 —— 直接写设置（走 settings.js，会一并本地持久化 + 云同步）
 *   · 继续使用   —— 本次会话不再提示（sessionStorage 标记在调用方打）
 */
function showPerfModal() {
  showQuiModal({
    text: '您的设备性能较差，建议关闭音乐可视化',
    okText: '关闭可视化',
    cancelText: '继续使用',
    onOk: function () {
      if (QS && typeof QS.set === 'function') QS.set('visualizer', false);
    }
  });
}

// 音量：开启「音量记忆」时沿用上次保存的值，否则用固定默认值
var volume = quiSetting('volume', 0.8);

// 「自动播放」只在播放器首次就绪时尝试一次。
// 之后用户若手动暂停，不应该因为改了个设置又把它自动播起来。
var autoplayTried = false;

// 获取地址栏参数
// 创建URLSearchParams对象并传入URL中的查询字符串
const params = new URLSearchParams(window.location.search);

var heo = {
  // 处理滚动和触摸事件的通用方法
  handleScrollOrTouch: function(event, isTouchEvent) {
    // 检查事件的目标元素是否在相关区域内部
    let targetElement = event.target;
    let isInTargetArea = false;
    
    // 向上遍历DOM树，检查是否在目标区域内
    while (targetElement && targetElement !== document) {
      if (targetElement.classList) {
        if (isTouchEvent) {
          // 触摸事件检查 aplayer-body 或 aplayer-lrc
          if (targetElement.classList.contains('aplayer-body') || 
              targetElement.classList.contains('aplayer-lrc')) {
            isInTargetArea = true;
            break;
          }
        } else {
          // 鼠标滚轮事件只检查 aplayer-body
          if (targetElement.classList.contains('aplayer-body')) {
            isInTargetArea = true;
            break;
          }
        }
      }
      targetElement = targetElement.parentNode;
    }
    
    // 只有当在目标区域内时才改变 isScrolling
    if (isInTargetArea) {
      // 取消任何正在进行的动画
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      
      // 设置isScrolling为true
      isScrolling = true;
      
      // 清除之前的定时器
      if(scrollTimer !== null) {
        clearTimeout(scrollTimer);
      }
      
      // 设置新的定时器，恢复isScrolling为false
      // 触摸事件给予更长的时间
      const timeoutDuration = isTouchEvent ? 4500 : 4000;
      scrollTimer = setTimeout(function() {
        isScrolling = false;
        heo.scrollLyric();
      }, timeoutDuration);
    }
  },
  
  // 初始化滚动和触摸事件
  initScrollEvents: function() {
    // 监听鼠标滚轮事件
    document.addEventListener('wheel', (event) => {
      this.handleScrollOrTouch(event, false);
    }, { passive: true });
    
    // 监听触摸滑动事件
    document.addEventListener('touchmove', (event) => {
      this.handleScrollOrTouch(event, true);
    }, { passive: true });
  },

  scrollLyric: function () {
    // 当 isScrolling 为 true 时，跳过执行
    if (isScrolling) {
      return;
    }
    
    const lrcContent = document.querySelector('.aplayer-lrc');
    const currentLyric = document.querySelector('.aplayer-lrc-current');

    if (lrcContent && currentLyric) {
      let startScrollTop = lrcContent.scrollTop;
      let targetScrollTop = currentLyric.offsetTop - (window.innerHeight - 150) * 0.3; // 目标位置在30%的dvh位置
      let distance = targetScrollTop - startScrollTop;
      let duration = 600; // 缩短动画时间以提高流畅度
      let startTime = null;

      function easeOutQuad(t) {
        return t * (2 - t);
      }

      function animateScroll(currentTime) {
        // 如果用户正在手动滚动，停止动画
        if (isScrolling) {
          animationFrameId = null;
          return;
        }
        
        if (startTime === null) startTime = currentTime;
        let timeElapsed = currentTime - startTime;
        let progress = Math.min(timeElapsed / duration, 1);
        let easeProgress = window.innerWidth < 768 ? progress : easeOutQuad(progress);
        lrcContent.scrollTop = startScrollTop + (distance * easeProgress);
        
        if (timeElapsed < duration) {
          animationFrameId = requestAnimationFrame(animateScroll);
        } else {
          animationFrameId = null;
        }
      }

      // 取消任何正在进行的动画
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      
      animationFrameId = requestAnimationFrame(animateScroll);
    }
  },

  getCustomPlayList: function () {
    const heoMusicPage = document.getElementById("heoMusic-page");
    const playlistType = params.get("type") || "playlist";

    if (params.get("id") && params.get("server")) {
      console.log("获取到自定义内容")
      var id = params.get("id")
      var server = params.get("server")
      heoMusicPage.innerHTML = `<meting-js id="${id}" server="${server}" type="${playlistType}" mutex="true" preload="auto" order="random"></meting-js>`;
    } else {
      console.log("无自定义内容")
      heoMusicPage.innerHTML = `<meting-js id="${userId}" server="${userServer}" type="${userType}" mutex="true" preload="auto" order="random"></meting-js>`;
    }
  },

  bindEvents: function () {
    var e = this;
    // 添加歌词点击件
    if (this.lrc) {
      this.template.lrc.addEventListener('click', function (event) {
        // 确保点击的是歌词 p 元素
        var target = event.target;
        if (target.tagName.toLowerCase() === 'p') {
          // 获取所有歌词元素
          var lyrics = e.template.lrc.getElementsByTagName('p');
          // 找到被点击歌词的索引
          for (var i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === target) {
              // 获取对应时间并跳转
              if (e.lrc.current[i]) {
                var time = e.lrc.current[i][0];
                e.seek(time);
                if (e.paused) {
                  e.play();
                }
              }
              break;
            }
          }
        }
      });
    }
  },
  // 添加新方法处理歌词点击
  addLyricClickEvent: function () {
    const lrcContent = document.querySelector('.aplayer-lrc-contents');

    if (lrcContent) {
      lrcContent.addEventListener('click', function (event) {
        if (event.target.tagName.toLowerCase() === 'p') {
          const lyrics = lrcContent.getElementsByTagName('p');
          for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === event.target) {
              // 获取当前播放器实例
              const player = ap;
              // 使用播放器内部的歌词数据
              if (player.lrc.current[i]) {
                const time = player.lrc.current[i][0];
                player.seek(time);
                // 点击歌词后不再等待4s，立即跳转
                isScrolling = false;
                clearTimeout(scrollTimer);
                // 如果当前是暂停状态,则恢复播放
                if (player.paused) {
                  player.play();
                }
              }
              event.stopPropagation(); // 阻止事件冒泡
              break;
            }
          }
        }
      });
    }
  },
  setMediaMetadata: function (aplayerObj, isSongPlaying) {
    const audio = aplayerObj.list.audios[aplayerObj.list.index]
    const coverUrl = audio.cover || './img/icon.webp';
    /* ★ 2026-10-17 修复崩溃：没有歌词的歌曲（纯音乐、或 lrc 还没解析出来）下
     *   `.aplayer-lrc-current` 节点的 textContent 是空的，APlayer 干脆不渲染这个节点，
     *   原来这里直接 .textContent 会抛
     *     TypeError: Cannot read properties of null (reading 'textContent')
     *   而本函数被 timeupdate（每 250ms 一次）+ loadeddata + play/pause 同时调用，
     *   于是**一次播放会连抛几百条异常**，并且顺手把 Media Session 元数据更新整条打断。
     *   取不到就当空字符串处理。 */
    const lrcCurrentEl = document.getElementById("heoMusic-page").querySelector(".aplayer-lrc-current");
    const currentLrcContent = lrcCurrentEl ? lrcCurrentEl.textContent : '';
    let songName, songArtist;

    if ('mediaSession' in navigator) {
      if (isSongPlaying && currentLrcContent) {
        songName = currentLrcContent;
        songArtist = `${audio.artist} / ${audio.name}`;
      } else {
        songName = audio.name;
        songArtist = audio.artist;
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: songName,
        artist: songArtist,
        album: audio.album,
        artwork: [
          { src: coverUrl, sizes: '96x96', type: 'image/jpeg' },
          { src: coverUrl, sizes: '128x128', type: 'image/jpeg' },
          { src: coverUrl, sizes: '192x192', type: 'image/jpeg' },
          { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: coverUrl, sizes: '384x384', type: 'image/jpeg' },
          { src: coverUrl, sizes: '512x512', type: 'image/jpeg' }
        ]
      });
    } else {
      console.log('当前浏览器不支持 Media Session API');
      document.title = `${audio.name} - ${audio.artist}`;
    }
  },
  // 响应 MediaSession 标准媒体交互
  setupMediaSessionHandlers: function (aplayer) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        aplayer.play();
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        aplayer.pause();
      });

      // 移除快进快退按钮
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);

      // 设置上一曲下一曲按钮
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        aplayer.skipBack();
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        aplayer.skipForward();
      });

      // 响应进度条拖动
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.fastSeek && 'fastSeek' in aplayer.audio) {
          aplayer.audio.fastSeek(details.seekTime);
        } else {
          aplayer.audio.currentTime = details.seekTime;
        }
      });

      // 更新 Media Session 元数据
      aplayer.on('loadeddata', () => {
        heo.setMediaMetadata(aplayer, false);
      });

      // 更新播放状态
      aplayer.on('play', () => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
          heo.setMediaMetadata(aplayer, true);
        }
      });

      aplayer.on('pause', () => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
          heo.setMediaMetadata(aplayer, false);
        }
      });

      // 监听时间更新事件
      aplayer.on('timeupdate', () => {
        heo.setMediaMetadata(aplayer, true);
      });
    }
  },
  updateThemeColorWithImage(img) {
    if (local) {
      const updateThemeColor = (colorThief) => {
        const dominantColor = colorThief.getColor(img);
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
          // 叠加rgba(0,0,0,0.4)的效果
          const r = Math.round(dominantColor[0] * 0.6); // 原色 * 0.6 实现叠加黑色透明度0.4的效果
          const g = Math.round(dominantColor[1] * 0.6);
          const b = Math.round(dominantColor[2] * 0.6);
          metaThemeColor.setAttribute('content', `rgb(${r},${g},${b})`);
        }
      };

      if (typeof ColorThief === 'undefined') {
        const script = document.createElement('script');
        script.src = './js/color-thief.min.js';
        script.onload = () => updateThemeColor(new ColorThief());
        document.body.appendChild(script);
      } else {
        updateThemeColor(new ColorThief());
      }
    }

  },
  
  // 新增方法：将歌词滚动到顶部
  scrollLyricToTop: function() {
    const lrcContent = document.querySelector('.aplayer-lrc');
    if (lrcContent) {
      // 使用平滑滚动效果，但不过于缓慢
      lrcContent.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    }
  },
  
  // 新增方法：在右上角注入「前往主页」按钮
  addHomeButton: function() {
    if (document.querySelector('.heo-home-btn')) return; // 防止重复注入
    if (typeof homeUrl === 'undefined' || !homeUrl) return;
    const btn = document.createElement('a');
    btn.className = 'heo-home-btn';
    btn.href = homeUrl;
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.setAttribute('aria-label', '前往我的主页');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z"/></svg><span>主页</span>';
    // 优先注入到右上角工具条（与设置按钮同排，由 flex 自动排列，不会互相重叠）；
    // 没有工具条时回落到 body，保持本函数单独可用。
    const topbar = document.getElementById('heo-topbar');
    (topbar || document.body).appendChild(btn);
  },

  /* ------------------------------------------------------------
   *  换歌单：平台 / 类型 / ID → 带参数跳转
   *  ------------------------------------------------------------
   *  「跳转」就是重新加载页面并带上 ?server=&type=&id=，
   *  getCustomPlayList() 会读这三个参数（见本文件上文），
   *  所以这里不需要任何热切换逻辑 —— 刷新一次最省事、也不会留下半旧半新的状态。
   * ---------------------------------------------------------- */
  initJumpPanel: function () {
    const btn = document.getElementById('heo-jump-btn');
    const panel = document.getElementById('qui-jump-panel');
    if (!btn || !panel) return;

    const inputId = document.getElementById('qui-jump-id');
    const msg = document.getElementById('qui-jump-msg');
    const goBtn = document.getElementById('qui-jump-go');
    const resetBtn = document.getElementById('qui-jump-reset');
    const closeBtn = document.getElementById('qui-jump-close');
    const settingsBtn = document.getElementById('heo-settings-btn');
    const settingsPanel = document.getElementById('heo-settings-panel');

    /* 已经建好的自绘下拉实例。用途有两个：
     *   ① 同一时刻只让一个下拉展开（都展开会叠在一起）
     *   ② 面板收起时把它们一起收掉，免得下次打开还是展开态 */
    const openSelects = [];

    /* ---- 自绘下拉 ----
     * 为什么不用原生 <select>：展开后的选项列表由操作系统绘制，CSS 管不到
     * （Windows 上是系统白底弹层），而本站控件是深色底 + 近白色字 ——
     * 于是「白底白字看不见」，圆角/内边距/深色阴影也无从谈起。
     *
     * 值的存放位置：根节点 .qui-select 的 data-value。
     * 对外接口刻意做成 getValue() / setValue(v) / close()，
     * 与原来 select.value 的读写习惯一一对应，替换处只改调用形式、不改逻辑。 */
    function makeSelect(root) {
      if (!root) return null;
      const btn = root.querySelector('.qui-select-btn');
      const list = root.querySelector('.qui-select-list');
      const valueEl = root.querySelector('.qui-select-value');
      if (!btn || !list || !valueEl) return null;

      const items = Array.prototype.slice.call(list.querySelectorAll('.qui-select-item'));
      let active = 0;   // 键盘高亮位置（不是「已选中」，已选中用 aria-selected 表示）

      function labelOf(v) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].getAttribute('data-value') === v) return items[i].textContent;
        }
        return '';
      }

      function getValue() {
        const v = root.getAttribute('data-value');
        if (v && labelOf(v)) return v;
        return items.length ? items[0].getAttribute('data-value') : '';
      }

      /* 写入值。未知值直接忽略 —— 宁可不改，也不要让按钮文字变成一片空白。 */
      function setValue(v) {
        if (!v || !labelOf(v)) return false;
        root.setAttribute('data-value', v);
        valueEl.textContent = labelOf(v);
        items.forEach(function (it) {
          it.setAttribute('aria-selected', it.getAttribute('data-value') === v ? 'true' : 'false');
        });
        return true;
      }

      function isOpen() { return root.classList.contains('is-open'); }

      function highlight(i) {
        if (!items.length) return;
        const n = items.length;
        active = ((i % n) + n) % n;   // 负数也能正确回绕
        items.forEach(function (it, k) { it.classList.toggle('is-active', k === active); });
        const el = items[active];
        if (el && el.scrollIntoView) {
          try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
        }
      }

      function open() {
        if (isOpen()) return;
        openSelects.forEach(function (o) { if (o && o !== api) o.close(); });
        root.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        let cur = 0;
        for (let i = 0; i < items.length; i++) {
          if (items[i].getAttribute('data-value') === getValue()) cur = i;
        }
        highlight(cur);
      }

      function close(focusBack) {
        if (!isOpen()) {
          if (focusBack) { try { btn.focus(); } catch (e) {} }
          return;
        }
        root.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        items.forEach(function (it) { it.classList.remove('is-active'); });
        if (focusBack) { try { btn.focus(); } catch (e) {} }
      }

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (isOpen()) close(false); else open();
      });

      list.addEventListener('click', function (e) {
        const it = e.target && e.target.closest ? e.target.closest('.qui-select-item') : null;
        if (!it) return;
        e.stopPropagation();
        setValue(it.getAttribute('data-value'));
        close(true);
      });

      /* 键盘：↑↓ 移动、Home/End 首尾、Enter/Space 选中、Esc 收起、Tab 收起。
       * ★★ 本页把 **空格 / ←→ / ↑↓** 注册成了全局快捷键（播放暂停、切歌、音量），
       *    所以除了「下拉没展开时的 Esc」，其余按键一律 stopPropagation 掉 ——
       *    否则在下拉里按 ↑↓ 会顺手把音量改了。 */
      function onKeyDown(e) {
        const k = e.key;
        if (k === 'Escape') {
          if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(true); }
          return;   // 没展开时把 Esc 留给外层面板
        }
        e.stopPropagation();
        if (!isOpen()) {
          if (k === 'Enter' || k === ' ' || k === 'Spacebar' ||
              k === 'ArrowDown' || k === 'ArrowUp') {
            e.preventDefault();
            open();
            if (k === 'ArrowUp') highlight(active - 1);
          }
          return;
        }
        if (k === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
        else if (k === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
        else if (k === 'Home') { e.preventDefault(); highlight(0); }
        else if (k === 'End') { e.preventDefault(); highlight(items.length - 1); }
        else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          e.preventDefault();
          const it = items[active];
          if (it) setValue(it.getAttribute('data-value'));
          close(true);
        } else if (k === 'Tab') { close(false); }
      }
      btn.addEventListener('keydown', onKeyDown);
      list.addEventListener('keydown', onKeyDown);
      // Space 在部分浏览器还会走 keyup / keypress，一并挡住，别漏给全局快捷键
      ['keyup', 'keypress'].forEach(function (ev) {
        root.addEventListener(ev, function (e) { e.stopPropagation(); });
      });

      /* 点下拉外面收起。
       * ★ 同样必须用**捕获阶段**（第三个参数 true），原因见本文件末尾那段说明：
       *   冒泡链上有地方会 stopPropagation，默认冒泡的监听收不到事件。 */
      document.addEventListener('click', function (e) {
        if (!isOpen()) return;
        if (root.contains(e.target)) return;
        close(false);
      }, true);

      const api = {
        root: root,
        getValue: getValue,
        setValue: setValue,
        open: open,
        close: close
      };
      openSelects.push(api);
      return api;
    }

    const uiServer = makeSelect(document.getElementById('qui-jump-server'));
    const uiType = makeSelect(document.getElementById('qui-jump-type'));

    function setMsg(text, isError) {
      if (!msg) return;
      msg.textContent = text || '';
      msg.classList.toggle('is-error', !!isError);
    }

    function setOpen(open) {
      panel.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) setMsg('');
      /* 收起面板时把展开着的下拉也收掉。
       * 不这么做的话，下次打开面板会看到一个「上次没关的下拉」浮在外面，
       * 而且它的 aria-expanded 还是 true。 */
      else openSelects.forEach(function (o) { if (o) o.close(false); });
    }

    /* 把「用户填的东西」解析成 { server?, type?, id }。
     * 支持三种输入：
     *   ① 纯 ID          —— 1234567（网易云） / 0039MnYb0qxYhV（QQ 音乐单曲）
     *   ② 官方页面链接   —— 自动判断平台与类型，并顺手把下拉框也改对
     *   ③ 认不出来的文本 —— 返回 null，由上层提示
     * 为什么要支持链接：用户拿到歌单最自然的方式是「分享 → 复制链接」，
     * 逼他去链接里手工抠数字既容易错，也没必要。
     * 返回 null 时上层会保留用户自己选的平台/类型，所以这两个字段是可选的。 */
    function pickByPath(path, server, qid) {
      const out = { server: server };
      let m;
      if ((m = /\/(?:playlist|special|gedan)\/(\d+)/i.exec(path))) { out.type = 'playlist'; out.id = m[1]; }
      else if ((m = /\/(?:song|music|play|songDetail)\/([A-Za-z0-9]+)/i.exec(path))) { out.type = 'song'; out.id = m[1]; }
      else if ((m = /\/album(?:Detail)?\/(\d+)/i.exec(path))) { out.type = 'album'; out.id = m[1]; }
      else if ((m = /\/(?:singer|artist)\/(\d+)/i.exec(path))) { out.type = 'artist'; out.id = m[1]; }
      else if (qid) out.id = qid;
      return out.id ? out : null;
    }

    function parseRef(raw) {
      const s = String(raw || '').trim();
      if (!s) return null;

      // ① 纯 ID。网易云/酷狗等是纯数字；QQ 音乐的 id 是字母数字混排（如 0039MnYb0qxYhV）
      if (/^\d+$/.test(s)) return { id: s };
      if (/^[A-Za-z0-9]{6,}$/.test(s)) return { id: s };

      // ② 链接
      let u;
      try { u = new URL(s, location.href); } catch (e) { return null; }
      const host = u.hostname || '';
      const path = u.pathname || '';
      /* 网易云分享出来的是 hash 路由：music.163.com/#/playlist?id=xxx —— 
         `#/playlist?id=xxx` 整段都在 u.hash 里，pathname 只有 `/`，
         searchParams 更是空的。不把 hash 摊平，这类最常见的链接就会全部识别失败。 */
      const hash = u.hash || '';
      const hashQuery = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?')) : '';
      const fullPath = path + hash.split('?')[0];

      function pickParam(p) {
        const v = p.get('id') || p.get('playlistId') || p.get('songId') || p.get('albumId') || '';
        return v;
      }
      let qid = pickParam(u.searchParams);
      if (!qid && hashQuery) {
        try { qid = pickParam(new URLSearchParams(hashQuery)); } catch (e) {}
      }

      if (/music\.163\.com$/i.test(host)) {
        const out = { server: 'netease' };
        if (/\/discover\/toplist|\/playlist/i.test(fullPath) || u.searchParams.has('playlist')) out.type = 'playlist';
        else if (/\/song/i.test(fullPath)) out.type = 'song';
        else if (/\/album/i.test(fullPath)) out.type = 'album';
        else if (/\/artist/i.test(fullPath)) out.type = 'artist';
        if (qid) { out.id = qid; return out; }
        return null;
      }

      if (/y\.qq\.com$/i.test(host)) {
        const out = { server: 'tencent' };
        let m;
        if ((m = /\/playlist\/(\w+)/.exec(fullPath))) { out.type = 'playlist'; out.id = m[1]; }
        else if ((m = /\/songDetail\/(\w+)/.exec(fullPath)) || (m = /\/song\/(\w+)/.exec(fullPath))) { out.type = 'song'; out.id = m[1]; }
        else if ((m = /\/albumDetail\/(\w+)/.exec(fullPath)) || (m = /\/album\/(\w+)/.exec(fullPath))) { out.type = 'album'; out.id = m[1]; }
        else if ((m = /\/singer\/(\w+)/.exec(fullPath))) { out.type = 'artist'; out.id = m[1]; }
        else if (qid) out.id = qid;
        return out.id ? out : null;
      }

      if (/kugou\.com$/i.test(host)) return pickByPath(fullPath, 'kugou', qid);
      if (/kuwo\.cn$/i.test(host)) return pickByPath(fullPath, 'kuwo', qid);
      if (/music\.baidu\.com$/i.test(host)) return pickByPath(fullPath, 'baidu', qid);

      // ③ 认不出域名：只要有 id 参数就当 ID 用，平台/类型沿用下拉框
      if (qid) return { id: qid };
      const tail = /\/(\d{4,})(?:[\/?#]|$)/.exec(u.href);
      if (tail) return { id: tail[1] };
      return null;
    }

    function submit() {
      const parsed = parseRef(inputId ? inputId.value : '');
      if (!parsed || !parsed.id) {
        setMsg('没认出这个 ID 或链接，检查一下再试', true);
        if (inputId) inputId.focus();
        return;
      }
      // 链接里带了平台/类型就以链接为准，并同步回下拉框 ——
      // 用户看到的和真正跳过去的一致，才不会觉得「明明选了网易云却跳到别处」
      const server = parsed.server || (uiServer ? uiServer.getValue() : 'netease');
      const type = parsed.type || (uiType ? uiType.getValue() : 'playlist');

      if (uiServer) uiServer.setValue(server);
      if (uiType) uiType.setValue(type);
      if (inputId) inputId.value = parsed.id;

      location.href = location.pathname +
        '?server=' + encodeURIComponent(server) +
        '&type=' + encodeURIComponent(type) +
        '&id=' + encodeURIComponent(parsed.id);
    }

    // 打开面板时把**当前正在放的那个歌单**回填进去，用户一眼能看到自己在哪。
    // 没带 URL 参数时回落到 config.js / main.js 顶部定义的默认值，
    // 否则默认歌单进来 ID 是空的，看起来像「没读到任何东西」。
    (function prefill() {
      const curServer = params.get('server') || (typeof userServer !== 'undefined' ? userServer : '');
      const curType = params.get('type') || (typeof userType !== 'undefined' ? userType : '');
      const curId = params.get('id') || (typeof userId !== 'undefined' ? userId : '');
      if (curServer && uiServer) uiServer.setValue(curServer);
      if (curType && uiType) uiType.setValue(curType);
      if (curId && inputId) inputId.value = curId;
    })();

    // 把解析器挂到 heo 上：控制台里能直接 heo._parseRef('链接') 验证规则，
    // 自动化测试也用它单测 —— 不影响任何正常逻辑。
    heo._parseRef = parseRef;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const next = !panel.classList.contains('is-open');
      // 两个面板都定位在右上角，同时开会叠成一团：开这个就先关那个。
      // 用 click() 关设置面板而不是直接删类 —— 面板的开合状态归 settings.js 管，
      // 绕过它改 DOM 会让它的 aria / 动画状态和实际不一致。
      if (next && settingsBtn && settingsPanel && settingsPanel.classList.contains('is-open')) {
        settingsBtn.click();
      }
      setOpen(next);
      if (next && inputId) setTimeout(function () { inputId.focus(); }, 90);
    });

    // 打开设置面板时把本面板收掉（同理，避免重叠）
    if (settingsBtn) settingsBtn.addEventListener('click', function () { setOpen(false); });

    if (closeBtn) closeBtn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false); });
    if (goBtn) goBtn.addEventListener('click', function (e) { e.stopPropagation(); submit(); });
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        location.href = location.pathname;   // 丢掉全部查询参数 = 回到默认歌单
      });
    }

    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    /* ★ 空格 / 方向键是本页的全局快捷键（播放暂停、切歌、音量），
     *  在输入框和下拉里必须把它们挡住 —— 否则在 ID 框里按空格会打出空白
     *  的同时把歌切了。
     *  下拉（.qui-select）的 keydown 已经在 makeSelect 里按按键逐个处理并
     *  stopPropagation 了（那里还要负责移动高亮，不能只做拦截），
     *  所以这里只补 keyup / keypress 这一层，避免有浏览器在 keyup 阶段
     *  又让按键漏到全局。 */
    [uiServer && uiServer.root, uiType && uiType.root].forEach(function (el) {
      if (!el) return;
      ['keyup', 'keypress'].forEach(function (ev) {
        el.addEventListener(ev, function (e) { e.stopPropagation(); });
      });
    });
    if (inputId) {
      ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
        inputId.addEventListener(ev, function (e) { e.stopPropagation(); });
      });
      inputId.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    }

    /* 点面板外面收起。
     * ★ 必须用**捕获阶段**（第三个参数 true），不能用默认冒泡。
     *   本页有多处会在冒泡链上 stopPropagation —— 最典型的是歌词行：
     *   addLyricClickEvent() 里点到 <p> 会 stopPropagation（为了「点歌词跳进度」不误触别的），
     *   冒泡被它截断后这个 document 监听根本收不到事件，
     *   表现就是「点歌词那一块，面板不关」。捕获阶段先于目标阶段执行，截不断。 */
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('is-open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
    });
  },

  /**
   * 把「显示 + 播放」类设置应用到播放器实例。
   * 面板里任何一项变化都会重新走一遍这里，所以每个分支都写成幂等的 ——
   * 重复执行不会产生副作用（不会重复播放、不会叠加监听）。
   */
  applyPlayerSettings: function (pl) {
    pl = pl || (typeof ap !== 'undefined' && ap ? ap : null);
    if (!pl) return;

    // ① 歌词面板：复用 APlayer 自带的 aplayer-lrc-hide 类
    //    ★★★ 2026-10-01 修复「设置里关掉歌词，歌词却照常显示」：
    //    这个类以前加在了 `.aplayer` 上，但 APlayer.css 的规则是
    //        .aplayer .aplayer-lrc.aplayer-lrc-hide { display: none }
    //    —— 类必须加在 **`.aplayer-lrc` 元素本身**上。加错层级不会报任何错，
    //    只是选择器永远匹配不上，表现就是「开关点了没反应」，极其隐蔽。
    //    APlayer 自己的 ap.lrc.hide() 也是往 lrcWrap（即 .aplayer-lrc）上加这个类。
    try {
      const wantLyrics = quiSetting('lyrics', true);
      const lrcEl = document.querySelector('#heoMusic-page .aplayer-lrc');
      if (lrcEl) lrcEl.classList.toggle('aplayer-lrc-hide', !wantLyrics);
      // 同时给页面根节点打标记：CSS 靠它把「没有歌词时」的其余内容居中
      const page = document.getElementById('heoMusic-page');
      if (page) page.classList.toggle('qui-no-lyrics', !wantLyrics);
      // 清掉旧实现可能残留在 .aplayer 上的同名类，避免与新标记互相干扰
      const root = document.querySelector('.aplayer');
      if (root) root.classList.remove('aplayer-lrc-hide');
    } catch (e) {}

    // ② 音量：第二个参数 persist 固定传 false —— 记忆统一交给本项目的设置系统，
    //    不让 APlayer 自己的 localStorage 与 QuiID 云同步两套数据打架。
    try {
      if (quiSetting('volumeMemory', true)) {
        pl.volume(volume, false);
      } else {
        volume = 0.8;
        try { localStorage.removeItem('metingjs'); } catch (e) {}   // 清掉 APlayer 存的旧音量
        pl.volume(volume, false);
      }
    } catch (e) {}

    // ③ 播放模式：APlayer 在切歌时实时读 options.order，所以运行时改这个值就能生效
    try {
      pl.options.order = quiSetting('order', 'random');
    } catch (e) {}

    // ④ 自动播放：只在首次应用时尝试一次。浏览器普遍要求先有用户交互，
    //    被拒绝属正常现象，静默忽略即可（不弹错、不重试）。
    if (!autoplayTried) {
      autoplayTried = true;
      if (quiSetting('autoplay', false)) {
        try {
          const p = pl.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) {}
      }
    }
  },

  // 音乐可视化（Web Audio 频谱；跨域音频无数据时自动降级为程序动画）
  // 2026-10-01 变更：
  //   · 只保留**底部**一条频谱（顶部那条已移除）
  //   · **必须登录 QuiID** 才会启动
  //   · 自动检测帧率，卡顿时弹窗建议关闭
  initVisualizer: function() {
    const page = document.getElementById('heoMusic-page');
    const canvas = document.getElementById('heo-visualizer');   // 唯一的频谱画布（页面底部）
    if (!canvas) return;
    // 画布移入 #heoMusic-page，使其与模糊背景同一层叠上下文（显示在背景之上、不挡控件）
    if (page && canvas.parentElement !== page) page.insertBefore(canvas, page.firstChild);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // 专辑封面背景层：显示当前歌曲封面（纯背景图，无需 CORS，跨域也能显示），适度模糊
    let coverBg = document.getElementById('heo-cover-bg');
    if (!coverBg) {
      coverBg = document.createElement('div');
      coverBg.id = 'heo-cover-bg';
      document.body.appendChild(coverBg);
    }
    function applyCoverBackground() {
      // 「封面背景」开关关闭时撤下背景；不清空 backgroundImage，
      // 这样重新打开时无需重新加载图片，立即就能显示。
      if (!quiSetting('coverBg', true)) {
        coverBg.classList.remove('show');
        return;
      }
      const cover = getCoverUrl();
      if (!cover) return;
      coverBg.style.backgroundImage = 'url("' + cover + '")';
      coverBg.classList.add('show');
    }
    let audioCtx = null, analyser = null, source = null, dataArray = null;
    let synthetic = false, zeroCount = 0, nonZeroCount = 0, player = null, attached = false;

    // 专辑封面取色：默认兜底色（柔紫），拿到封面并解析成功后替换为专辑主色
    let coverColor = null;        // {r,g,b}
    let coverColorUrl = null;     // 已取色的封面地址，避免重复计算

    function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }
    function lighten(c, amt) {
      return {
        r: Math.round(c.r + (255 - c.r) * amt),
        g: Math.round(c.g + (255 - c.g) * amt),
        b: Math.round(c.b + (255 - c.b) * amt),
      };
    }

    // 读取当前播放歌曲的封面地址（meting-api 返回字段为 pic）
    function getCoverUrl() {
      try {
        const idx = ap.list.index;
        const cur = ap.list.audios && ap.list.audios[idx];
        return cur && (cur.pic || cur.cover);
      } catch (e) { return null; }
    }
    // 从封面提取主色。
    // 省请求策略：优先「直连」封面原地址 —— 图床自带 CORS 头时可直接读像素，不必经过 Worker 图片代理，
    // 每首歌省下 1 次 Worker 请求；直连失败（图床无 CORS 导致 canvas taint，或图片加载出错）时，
    // 自动回落到 Worker 图片代理重试一次，功能不受影响。
    // 已确认直连失败的封面地址会被记录，避免同一封面反复白试一次直连。
    const coverDirectFailed = {};
    function extractCoverColor() {
      // 「封面取色」关闭时直接返回：不发起任何取色请求（取色要下载图片，是有实打实网络开销的）
      if (!quiSetting('coverColor', true)) return;
      const cover = getCoverUrl();
      if (!cover || cover === coverColorUrl) return;
      coverColorUrl = cover;
      // 该封面已知直连不可用：直接走代理，省掉一次注定失败的请求
      if (coverDirectFailed[cover] && musicWorkerUrl) {
        loadCoverColor(musicWorkerUrl + '?img=' + encodeURIComponent(cover), cover, true);
        return;
      }
      loadCoverColor(cover, cover, false);
    }

    // src: 实际加载地址；cover: 原始封面地址（用于回落与失败记录）；viaProxy: 是否已走 Worker 代理
    function loadCoverColor(src, cover, viaProxy) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          const oc = document.createElement('canvas');
          oc.width = oc.height = 24;
          const octx = oc.getContext('2d');
          octx.drawImage(img, 0, 0, 24, 24);
          const d = octx.getImageData(0, 0, 24, 24).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 10) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
          if (n) coverColor = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        } catch (e) {
          // canvas taint：说明该图床没给 CORS 头，回落代理重试
          fallbackToProxyCover(cover, viaProxy);
        }
      };
      img.onerror = function () {
        fallbackToProxyCover(cover, viaProxy);
      };
      img.src = src;
    }

    // 直连取色失败 → 回落到 Worker 图片代理（代理会补上 CORS 头）；已在代理模式则保持兜底色
    function fallbackToProxyCover(cover, viaProxy) {
      if (viaProxy) return;
      coverDirectFailed[cover] = true;
      if (musicWorkerUrl) {
        loadCoverColor(musicWorkerUrl + '?img=' + encodeURIComponent(cover), cover, true);
      }
    }

    // 频谱柱数量 & 帧间平滑缓冲
    const BAR_COUNT = 64;
    const smoothed = new Float32Array(BAR_COUNT);
    const VIS_GAIN = 0.7; // 静态整体缩放系数：让跳动幅度更小更柔和；无动态自动增益，峰值仍由音乐决定（非峰值对齐）
    // 频率映射：中心 = 低频(bass，能量最大 → 最高)；
    // 左半边 = 低频向「中低频」展开，右半边 = 低频向「中高频」展开（两边频率区间不同 → 形状不对称）。
    // 这样保持「中间最高」但左右不再镜像对称。
    function barValue(i) {
      const bins = analyser ? analyser.frequencyBinCount : BAR_COUNT;
      const mid = (BAR_COUNT - 1) / 2;
      let dl, span;
      if (i <= mid) {
        dl = (mid - i) / mid;          // 0(中心) .. 1(左边缘)
        span = bins * 0.40;            // 左半边覆盖：bass → 中低
      } else {
        dl = (i - mid) / (BAR_COUNT - 1 - mid); // 0(中心) .. 1(右边缘)
        span = bins * 0.78;            // 右半边覆盖：bass → 中高（更高），与左不同 → 不对称
      }
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(Math.pow(dl, 0.9) * span)));
      let s = 0, c = 0;
      for (let b = Math.max(0, idx - 1); b <= Math.min(bins - 1, idx + 1); b++) { s += dataArray[b]; c++; }
      return c ? s / c : 0;
    }

    /* 控制条占掉了屏幕底部多少高度。
     * ★★★ 为什么必须算这个：画布是 `position: fixed; bottom: 0; height: 220px`，
     *   而播放控制条（进度条 + 时间 + 圆钮）压在它上面 —— 实测桌面 1280×720 时
     *   控制条从 y=622 一直到底，**画布 220px 里有 98px 是根本看不见的**，
     *   只剩上面 122px 可用。结果就是所有频谱都被压在底部、被控制条切掉一截，
     *   看着又挤又矮（这也是「可视化不好看」的一大来源）。
     *   现在改成把画布整体抬到控制条上沿，220px 全部可见。 */
    function controlBarInset() {
      const ctrl = document.querySelector('#heoMusic-page .aplayer-controller');
      if (!ctrl) return 0;
      const r = ctrl.getBoundingClientRect();
      if (!r.height) return 0;                   // 播放器还没建出来 / 被隐藏
      return Math.max(0, Math.round(window.innerHeight - r.top));
    }

    function resize() {
      // 响应式高度：手机（<768px）更矮，桌面 220px，避免遮挡
      const cssW = window.innerWidth;
      const cssH = cssW < 768 ? 140 : 220;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      // 抬到控制条上沿；拿不到控制条（还没初始化）就先贴着底
      canvas.style.bottom = controlBarInset() + 'px';
    }
    resize();
    window.addEventListener('resize', resize);

    function ensureAudio(pl) {
      if (audioCtx || !pl || !pl.audio) return;
      // 仅当音频走 CORS 代理（audio.crossOrigin='anonymous' + Worker 提供 CORS 头）时才接入真实频谱；
      // 否则跨域媒体一旦接入 Web Audio 图会被静音，这里退回程序动画以保证声音正常播放。
      if (pl.audio.crossOrigin !== 'anonymous') {
        synthetic = true;
        return;
      }
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        source = audioCtx.createMediaElementSource(pl.audio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
      } catch (e) {
        console.warn('[visualizer] 音频上下文初始化失败', e);
        audioCtx = null;
        // ★ 必须同时降级为程序动画：draw() 里 target 的取值是
        //   `if (synthetic) {...} else if (analyser) {...}` ——
        //   两者都为假时 target 恒为 0，柱子只剩最小值，画面上就是一条几乎看不见的虚线，
        //   看起来像「可视化坏了」而不是「降级了」。
        synthetic = true;
      }
    }

    /* ============================================================
     *  可视化皮肤（样式）
     *
     *  每个样式都是一个**纯绘制函数**，签名统一：
     *    fn(c, cw, ch, amps, pal, aux)
     *      c    2D context
     *      cw/ch 画布像素宽高（已乘 dpr）
     *      amps  长度 BAR_COUNT 的 0..1 振幅（已平滑，不做归一化）
     *      pal   { base, lite, soft }，由封面主色生成
     *      aux   { dpr, t(秒), playing }
     *
     *  只负责「把这一帧画完」：频谱取样、帧间平滑、性能监测全部在 draw() 里
     *  统一处理 —— 所以加一套新皮肤不用碰任何别的地方，也不会影响掉帧判定。
     *
     *  ★ 选哪套由 `visStyle` 决定，默认 capsule；
     *    调试时可用 `?vis=ribbon` 之类的 URL 参数临时覆盖（不写进设置）。
     * ============================================================ */
    const VIS_STYLES = {};

    // 当前调色板：拿到封面主色就用主色，否则用兜底柔紫（{r:167,g:139,b:250}）
    function currentPalette() {
      const base = coverColor || { r: 167, g: 139, b: 250 };
      return { base: base, lite: lighten(base, 0.45), soft: lighten(base, 0.74) };
    }

    // 把 BAR_COUNT 个振幅重采样到 n 个（细柱 / 点阵这类样式需要的根数更多或更少）
    function ampAt(amps, n, i) {
      const len = amps.length;
      if (n === len) return amps[i];
      const x = i * (len - 1) / Math.max(1, n - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(len - 1, i0 + 1);
      const f = x - i0;
      return amps[i0] * (1 - f) + amps[i1] * f;
    }

    // 平滑折线（二次贝塞尔中点法）。reverse=true 时倒着走，用于缝合闭合区域。
    function smoothTo(c, pts, reverse) {
      const n = pts.length;
      if (!n) return;
      if (reverse) {
        c.lineTo(pts[n - 1].x, pts[n - 1].y);
        for (let i = n - 2; i >= 1; i--) {
          c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i - 1].x) / 2, (pts[i].y + pts[i - 1].y) / 2);
        }
        c.lineTo(pts[0].x, pts[0].y);
      } else {
        c.lineTo(pts[0].x, pts[0].y);
        for (let i = 1; i < n - 1; i++) {
          c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        }
        c.lineTo(pts[n - 1].x, pts[n - 1].y);
      }
    }

    /* ---- ① capsule：胶囊柱，从底部向上长（原样式，保留作基准） ---- */
    VIS_STYLES.capsule = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const N = amps.length;
      const gap = 3 * dpr;
      const barW = (cw - gap * (N + 1)) / N;
      const minBar = 2 * dpr;
      const grad = c.createLinearGradient(0, 0, cw, 0);
      grad.addColorStop(0.0, rgba(pal.base, 0.95));
      grad.addColorStop(0.5, rgba(pal.lite, 0.6));
      grad.addColorStop(1.0, rgba(pal.base, 0.95));
      c.save();
      c.fillStyle = grad;
      c.shadowColor = rgba(pal.base, 0.7);
      c.shadowBlur = 6 * dpr;
      for (let i = 0; i < N; i++) {
        const x = gap + i * (barW + gap);
        const bh = Math.max(minBar, amps[i] * ch);
        const y = ch - bh;
        const r = Math.min(barW / 2, bh / 2);
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + barW, y, x + barW, y + bh, r);
        c.arcTo(x + barW, y + bh, x, y + bh, r);
        c.arcTo(x, y + bh, x, y, r);
        c.arcTo(x, y, x + barW, y, r);
        c.closePath();
        c.fill();
      }
      c.restore();
    };

    /* ---- ② ribbon：一条流动的绸带（上下不对称，下半更薄） ---- */
    VIS_STYLES.ribbon = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const N = amps.length;
      const midY = ch * 0.52;
      const maxA = ch * 0.42;
      const stepX = cw / (N - 1);
      const up = [], down = [];
      for (let i = 0; i < N; i++) {
        const v = amps[i];
        const h = Math.max(1.5 * dpr, v * maxA);
        up.push({ x: i * stepX, y: midY - h });
        // 下半高度只取 0.62：完全镜像会像倒影，稍微薄一点更像「有厚度的绸带」
        down.push({ x: i * stepX, y: midY + Math.max(1.5 * dpr, v * maxA * 0.62) });
      }
      const band = c.createLinearGradient(0, midY - maxA, 0, midY + maxA * 0.7);
      band.addColorStop(0.0, rgba(pal.lite, 0.66));
      band.addColorStop(0.45, rgba(pal.base, 0.26));
      band.addColorStop(1.0, rgba(pal.lite, 0.52));
      c.save();
      c.beginPath();
      c.moveTo(up[0].x, up[0].y);
      smoothTo(c, up, false);
      smoothTo(c, down, true);
      c.closePath();
      c.fillStyle = band;
      c.fill();
      // 下沿一道很淡的反光线：让绸带看起来是「一片」而不是一条线
      c.beginPath();
      c.moveTo(down[0].x, down[0].y);
      smoothTo(c, down, false);
      c.strokeStyle = rgba(pal.lite, 0.34);
      c.lineWidth = 1 * dpr;
      c.stroke();
      // 上沿高光线（整个样式的「记忆点」就在这里）
      c.beginPath();
      c.moveTo(up[0].x, up[0].y);
      smoothTo(c, up, false);
      c.strokeStyle = rgba(pal.soft, 0.95);
      c.lineWidth = 2 * dpr;
      c.shadowColor = rgba(pal.base, 0.9);
      c.shadowBlur = 18 * dpr;
      c.stroke();
      c.restore();
    };

    /* ---- ③ mirror：以水平中线为轴的镜像细柱 ---- */
    VIS_STYLES.mirror = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const barW = 2 * dpr;
      const gapPx = 3 * dpr;
      const n = Math.max(8, Math.floor(cw / (barW + gapPx)));
      const midY = ch * 0.5;
      const maxA = ch * 0.44;
      const totalW = n * barW + (n - 1) * gapPx;
      const x0 = (cw - totalW) / 2;
      const grad = c.createLinearGradient(0, 0, cw, 0);
      grad.addColorStop(0.0, rgba(pal.base, 0.80));
      grad.addColorStop(0.5, rgba(pal.soft, 0.95));
      grad.addColorStop(1.0, rgba(pal.base, 0.80));
      c.save();
      c.fillStyle = grad;
      c.shadowColor = rgba(pal.base, 0.5);
      c.shadowBlur = 5 * dpr;
      for (let i = 0; i < n; i++) {
        const v = ampAt(amps, n, i);
        const h = Math.max(1.5 * dpr, v * maxA);
        const x = x0 + i * (barW + gapPx);
        c.fillRect(x, midY - h, barW, h);
        c.fillRect(x, midY + dpr, barW, h * 0.55);   // 下镜像略短，避免像「倒影照抄」
      }
      c.restore();
    };

    /* ---- ④ dots：一溜星尘，振幅决定半径与亮度 ---- */
    VIS_STYLES.dots = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const n = 48;
      const midY = ch * 0.62;
      const maxA = ch * 0.46;
      const stepX = cw / (n - 1);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const v = ampAt(amps, n, i);
        pts.push({ x: i * stepX, y: midY - v * maxA, v: v });
      }
      // 先铺一条极淡的连线，把散落的点「串」成一条波 —— 没有它整排点会显得很散
      c.save();
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      smoothTo(c, pts, false);
      c.strokeStyle = rgba(pal.lite, 0.30);
      c.lineWidth = 1 * dpr;
      c.stroke();
      // 再画点：半径与亮度都随振幅走
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const v = p.v;
        const r = (1.2 + v * 4.6) * dpr;
        const a = 0.22 + v * 0.78;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fillStyle = rgba(v > 0.55 ? pal.soft : pal.lite, a);
        c.shadowColor = rgba(pal.base, a * 0.9);
        c.shadowBlur = (4 + v * 12) * dpr;
        c.fill();
      }
      c.restore();
    };

    /* ---- ⑤ ring：底部中央的半圆环，柱子沿弧线向外放射 ---- */
    VIS_STYLES.ring = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const N = 64;
      const cx = cw / 2;
      const cy = ch * 1.0;           // 圆心压在画布下沿 → 只露出上半弧
      const R = ch * 0.60;
      const maxLen = ch * 0.34;
      // 弧内一层很淡的穹顶光：没有它，几条放射线会显得「飘」在背景上
      const dome = c.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
      dome.addColorStop(0, rgba(pal.base, 0.20));
      dome.addColorStop(0.75, rgba(pal.base, 0.07));
      dome.addColorStop(1, rgba(pal.base, 0));
      c.save();
      c.beginPath();
      c.arc(cx, cy, R, Math.PI, Math.PI * 2);
      c.closePath();
      c.fillStyle = dome;
      c.fill();
      c.lineCap = 'round';
      // 参考弧：让「频谱是绕着圆环长出来的」这层关系看得出来
      c.beginPath();
      c.arc(cx, cy, R, Math.PI, Math.PI * 2);
      c.lineWidth = 1 * dpr;
      c.strokeStyle = rgba(pal.lite, 0.38);
      c.stroke();
      const grad = c.createLinearGradient(0, cy - R - maxLen, 0, cy);
      grad.addColorStop(0, rgba(pal.soft, 0.98));
      grad.addColorStop(1, rgba(pal.base, 0.4));
      c.strokeStyle = grad;
      c.shadowColor = rgba(pal.base, 0.65);
      c.shadowBlur = 9 * dpr;
      for (let i = 0; i < N; i++) {
        const v = ampAt(amps, N, i);
        const ang = Math.PI + (i / (N - 1)) * Math.PI;
        const len = 2 * dpr + v * maxLen;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        c.beginPath();
        c.lineWidth = 2.2 * dpr;
        c.moveTo(cx + ca * R, cy + sa * R);
        c.lineTo(cx + ca * (R + len), cy + sa * (R + len));
        c.stroke();
      }
      c.restore();
    };

    /* ---- ⑥ forest：细线森林，越往上越亮，顶端一点星 ---- */
    VIS_STYLES.forest = function (c, cw, ch, amps, pal, aux) {
      const dpr = aux.dpr;
      const n = Math.max(40, Math.floor(cw / (5 * dpr)));
      const stepX = cw / n;
      const maxA = ch * 0.92;
      // ★ 只建一条纵向渐变给所有线共用（按绝对坐标取色）——
      //   每根线各建一个渐变的话，一帧就是上百个渐变对象，白烧 CPU。
      const grad = c.createLinearGradient(0, ch, 0, 0);
      grad.addColorStop(0.0, rgba(pal.base, 0.10));
      grad.addColorStop(0.55, rgba(pal.base, 0.62));
      grad.addColorStop(1.0, rgba(pal.soft, 0.98));
      c.save();
      c.lineWidth = 1.2 * dpr;
      c.strokeStyle = grad;
      for (let i = 0; i < n; i++) {
        const v = ampAt(amps, n, i);
        const h = Math.max(2 * dpr, v * maxA);
        const x = i * stepX + stepX / 2;
        c.beginPath();
        c.moveTo(x, ch);
        c.lineTo(x, ch - h);
        c.stroke();
      }
      // 顶端亮点单独一遍：避免每次 stroke 都重设 fillStyle
      c.fillStyle = rgba(pal.soft, 0.9);
      for (let i = 0; i < n; i++) {
        const v = ampAt(amps, n, i);
        const h = Math.max(2 * dpr, v * maxA);
        if (v < 0.3) continue;                  // 太矮的线不点灯，免得看着像噪点
        c.beginPath();
        c.arc(i * stepX + stepX / 2, ch - h, 1.2 * dpr, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    };

    const VIS_STYLE_KEYS = Object.keys(VIS_STYLES);
    // 默认沿用原来的胶囊柱；`?vis=xxx` 可临时切换，用于挑皮肤（不写进设置）
    let visStyle = (function () {
      const v = String(params.get('vis') || '').toLowerCase();
      return VIS_STYLES[v] ? v : 'capsule';
    })();

    function renderVis(c, cw, ch, amps, aux) {
      const fn = VIS_STYLES[visStyle] || VIS_STYLES.capsule;
      fn(c, cw, ch, amps, currentPalette(), aux);
    }

    // 可视化是否在跑。关闭时不再排下一帧，也不做任何绘制 —— 这是这个开关省电的关键，
    // 仅靠 CSS 隐藏 canvas 的话 rAF 仍会每秒跑 60 次。
    // ★ 初值必须是 null（而非 false）：applyVisualizer 用「值相等就 return」防重入，
    //   若初值是 false，那么首次调用时如果算出来也是「不该显示」（如未登录），
    //   就会直接 return，body.qui-hide-visualizer 永远加不上，DOM 状态和应用状态不一致。
    //   用 null 作「尚未应用过」的哨兵，保证第一次一定走完整个流程。
    let visRunning = null;

    /* ---- 性能监测：可视化在跑但帧率长期过低 → 弹窗建议关闭 ----
     * 为什么不猜设备型号：UA / hardwareConcurrency / deviceMemory 全都不可靠
     * （iOS Safari 压根不提供 deviceMemory，很多安卓机也谎报核心数）。
     * 「实际掉帧」才是用户真正看到的现象，所以直接量 rAF 的真实帧间隔。 */
    const PERF_MIN_FPS = 24;    // 平均帧率低于此值判定为卡顿
    const PERF_WINDOW = 90;     // 采样窗口（帧数），约 1.5s @60fps
    const PERF_WARMUP = 45;     // 预热帧：首屏布局、音频解码、封面加载必然掉帧，不能拿去判定
    const PERF_WARN_KEY = 'quimusic_perf_warned';
    let perfAccum = 0, perfFrames = 0, perfWarmup = 0, perfDone = false;
    let lastFrameTs = 0;

    function perfWarnedThisSession() {
      try { return sessionStorage.getItem(PERF_WARN_KEY) === '1'; } catch (e) { return false; }
    }
    function markPerfWarned() {
      try { sessionStorage.setItem(PERF_WARN_KEY, '1'); } catch (e) {}
    }

    /**
     * 采样一帧。只在「可视化正在跑 + 正在播放」时统计 ——
     * 暂停时的空转帧几乎没有绘制成本，拿它算帧率会得出「性能很好」的错误结论。
     */
    function samplePerf(dt, playing) {
      if (perfDone || !playing) return;
      if (perfWarmup < PERF_WARMUP) { perfWarmup++; return; }
      perfAccum += dt;
      perfFrames++;
      if (perfFrames < PERF_WINDOW) return;
      const avgFps = 1000 / (perfAccum / perfFrames);
      perfAccum = 0; perfFrames = 0;
      // 只判一次：达标就收工（不再持续采样，省掉长期开销）；
      // 不达标就弹窗并收工（避免用户选择「继续使用」后被反复打扰）。
      if (avgFps >= PERF_MIN_FPS) {
        perfDone = true;
        return;
      }
      perfDone = true;
      // 二次确认：可视化此刻仍是开着的才提示；已经关掉就不打扰
      if (!visRunning) return;
      if (perfWarnedThisSession()) return;
      markPerfWarned();
      showPerfModal();
      console.log('[visualizer] 平均帧率 ' + avgFps.toFixed(1) + ' fps，已提示关闭可视化');
    }

    function draw() {
      if (!visRunning) return;
      requestAnimationFrame(draw);
      const ts = performance.now();
      const dt = lastFrameTs ? ts - lastFrameTs : 16.7;
      lastFrameTs = ts;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const playing = player && !player.paused;
      samplePerf(dt, playing);
      if (analyser && playing) {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        // 跨域音频（CORS 失败）会让 AnalyserNode 拿不到数据（全 0）→ 降级为程序动画。
        // 加入迟滞：连续 45 帧全 0 才切到假动画（避免安静过门误判），连续 10 帧有数据再切回真实频谱。
        if (sum === 0) {
          nonZeroCount = 0;
          if (++zeroCount > 45) synthetic = true;
        } else {
          zeroCount = 0;
          if (++nonZeroCount > 10) synthetic = false;
        }
      }
      const now = performance.now() / 1000;
      const N = BAR_COUNT;
      const amps = new Array(N);
      for (let i = 0; i < N; i++) {
        let target = 0;
        if (playing) {
          if (synthetic) {
            // 程序动画：中间高两边低（山形），但左右相位不同 → 不对称
            const mid = (N - 1) / 2;
            const env = Math.cos((i / (N - 1) - 0.5) * Math.PI);
            const osc = i < mid
              ? Math.sin(now * 2.4 + i * 0.13)
              : Math.sin(now * 3.2 + i * 0.21 + 1.7);
            target = env * ((osc * 0.5 + 0.5) * 160 + 30);
          } else if (analyser) {
            target = barValue(i);
          }
        }
        smoothed[i] += (target - smoothed[i]) * 0.3;                 // 帧间平滑
        // 真实幅度、不做任何归一化/封顶：柱子随音乐自由起伏，无高度限制
        const v = Math.min(255, smoothed[i]) / 255;
        amps[i] = Math.pow(v, 0.9) * VIS_GAIN;
      }
      // 交给当前选中的皮肤去画（capsule / ribbon / mirror / dots / ring / forest）
      renderVis(ctx, w, h, amps, { dpr: dpr, t: now, playing: !!playing });
    }

    /**
     * 应用「音乐可视化」开关。
     * 用状态比较防重入：draw() 内部会自我排帧，重复调用会跑出两条循环。
     *
     * ★ 2026-10-01：可视化**必须登录 QuiID** 才可用。
     *   这里把「用户开关」与「登录态」分开判断：
     *     want = 用户设置里的开关值（登录后仍会沿用他的选择，不会因为一次退出就被重置）
     *     on   = want && 已登录
     *   未登录时不会去动用户的设置值，只是不启动绘制；界面上对应开关会被置灰
     *   （见 settings.js 的 renderVisualizerLock / index.html 的 .heo-row-lock）。
     */
    function isVisAllowed() {
      return !!(QS && typeof QS.isLoggedIn === 'function' && QS.isLoggedIn());
    }

    function applyVisualizer(want) {
      want = !!want;
      const on = want && isVisAllowed();
      if (on === visRunning) return;
      visRunning = on;
      document.body.classList.toggle('qui-hide-visualizer', !on);
      if (on) {
        // 每次重新启动都重置采样状态：用户可能刚换了设备环境/刚插上电源
        perfAccum = 0; perfFrames = 0; perfWarmup = 0; perfDone = false; lastFrameTs = 0;
        draw();                                   // 启动 rAF 循环
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    applyVisualizer(quiSetting('visualizer', true));

    function tryAttach() {
      if (attached) return;
      if (typeof ap !== 'undefined' && ap && ap.audio) {
        player = ap;
        attached = true;
        resize();       // 播放器已就位 → 重新量一次控制条高度，把画布抬到它上沿
        // 仅当启用音频代理 Worker 时，为音频打上 CORS 标记，Web Audio 才能读到真实频谱（否则会被静音）。
        // 重新 load() 使刚设置的 crossOrigin 在首次加载（尚未播放）时即生效，几乎无感。
        // 注意：默认（未填 musicWorkerUrl）模式下绝不能设 crossOrigin，否则 zhheo CDN 无 CORS 头会导致音频被拦截、无声。
        if (musicWorkerUrl && ap.audio.crossOrigin !== 'anonymous') {
          ap.audio.crossOrigin = 'anonymous';
          try { ap.audio.load(); } catch (e) {}
        }
        ensureAudio(player);
        heo.applyPlayerSettings(player);            // 歌词 / 音量 / 播放模式 / 自动播放
        extractCoverColor();                       // 首曲封面取主色
        applyCoverBackground();                    // 首曲封面作背景
        player.on('play', function () {
          ensureAudio(player);
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
          extractCoverColor();
          applyCoverBackground();
        });
        player.on('listswitch', function () {       // 切歌后重新取封面主色与背景
          extractCoverColor();
          applyCoverBackground();
        });
        // 音量变化写回设置。绑原生 volumechange 而不是 APlayer 事件，
        // 因为拖音量条、按键盘、系统媒体键都会触发原生事件，覆盖面最全。
        if (player.audio) {
          player.audio.addEventListener('volumechange', function () {
            if (!quiSetting('volumeMemory', true)) return;
            volume = player.audio.volume;           // 同步给键盘快捷键用的那个变量
            if (QS) QS.set('volume', volume);
          });
        }
      } else {
        setTimeout(tryAttach, 300);
      }
    }
    tryAttach();

    // 把闭包内的两个应用函数挂到 heo 上，供下面的设置监听调用
    // （coverColor / coverBg 的状态都活在本闭包里，外部改不到）
    heo._applyVisualizer = applyVisualizer;
    heo._applyCoverSettings = function () {
      const wantColor = quiSetting('coverColor', true);
      if (!wantColor) {
        coverColor = null;          // 回到兜底柔紫色：draw() 每帧都读它，下一帧即生效
      } else {
        coverColorUrl = null;       // 允许对当前封面重新取一次色
      }
      applyCoverBackground();
      if (wantColor) extractCoverColor();
    };

    /* ---- 挑皮肤用的调试钩子 ----
     * heo._visStyles()          列出全部样式名
     * heo._visPreview('ribbon') 用一段**模拟频谱**把某一套样式画成一帧
     *
     * 为什么需要它：可视化必须登录 QuiID 才启用（见 applyVisualizer），
     * 所以在没有登录态的本地环境里完全没法比对几套皮肤长什么样 ——
     * 这个钩子绕开登录与播放状态，直接把一帧画到画布上。
     * 生产环境里用户不会去调它，正常路径仍然是 draw() 里逐帧调 renderVis()。 */
    heo._visStyles = function () { return VIS_STYLE_KEYS.slice(); };
    heo._visPreview = function (name, phase) {
      const key = VIS_STYLES[name] ? name : visStyle;
      const t = typeof phase === 'number' ? phase : 0.7;
      const demo = new Array(BAR_COUNT);
      const mid = (BAR_COUNT - 1) / 2;
      for (let i = 0; i < BAR_COUNT; i++) {
        const env = Math.cos((i / (BAR_COUNT - 1) - 0.5) * Math.PI);
        const wob = 0.5 + 0.5 * Math.sin(t * 6.3 + i * 0.41) * Math.sin(t * 2.7 + i * 0.19);
        // 左右相位不同，和真实的 barValue() 一样做成不对称，预览才像真机
        const skew = i < mid ? 1 : 0.78;
        demo[i] = Math.max(0.05, env * wob * skew * 1.25);
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      VIS_STYLES[key](ctx, canvas.width, canvas.height, demo, currentPalette(),
        { dpr: dpr, t: t, playing: true });
      return key;
    };
  },

  /* ------------------------------------------------------------
   *  歌单增强：① 歌单内搜索  ② 手机端点空白处收起列表
   *  ------------------------------------------------------------
   *  两件事都必须等 Meting.js 把 `.aplayer-list` 生成出来之后才能挂，
   *  所以统一走 MutationObserver 等待，不依赖任何固定延时。
   * ---------------------------------------------------------- */
  initPlaylistExtras: function() {
    const backdrop = document.getElementById('qui-list-backdrop');
    const mqMobile = window.matchMedia('(max-width: 767px)');

    function whenListReady(cb) {
      if (document.querySelector('#heoMusic-page .aplayer-list')) { cb(); return; }
      const ob = new MutationObserver(function () {
        if (document.querySelector('#heoMusic-page .aplayer-list')) { ob.disconnect(); cb(); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
    }

    whenListReady(function () {
      const list = document.querySelector('#heoMusic-page .aplayer-list');
      const ol = list && list.querySelector('ol');
      if (!list || !ol) return;

      /* ================= ③ 修正切歌 / 展开列表时的滚动定位 =================
       * 注：③ 特意排在 ① 前面 —— 下面 ② 段落末尾有一句 `if (!backdrop) return`，
       *     放到它后面就会被那句提前 return 跳过。
       *
       * ★★★ 根因：APlayer 有**两处**把每行高度写死成 33px ——
       *     list.show()    →  ol.scrollTop = 33 * index          （APlayer.min.js:269）
       *     list.switch()  →  scrollTo(33 * index, 500, …, ol)   （APlayer.min.js:324）
       *   33px 是它默认皮肤的行高（32px 高 + 上下各 1px margin）。
       *   我们这套皮肤的行高是 35px、当前播放行 42px，乘数就对不上了，
       *   而且误差随曲目序号**线性累积**。无头实测 205 首的歌单：
       *     index=50  → 算出 1650，真实 1751（差 101px）
       *     index=150 → 算出 4950，真实 5240（差 290px）
       *     index=204 → 算出 6732，真实 7124（差 392px）
       *   实测切到 index=150 后 scrollTop 停在 4950，而高亮行在 5233 ——
       *   目标行整个落在可视区之外，这就是「换歌后歌曲列表栏定位不准」。
       *
       * 修法（两条，缺一不可）：
       *   ① 用**真实几何**重算目标位置：getBoundingClientRect 相对差，
       *      不依赖 offsetParent，也自动兼容手机端抽屉的 translateY。
       *   ② APlayer 内部那次错误滚动是 500ms 的补间动画，会一直往 ol.scrollTop 写值；
       *      不把它引开的话两边会互相拖拽（先滚错、再被拽回去）。
       *      做法是在调用原方法的瞬间，把 template.listOl 临时指向一个离屏替身，
       *      让那次补间落空 —— listOl 在 switch() 内部只被用到这一次，安全性已核对。
       *   定位口径与 APlayer 原意保持一致：把目标行**顶对齐**到列表可视区顶部。
       */
      function listScrollTop(targetOl, index) {
        const li = targetOl.children[index];
        if (!li) return null;
        // 目标行被搜索过滤隐藏时（display:none），getBoundingClientRect 全是 0，
        // 算出来是个无意义的坐标。此时列表本来就在筛选态，不去动滚动位置最合理。
        if (!li.offsetHeight) return null;
        const olRect = targetOl.getBoundingClientRect();
        const liRect = li.getBoundingClientRect();
        const offset = (liRect.top - olRect.top) + targetOl.scrollTop;   // 该行在滚动内容里的绝对偏移
        const max = Math.max(0, targetOl.scrollHeight - targetOl.clientHeight);
        return Math.max(0, Math.min(offset, max));                        // 顶对齐 + 夹在可滚动范围内
      }

      // 只用来吃掉 APlayer 内部那次数值写死的滚动，不产生任何副作用
      const SCROLL_SINK = { scrollTop: 0 };

      function patchListScroll() {
        const ap = window.ap;
        if (!ap || !ap.list) return false;
        if (ap.list.__quiScrollFixed) return true;   // 防重复打补丁（APlayer 重建时会重挂）
        ap.list.__quiScrollFixed = true;

        const origSwitch = ap.list.switch;
        ap.list.switch = function (index) {
          const T = this.player.template;
          const realOl = T.listOl;
          T.listOl = SCROLL_SINK;              // ② 引开内部补间
          try {
            origSwitch.call(this, index);
          } finally {
            T.listOl = realOl;                 // 一定要还原，后面还可能被别处用到
          }
          // 参数非法时原方法是空跑，我们也不能去动 scrollTop
          if (typeof index !== 'number' || !this.audios[index]) return;
          const top = listScrollTop(realOl, index);   // ① 用真实几何定位
          if (top !== null) realOl.scrollTop = top;
        };

        // show() 原实现只有三句，逐句对齐后只替换掉写死的 33 * index
        ap.list.show = function () {
          this.player.events.trigger('listshow');
          this.player.template.list.classList.remove('aplayer-list-hide');
          const targetOl = this.player.template.listOl;
          const top = listScrollTop(targetOl, this.index);
          if (top !== null) targetOl.scrollTop = top;
        };
        return true;
      }

      // window.ap 由 Meting.js 在 new APlayer() 之后挂上，正常情况此刻已存在；
      // 万一竞态没到，就等下一帧再补一次，不做无限轮询。
      if (!patchListScroll()) {
        requestAnimationFrame(function () { patchListScroll(); });
      }

      /* ================= ④ 会员曲目（试听 30s）识别 =================
       * 背景：网易云等平台的会员曲，meting 接口**照样给 url**（不是空、不报错），
       *   只是它指向一个只有 30 秒的试听片段。实测：试听片段体积固定
       *   0.46MB / 0.69MB（≈28.8s），而完整曲最小也有 4.3MB。
       *
       * 难点：歌单 JSON 只有 name / artist / url / pic / lrc 五个字段，**没有时长**，
       *   所以「哪几首是试听」在拿到音频之前根本无从得知。于是用两条互补的路：
       *
       *   A. 免费路（零额外请求）—— 某首歌一播放，loadedmetadata 里就有真实 duration，
       *      < 35 秒即判定为试听。缺点：只能覆盖「已经播过的」。
       *   B. 后台路（补 A 的空档）—— 列表里滚到可见的行，用「越界 Range 请求」
       *      靠 HTTP 状态码判断体积，实测每次只花 0～1 个字节（详见 probeOne）。
       *
       * 两条路结论都写进 previewMap 并落盘，跨会话累积：
       * 听得越多，列表上的徽标就越全，重复打开同一个歌单不再产生任何请求。
       */
      const PREVIEW_CACHE_KEY = 'quimusic_preview_map';
      const PREVIEW_MAX_DURATION = 35;        // 秒：小于它判为试听片段
      const PREVIEW_PROBE_OFFSET = 1200000;   // 字节：越界探测用的偏移量（1.2MB）
      const PROBE_MAX_PER_LOAD = 40;          // 单次打开最多后台探测多少首（约 4 屏）

      // { 歌曲key: 1 = 试听片段 | 0 = 完整曲 }
      let previewMap = (function () {
        try {
          const raw = JSON.parse(localStorage.getItem(PREVIEW_CACHE_KEY) || '{}');
          return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        } catch (e) { return {}; }
      })();

      function savePreviewMap() {
        try { localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify(previewMap)); } catch (e) {}
      }

      /* 一首歌的稳定标识：优先取 meting url 里的 id（换歌单顺序、换播放顺序都不变），
         拿不到 id 时退回「曲名|歌手」。
         ★ url 可能被 Worker 改写成 `?audio=<编码后的原地址>`，所以要先
           decodeURIComponent 再匹配，否则只能看到一层 `%26id%3D`。 */
      function songKey(audio) {
        if (!audio) return '';
        let u = audio.url || '';
        try { u = decodeURIComponent(u); } catch (e) {}
        const m = /[?&]id=([A-Za-z0-9]+)/.exec(u);
        if (m) return m[1];
        return (audio.name || '') + '|' + (audio.artist || '');
      }

      function applyBadge(index) {
        const li = ol.children[index];
        if (!li || li.querySelector('.qui-preview-badge')) return;
        // 打一个行级标记：CSS 靠它让歌手名不再被压缩（否则长曲名 + 徽标会把歌手挤没）
        li.classList.add('qui-has-preview');
        const badge = document.createElement('span');
        badge.className = 'qui-preview-badge';
        badge.textContent = '试听 30s';
        li.appendChild(badge);
      }

      function removeBadge(index) {
        const li = ol.children[index];
        if (!li) return;
        const badge = li.querySelector('.qui-preview-badge');
        if (badge) badge.remove();
        li.classList.remove('qui-has-preview');
      }

      function shortName(name) {
        const s = String(name || '这首歌');
        return s.length > 16 ? s.slice(0, 16) + '…' : s;
      }

      /* ---- A. 播放时用真实时长判定 ---- */
      const hintedKeys = {};   // 本次会话已提示过的歌，避免来回切歌反复弹

      function onMetaLoaded() {
        const player = window.ap;
        if (!player || !player.audio) return;
        const d = player.audio.duration;
        // 直播流 / 元数据还没就绪时 duration 会是 Infinity 或 NaN，不能拿来判定
        if (!isFinite(d) || d <= 0) return;
        const idx = player.list.index;
        const audio = player.list.audios[idx];
        const key = songKey(audio);
        if (!key) return;

        if (d < PREVIEW_MAX_DURATION) {
          if (previewMap[key] !== 1) { previewMap[key] = 1; savePreviewMap(); }
          applyBadge(idx);
          if (!hintedKeys[key]) {
            hintedKeys[key] = 1;
            showQuiToast('《' + shortName(audio && audio.name) + '》是会员歌曲，仅可试听 30 秒');
          }
        } else if (previewMap[key] === 1) {
          // 以前判成试听、现在拿到完整版（平台改了权限等）：以真实时长为准，撤掉徽标
          previewMap[key] = 0;
          savePreviewMap();
          removeBadge(idx);
        }
      }

      function attachMetaHook() {
        const player = window.ap;
        if (!player || !player.audio) return false;
        if (player.audio.__quiPreviewHooked) return true;
        player.audio.__quiPreviewHooked = true;
        player.audio.addEventListener('loadedmetadata', onMetaLoaded);
        return true;
      }

      function syncKnownBadges() {
        const player = window.ap;
        if (!player || !player.list) return;
        const audios = player.list.audios || [];
        for (let i = 0; i < audios.length; i++) {
          if (previewMap[songKey(audios[i])] === 1) applyBadge(i);
        }
      }

      /* ---- B. 后台探测可见行 ---- */
      let probeBudget = PROBE_MAX_PER_LOAD;
      const probeQueue = [];
      let probing = false;

      function probeOne(url) {
        /* 判据只用 HTTP 状态码，不读任何**跨域响应头**。
         * 请求 bytes=OFFSET-OFFSET（OFFSET = 1.2MB），按 RFC：
         *   · 文件比 OFFSET 小 → 必须回 416 Range Not Satisfiable
         *   · 文件比 OFFSET 大 → 回 206，只带 1 个字节
         * 于是「416 = 试听片段，206 = 完整曲」，一次探测实际流量 0～1 字节。
         *
         * 为什么不用 Content-Range 读总长度：它不是 CORS 安全响应头，
         *   跨域下 JS 读不到（实测 get('content-range') === null），
         *   要读必须让服务端补 Access-Control-Expose-Headers，
         *   而音频 Worker 是独立部署的，不能假设它一定被更新。
         * 万一服务端忽略 Range 直接回 200，就退回读 Content-Length
         *   —— 这个**是**安全响应头，跨域可读；读完立刻取消 body。 */
        return fetch(url, {
          method: 'GET',
          headers: { 'Range': 'bytes=' + PREVIEW_PROBE_OFFSET + '-' + PREVIEW_PROBE_OFFSET }
        }).then(function (r) {
          let verdict = null;
          if (r.status === 416) verdict = 1;          // 比 OFFSET 小 → 试听片段
          else if (r.status === 206) verdict = 0;     // 比 OFFSET 大 → 完整曲
          else if (r.status === 200) {
            const cl = parseInt(r.headers.get('content-length') || '0', 10);
            if (cl) verdict = (cl < PREVIEW_PROBE_OFFSET) ? 1 : 0;
          }
          // 不管哪种结果都别把音频读下来
          try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
          return verdict;   // null = 这次没测出来（限流/5xx/断网），不写缓存
        }).catch(function () { return null; });
      }

      function runProbe() {
        if (probing || !probeQueue.length) return;
        const task = probeQueue.shift();
        probeBudget--;
        probing = true;
        probeOne(task.url).then(function (verdict) {
          // ★ 注意用 !== null 判断：verdict 为 0（完整曲）也是有效结论
          if (verdict !== null) {
            previewMap[task.key] = verdict;
            savePreviewMap();
            if (verdict === 1) applyBadge(task.index);
            else removeBadge(task.index);
          }
          probing = false;
          if (probeQueue.length && probeBudget > 0) setTimeout(runProbe, 200);
        });
      }

      function setupProbe() {
        // 没有 Worker 就没有 CORS 头，跨域 fetch 读不到 Content-Range / Content-Length
        // （不透明响应），探测必然失败 —— 直接不做，省的是一堆白请求。
        if (!musicWorkerUrl) return;
        if (typeof IntersectionObserver !== 'function') return;
        const player = window.ap;
        if (!player || !player.list) return;
        const audios = player.list.audios || [];
        const seen = {};

        const io = new IntersectionObserver(function (entries) {
          // 列表收起时（手机端抽屉关闭）不探测，免得白花请求
          if (list.classList.contains('aplayer-list-hide')) return;
          for (let k = 0; k < entries.length; k++) {
            const entry = entries[k];
            if (!entry.isIntersecting) continue;
            if (probeBudget - probeQueue.length <= 0) return;
            const index = Array.prototype.indexOf.call(ol.children, entry.target);
            if (index < 0 || seen[index]) continue;
            seen[index] = 1;
            const audio = audios[index];
            if (!audio || !audio.url) continue;
            // 正在播的这首交给 A（时长）那条路，不重复请求
            if (index === player.list.index) continue;
            const key = songKey(audio);
            // 已经有结论（0 或 1）就不再请求 —— 这是「第二次打开零请求」的关键
            if (!key || previewMap[key] !== undefined) continue;
            probeQueue.push({ index: index, key: key, url: audio.url });
            runProbe();
          }
        }, { root: ol });

        Array.prototype.forEach.call(ol.children, function (li) { io.observe(li); });
      }

      if (!attachMetaHook()) {
        requestAnimationFrame(function () { attachMetaHook(); });
      }
      syncKnownBadges();
      setupProbe();

      /* ================= ① 歌单内搜索 ================= */
      const box = document.createElement('div');
      box.className = 'qui-search';
      box.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
        '<input type="search" class="qui-search-input" placeholder="搜索歌曲 / 歌手" ' +
        'aria-label="搜索歌单内歌曲" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">' +
        '<button type="button" class="qui-search-clear" aria-label="清空搜索" tabindex="-1">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>';
      list.insertBefore(box, list.firstChild);

      // 无结果时的空状态（默认 display:none，靠 .aplayer-list.is-empty 显示）
      const empty = document.createElement('div');
      empty.className = 'qui-search-empty';
      empty.textContent = '没有找到匹配的歌曲';
      list.insertBefore(empty, box.nextSibling);

      const input = box.querySelector('.qui-search-input');
      const items = Array.prototype.slice.call(ol.children);
      // 预先拍一份「曲名 + 歌手」的可搜索文本：每次输入都去查 DOM 会很浪费
      const haystack = items.map(function (li) {
        const t = li.querySelector('.aplayer-list-title');
        const a = li.querySelector('.aplayer-list-author');
        return ((t ? t.textContent : '') + ' ' + (a ? a.textContent : '')).toLowerCase();
      });

      function applyFilter() {
        const q = input.value.trim().toLowerCase();
        box.classList.toggle('has-value', q.length > 0);
        let hit = 0;
        for (let i = 0; i < items.length; i++) {
          const ok = !q || haystack[i].indexOf(q) >= 0;
          items[i].classList.toggle('qui-song-hidden', !ok);
          if (ok) hit++;
        }
        list.classList.toggle('is-empty', hit === 0);
      }

      input.addEventListener('input', applyFilter);
      /**
       * ★ 必须把键盘事件挡在输入框里。
       *  main.js 底部有一组绑在 document 上的全局快捷键（空格=播放/暂停、方向键=切歌/音量），
       *  它们走冒泡阶段，输入框里打的字会一路冒到 document ——
       *  结果就是在搜索框里按空格不仅打不出空格，还会把歌切了。
       *  stopPropagation 只影响冒泡，不影响输入框自身的默认行为，所以打字完全正常。
       */
      ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
        input.addEventListener(ev, function (e) {
          e.stopPropagation();
          if (e.type === 'keydown' && e.key === 'Enter') input.blur();
        });
      });
      // 点搜索框本身不要冒泡出去（面板的「点外部关闭」用的是 document 级监听）
      box.addEventListener('click', function (e) { e.stopPropagation(); });
      box.querySelector('.qui-search-clear').addEventListener('click', function (e) {
        e.stopPropagation();
        input.value = '';
        applyFilter();
        input.focus();
      });

      /* ================= ② 手机端：点空白收起列表 ================= */
      if (!backdrop) return;

      function syncBackdrop() {
        // 只在手机端（抽屉形态）且抽屉确实展开时显示遮罩
        const open = mqMobile.matches && !list.classList.contains('aplayer-list-hide');
        backdrop.classList.toggle('is-open', open);
      }

      // 抽屉的开合完全归 APlayer 管（菜单按钮 / ap.list.show|hide / 断点变化），
      // 所以这里只监听它的 class 变化来同步遮罩，不自己再存一份状态 ——
      // 存两份状态迟早会不同步。
      new MutationObserver(syncBackdrop).observe(list, {
        attributes: true, attributeFilter: ['class']
      });
      if (mqMobile.addEventListener) mqMobile.addEventListener('change', syncBackdrop);
      else if (mqMobile.addListener) mqMobile.addListener(syncBackdrop);

      backdrop.addEventListener('click', function () {
        // 用 APlayer 官方 API 收起：它会同步内部状态并广播 listhide 事件
        if (typeof ap !== 'undefined' && ap && ap.list) ap.list.hide();
        else list.classList.add('aplayer-list-hide');
        syncBackdrop();
      });

      syncBackdrop();
    });
  },

  // 初始化所有事件
  init: function() {
    this.getCustomPlayList();
    this.addHomeButton();
    this.initJumpPanel();
    this.initVisualizer();
    this.initPlaylistExtras();
    this.initScrollEvents();
    this.applyPlayerSettings();

    // 设置一变就实时生效：面板里切个开关、换个播放模式，不需要刷新页面。
    // 监听的是 settings.js 广播的变更事件，云端同步下来的设置走的也是同一条路。
    const self = this;
    if (QS) {
      QS.onChange(function () {
        self.applyPlayerSettings();
        if (typeof self._applyVisualizer === 'function') {
          self._applyVisualizer(quiSetting('visualizer', true));
        }
        if (typeof self._applyCoverSettings === 'function') {
          self._applyCoverSettings();
        }
      });
    }
  }
}

/* ★★★ 2026-10-17 修「播放器没建出来时按快捷键/改窗口尺寸就报错」
 *
 * `ap` 这个全局**只有 Meting.js 成功 `new APlayer()` 之后才会挂在 window 上**
 * （见 Meting.js 的 `window.ap = this.aplayer`）。而歌单加载失败时走的是
 * Meting._renderFail()，播放器根本不存在 —— 此时下面这些裸写的 `ap.xxx`
 * 全部会抛 `ReferenceError: ap is not defined`，一次按键 / 一次窗口缩放就一条。
 *
 * 典型案例：换歌单面板里选「歌手 + 酷我」这种接口不支持的组合 →
 * 页面提示「没取到歌单」→ 用户随手按空格想暂停（其实没歌可放）→ 控制台报错。
 *
 * 统一入口：所有对播放器的访问都从这里拿，拿不到就**安静地什么都不做**
 * （播放器都没有，本来也没有「切歌」「调音量」可言）。
 * 本文件别处（patchListScroll / initPlaylistExtras）早就是这个写法，这里补齐。 */
function getPlayer() {
  return (typeof window.ap !== 'undefined' && window.ap) ? window.ap : null;
}

//空格控制音乐
document.addEventListener("keydown", function (event) {
  const player = getPlayer();
  //暂停开启音乐
  if (event.code === "Space") {
    event.preventDefault();
    if (player) player.toggle();

  };
  //切换下一曲
  if (event.keyCode === 39) {
    event.preventDefault();
    if (player && player.list) player.skipForward();

  };
  //切换上一曲
  if (event.keyCode === 37) {
    event.preventDefault();
    if (player && player.list) player.skipBack();

  }
  //增加音量
  if (event.keyCode === 38) {
    if (volume <= 1) {
      volume += 0.1;
      if (player) player.volume(volume, false);

    }
  }
  //减小音量
  if (event.keyCode === 40) {
    if (volume >= 0) {
      volume += -0.1;
      if (player) player.volume(volume, false);

    }
  }
});

// 监听窗口大小变化
window.addEventListener('resize', function() {
  const player = getPlayer();
  if (!player || !player.list) return;   // 播放器还没建出来（歌单加载失败）→ 无事可做
  if (window.innerWidth > 768) {
    player.list.show();
  } else {
    player.list.hide();
  }

});

// 调用初始化
heo.init();

