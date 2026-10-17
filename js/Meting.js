class MetingJSElement extends HTMLElement {

  connectedCallback() {
    if (window.APlayer && window.fetch) {
      this._init()
      this._parse()
    }
  }

  disconnectedCallback() {
    if (!this.lock) {
      this.aplayer.destroy()
    }
  }

  _camelize(str) {
    return str
      .replace(/^[_.\- ]+/, '')
      .toLowerCase()
      .replace(/[_.\- ]+(\w|$)/g, (m, p1) => p1.toUpperCase())
  }

  _init() {
    let config = {}
    for (let i = 0; i < this.attributes.length; i += 1) {
      config[this._camelize(this.attributes[i].name)] = this.attributes[i].value
    }
    let keys = [
      'server', 'type', 'id', 'api', 'auth',
      'auto', 'lock',
      'name', 'title', 'artist', 'author', 'url', 'cover', 'pic', 'lyric', 'lrc',
    ]
    this.meta = {}
    for (let key of keys) {
      this.meta[key] = config[key]
      delete config[key]
    }
    this.config = config

    this.api = this.meta.api || window.meting_api || 'https://music.zhheo.com/meting-api/?server=:server&type=:type&id=:id&r=:r'
    if (this.meta.auto) this._parse_link()
  }

  _parse_link() {
    let rules = [
      ['music.163.com.*song.*id=(\\d+)', 'netease', 'song'],
      ['music.163.com.*album.*id=(\\d+)', 'netease', 'album'],
      ['music.163.com.*artist.*id=(\\d+)', 'netease', 'artist'],
      ['music.163.com.*playlist.*id=(\\d+)', 'netease', 'playlist'],
      ['music.163.com.*discover/toplist.*id=(\\d+)', 'netease', 'playlist'],
      ['y.qq.com.*song/(\\w+).html', 'tencent', 'song'],
      ['y.qq.com.*album/(\\w+).html', 'tencent', 'album'],
      ['y.qq.com.*singer/(\\w+).html', 'tencent', 'artist'],
      ['y.qq.com.*playsquare/(\\w+).html', 'tencent', 'playlist'],
      ['y.qq.com.*playlist/(\\w+).html', 'tencent', 'playlist'],
      ['xiami.com.*song/(\\w+)', 'xiami', 'song'],
      ['xiami.com.*album/(\\w+)', 'xiami', 'album'],
      ['xiami.com.*artist/(\\w+)', 'xiami', 'artist'],
      ['xiami.com.*collect/(\\w+)', 'xiami', 'playlist'],
    ]

    for (let rule of rules) {
      let patt = new RegExp(rule[0])
      let res = patt.exec(this.meta.auto)
      if (res !== null) {
        this.meta.server = rule[1]
        this.meta.type = rule[2]
        this.meta.id = res[1]
        return
      }
    }
  }

  _parse() {
    if (this.meta.url) {
      let result = {
        name: this.meta.name || this.meta.title || 'Audio name',
        artist: this.meta.artist || this.meta.author || 'Audio artist',
        url: this.meta.url,
        cover: this.meta.cover || this.meta.pic,
        lrc: this.meta.lrc || this.meta.lyric || '',
        type: this.meta.type || 'auto',
      }
      if (!result.lrc) {
        this.meta.lrcType = 0
      }
      if (this.innerText) {
        result.lrc = this.innerText
        this.meta.lrcType = 2
      }
      this._loadPlayer([result])
      return
    }

    let url = this.api
      .replace(':server', this.meta.server)
      .replace(':type', this.meta.type)
      .replace(':id', this.meta.id)
      .replace(':auth', this.meta.auth)
      .replace(':r', Math.random())

    fetch(url)
      .then(res => res.json())
      .then(result => this._loadPlayer(result))
      .catch(err => {
        // 网络断了 / 上游 5xx / 返回的不是 JSON —— 全都会落到这里。
        // 以前这里什么都不做，页面就停在加载动画上（要等 index.html 里那个
        // 8 秒兜底定时器才消失），用户完全不知道发生了什么。
        console.warn('[MetingJS] 歌单请求失败', err)
        this._renderFail('网络不太顺，歌单没取到。刷新页面或换个歌单再试。')
      })
  }

  /* ------------------------------------------------------------
   *  歌单加载失败时的兜底界面
   *  ------------------------------------------------------------
   *  触发场景（都是从「换歌单」那个入口最容易踩到的）：
   *    · ID 填错 / 平台选错 → 接口返回 { error: ... }（对象，不是数组）
   *    · 歌单是私密的、或平台限流 → 空数组
   *    · 网络异常 → _parse 里的 catch
   *  以前这三种都是「什么都不显示」，用户只会看到一片空白。
   * ---------------------------------------------------------- */
  _failReason(data) {
    if (data && data.error) return '接口说：' + String(data.error).slice(0, 80)
    if (data && !Array.isArray(data)) return '这个 ID 对应的内容不存在，或者该平台不支持这种类型'
    return '这个歌单是空的，或者 ID 不对'
  }

  _renderFail(text) {
    const host = document.getElementById('heoMusic-page') || this
    if (!host) return
    const old = host.querySelector('.qui-load-fail')
    if (old) old.remove()

    const box = document.createElement('div')
    box.className = 'qui-load-fail'
    box.innerHTML =
      '<p class="qui-load-fail-title">没取到歌单</p>' +
      '<p class="qui-load-fail-sub"></p>' +
      '<button type="button" class="heo-btn-primary" data-qui-reset>回到默认歌单</button>'
    box.querySelector('.qui-load-fail-sub').textContent = text || ''
    box.querySelector('[data-qui-reset]').addEventListener('click', function () {
      location.href = location.pathname   // 丢掉查询参数 = 回默认歌单
    })
    host.appendChild(box)

    // ★ 启动遮罩只在「.aplayer 出现」时才消失（见 index.html 底部脚本），
    //   而加载失败根本不会有 .aplayer —— 不在这里主动收掉的话，
    //   用户会对着加载动画盯满 8 秒才看到这块提示。
    const loadEl = document.getElementById('qui-loading')
    if (loadEl) loadEl.classList.add('qui-hidden')
  }

  _loadPlayer(data) {

    let defaultOption = {
      audio: data,
      mutex: true,
      lrcType: this.meta.lrcType || 3,
      storageName: 'metingjs',
      listFolded: window.innerWidth < 768 ? true : false
    }

    if (!Array.isArray(data) || !data.length) {
      // 以前是一句 `if (!data.length) return`：对象（含 error 字段）会被放行，
      // APlayer 拿到非数组会直接崩；空数组则静默什么都不显示。
      this._renderFail(this._failReason(data))
      return
    }

    let options = {
      ...defaultOption,
      ...this.config,
    }
    for (let optkey in options) {
      if (options[optkey] === 'true' || options[optkey] === 'false') {
        options[optkey] = (options[optkey] === 'true')
      }
    }

    let div = document.createElement('div')
    options.container = div
    this.appendChild(div)

    this.aplayer = new APlayer(options)
    window.ap = this.aplayer;

    heo.setupMediaSessionHandlers(this.aplayer);
  }

}

console.log('\n %c MetingJS v2.0.1 %c https://github.com/metowolf/MetingJS \n', 'color: #fadfa3; background: #030307; padding:5px 0;', 'background: #fadfa3; padding:5px 0;')

if (window.customElements && !window.customElements.get('meting-js')) {
  window.MetingJSElement = MetingJSElement
  window.customElements.define('meting-js', MetingJSElement)
}
