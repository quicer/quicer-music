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
  var homeUrl = "https://quicer-workers.sryze.cc"; // 替换为你的主页地址
}

// 音乐馆「真实频谱」音频代理 Worker 地址（对应仓库内 music-worker.js）。
// 部署 Cloudflare Worker 后把地址填到下面；留空则回落到默认 meting-api（仅有程序动画频谱，声音正常）。
// 填值后：歌单请求与音频流都走该 Worker，Worker 为音频加上 Access-Control-Allow-Origin，
// 浏览器才能通过 Web Audio 的 AnalyserNode 读取真实频谱（否则跨域音频会被静音）。
if (typeof musicWorkerUrl === 'undefined') {
  var musicWorkerUrl = "https://music.quicer-workers.sryze.cc"; // ← 在此填入 Worker 地址
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

var volume = 0.8;

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
    const currentLrcContent = document.getElementById("heoMusic-page").querySelector(".aplayer-lrc-current").textContent;
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
    document.body.appendChild(btn);
  },
  
  // 新增方法：音乐可视化（Web Audio 频谱；跨域音频无数据时自动降级为程序动画）
  initVisualizer: function() {
    const canvas = document.getElementById('heo-visualizer');
    if (!canvas) return;
    // 移入 #heoMusic-page，使其与模糊背景处于同一层叠上下文：
    // 这样画布能显示在 #web_bg 之上，又不会遮挡歌词/封面/控制器
    const page = document.getElementById('heoMusic-page');
    if (page && canvas.parentElement !== page) {
      page.insertBefore(canvas, page.firstChild);
    }
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let audioCtx = null, analyser = null, source = null, dataArray = null;
    let synthetic = false, zeroCount = 0, nonZeroCount = 0, player = null, attached = false;

    // 频谱柱状数量 & 帧间平滑缓冲，让动作更顺滑
    const BAR_COUNT = 64;
    const smoothed = new Float32Array(BAR_COUNT);
    // 把 BAR_COUNT 个点映射到频率 bin：只取前 75% 频段（丢弃 16kHz+ 几乎无能量的空段），
    // 对数指数降到 1.3 让中频更展开；配合绘制时的高频增益 + 对比提升，解决「右侧不动」。
    function barValue(i) {
      const bins = analyser ? analyser.frequencyBinCount : BAR_COUNT;
      const span = bins * 0.75;
      const t0 = Math.pow(i / BAR_COUNT, 1.3);
      const t1 = Math.pow((i + 1) / BAR_COUNT, 1.3);
      const lo = Math.floor(t0 * span);
      const hi = Math.max(lo + 1, Math.floor(t1 * span));
      let s = 0, c = 0;
      for (let b = lo; b < hi && b < bins; b++) { s += dataArray[b]; c++; }
      return c ? s / c : 0;
    }

    function resize() {
      // 响应式高度：手机（<768px）更矮，桌面 120px，避免遮挡控制器
      const cssH = window.innerWidth < 768 ? 80 : 120;
      canvas.width = window.innerWidth * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = cssH + 'px';
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
      }
    }

    function draw() {
      requestAnimationFrame(draw);
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const playing = player && !player.paused;
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
      // 用二次贝塞尔（中点法）把控制点连成柔顺曲线
      function curveThrough(pts) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2;
          const yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
      }

      const now = performance.now() / 1000;
      const N = BAR_COUNT;
      const pts = [];
      for (let i = 0; i < N; i++) {
        let target = 0;
        if (playing) {
          if (synthetic) {
            target = (Math.sin(now * 2.2 + i * 0.30) * 0.5 + 0.5) * 120
                   + Math.sin(now * 5 + i * 0.8) * 22 + 28;
          } else if (analyser) {
            target = barValue(i);
          }
        }
        smoothed[i] += (target - smoothed[i]) * 0.25;   // 更柔的帧间平滑
        // 高频增益：越靠右放大越多，让原本「不动」的右侧也起伏
        const gain = 1 + (i / (N - 1)) * 1.1;
        // 对比提升：把低能量段也抬起来，曲线更饱满
        const norm = Math.pow(Math.min(255, smoothed[i] * gain) / 255, 0.6);
        pts.push({ x: (w * i) / (N - 1), y: h - norm * (h * 0.9) });
      }

      // 柔光底部基线
      ctx.save();
      ctx.globalAlpha = 0.5;
      const base = ctx.createLinearGradient(0, 0, w, 0);
      base.addColorStop(0, 'rgba(123,92,255,0)');
      base.addColorStop(0.5, 'rgba(255,255,255,0.30)');
      base.addColorStop(1, 'rgba(255,209,102,0)');
      ctx.fillStyle = base;
      ctx.fillRect(0, h - 2 * dpr, w, 2 * dpr);
      ctx.restore();

      // 柔和平滑面积填充（半透明渐变，呼应金色基调）
      ctx.beginPath();
      ctx.moveTo(0, h);
      curveThrough(pts);
      ctx.lineTo(w, h);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, 'rgba(255,159,107,0.42)');
      fill.addColorStop(0.55, 'rgba(255,95,162,0.22)');
      fill.addColorStop(1, 'rgba(123,92,255,0.04)');
      ctx.fillStyle = fill;
      ctx.fill();

      // 顶部细描边曲线（半透明白 + 极轻辉光），不画硬柱、不刺眼
      ctx.beginPath();
      curveThrough(pts);
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.shadowColor = 'rgba(255,160,200,0.5)';
      ctx.shadowBlur = 4 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    draw();

    function tryAttach() {
      if (attached) return;
      if (typeof ap !== 'undefined' && ap && ap.audio) {
        player = ap;
        attached = true;
        // 仅当启用音频代理 Worker 时，为音频打上 CORS 标记，Web Audio 才能读到真实频谱（否则会被静音）。
        // 重新 load() 使刚设置的 crossOrigin 在首次加载（尚未播放）时即生效，几乎无感。
        // 注意：默认（未填 musicWorkerUrl）模式下绝不能设 crossOrigin，否则 zhheo CDN 无 CORS 头会导致音频被拦截、无声。
        if (musicWorkerUrl && ap.audio.crossOrigin !== 'anonymous') {
          ap.audio.crossOrigin = 'anonymous';
          try { ap.audio.load(); } catch (e) {}
        }
        ensureAudio(player);
        player.on('play', function () {
          ensureAudio(player);
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        });
      } else {
        setTimeout(tryAttach, 300);
      }
    }
    tryAttach();
  },

  // 初始化所有事件
  init: function() {
    this.getCustomPlayList();
    this.addHomeButton();
    this.initVisualizer();
    this.initScrollEvents();
  }
}

//空格控制音乐
document.addEventListener("keydown", function (event) {
  //暂停开启音乐
  if (event.code === "Space") {
    event.preventDefault();
    ap.toggle();

  };
  //切换下一曲
  if (event.keyCode === 39) {
    event.preventDefault();
    ap.skipForward();

  };
  //切换上一曲
  if (event.keyCode === 37) {
    event.preventDefault();
    ap.skipBack();

  }
  //增加音量
  if (event.keyCode === 38) {
    if (volume <= 1) {
      volume += 0.1;
      ap.volume(volume, true);

    }
  }
  //减小音量
  if (event.keyCode === 40) {
    if (volume >= 0) {
      volume += -0.1;
      ap.volume(volume, true);

    }
  }
});

// 监听窗口大小变化
window.addEventListener('resize', function() {
  if (window.innerWidth > 768) {
    ap.list.show();
  } else {
    ap.list.hide();
  }

});

// 调用初始化
heo.init();

