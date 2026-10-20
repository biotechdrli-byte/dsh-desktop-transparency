/**
 * dsh-desktop-transparency — 浏览器半侧 (v0.2 分区版)
 * ----------------------------------------------------------------------------
 * 两件事：
 *   1) 把系统壁纸按「屏幕坐标」钉在界面背后（对齐原理见 README）
 *   2) 把界面按区域分别调透明度：左侧栏 / 对话区 / 右侧栏 / 顶栏 / 浮层
 *
 * 为什么必须分区：opacity 会沿着 DOM 树向下相乘。把整个应用统一降透明度，
 * 弹窗、菜单这些二级窗口也会一起变透明，和底下的文字叠在一起。
 * 所以这里对「互为兄弟」的几个区域各设各的 opacity，互不干扰。
 *
 * 这些选择器全部来自桌面端打包产物的真实类名
 * （resources/app/lib/client.js 里的 dshDesktop* 系列），不是猜的。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-transparency',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var NS = 'dsh-desktop-transparency'
    var API_INFO = '/dsh-bg/info'
    var API_IMG = '/dsh-bg/wallpaper'
    var API_DOM = '/dsh-bg/_dom'

    var STATE_KEY = 'dsh-dtp-state'
    var BG_ID = 'dsh-dtp-bg'
    var SCRIM_ID = 'dsh-dtp-scrim'
    var STYLE_ID = 'dsh-dtp-style'
    var PANEL_ID = 'dsh-dtp-panel'
    var HANDLE_ID = 'dsh-dtp-handle'
    var LAYER_CLASS = 'dsh-dtp-layer'

    /* ═══════════════════════════════════════════════════════════════════
     *  分区选择器 —— 全插件唯一需要随 DSH 升级维护的地方
     * -------------------------------------------------------------------
     *  DSH 用 CSS Modules，类名是编译产物里的哈希（MnhYfG_ / _727C8a_ /
     *  THMRvG_），**版本一变就可能全变**。所以：
     *
     *   - 实测基线：DSH Desktop 2.0.18 / 内核 0.2.1-rc.2 / Windows
     *   - 桌面包运行在 compatibility 形态（body 上无 data-dsh-desktop-mode），
     *     因此不存在 advanced/extended 的 .dshDesktop* 外壳
     *   - 真实结构：#root > .MnhYfG_frame
     *         ├ .MnhYfG_sidebarCol    左栏
     *         ├ .MnhYfG_centerCol > ._727C8a_root
     *         │     ├ header._727C8a_header   顶栏（代码视图上方）
     *         │     ├ ._727C8a_body            对话区
     *         │     └ .THMRvG_panel            右栏
     *         └ .MnhYfG_overlayLayer   浮层
     *
     *  坏了怎么办：
     *    1) 面板上失效分区会显示 ⚠
     *    2) Ctrl+Alt+D 导出 ~/.dsh/dsh-dtp-dom.json
     *    3) 在快照里找对应的 tag/class/尺寸，替换下面的 sel
     *  data-* 属性优先于哈希类名 —— 前者跨版本更稳。
     * ═══════════════════════════════════════════════════════════════════ */
    var REGIONS = [
      {
        key: 'sidebar',
        label: '左侧栏',
        sel: '.MnhYfG_sidebarCol'
      },
      {
        key: 'conversation',
        label: '对话区',
        sel: '._727C8a_body'
      },
      {
        key: 'header',
        label: '顶栏',
        sel: 'header._727C8a_header'
      },
      {
        key: 'rightbar',
        label: '右侧栏',
        sel: '[data-sidebar-right-panel], .THMRvG_panel'
      },
      {
        key: 'overlay',
        label: '浮层 / 弹窗',
        sel: '[data-shell-overlay], .MnhYfG_overlayLayer'
      }
    ]

    /* 结构让位：中区根节点本来承担整块底色（rgb 21,21,23）。
       要分别调节「顶栏」和「对话区」，就得让根节点交出底色，
       由 header 与 body 各自承担 —— 否则两者只能一起变。
       opacity 仍是 1 时视觉与原样一致，不会有副作用。 */
    var STRUCT_CSS = [
      '.MnhYfG_frame{background:transparent !important}',
      '._727C8a_root{background:transparent !important}',
      /* header 与 body 原本是透明的，透出 root 的底色。
         root 交出底色后必须由它们各自补上，否则文字直接压在壁纸上。
         侧栏不动 —— 它有自己更浅的底色(#1b1b1c)，覆盖会破坏层次。 */
      '._727C8a_body{background:var(--dsw-alias-bg-base,#151517) !important}',
      'header._727C8a_header{background:var(--dsw-alias-bg-base,#151517) !important}'
    ].join('')

    var DEFAULTS = {
      enabled: true,
      /* 默认值 = 用户实机调定的满意组合（2026-10-21 验收） */
      opacity: {
        sidebar: 0.81,
        conversation: 0.60,
        header: 0.86,
        rightbar: 0.66,
        overlay: 0.96
      },
      blur: 29,
      dim: 0.18,
      /* 偏移默认 0 —— 校准值取决于窗口外框内缩与 DPI 缩放，因人而异。
         本机（Windows / 125%）实测为 X=-7.5 / Y=-38.5，见 README「对齐校准」。 */
      offsetX: 0,
      offsetY: 0,
      panel: true
    }

    var state = JSON.parse(JSON.stringify(DEFAULTS))
    var started = false
    var rafId = 0
    var timerId = 0
    var idleFrames = 0
    var lastKey = ''
    var lastMtime = -1
    var pollTimer = 0
    var syncTimer = 0
    var observer = null
    var keyHandler = null
    var resizeHandler = null
    var panelEl = null
    var geoEl = null
    var dragState = null
    var regionLabels = {}
    var regionCounts = {}
    var lastObserverRun = 0

    /* ── 状态 ───────────────────────────────────────────────────────────── */

    function loadState() {
      try {
        var raw = window.localStorage.getItem(STATE_KEY)
        if (!raw) return
        var saved = JSON.parse(raw)
        if (!saved || typeof saved !== 'object') return
        if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled
        if (typeof saved.blur === 'number') state.blur = saved.blur
        if (typeof saved.dim === 'number') state.dim = saved.dim
        if (typeof saved.offsetX === 'number') state.offsetX = saved.offsetX
        if (typeof saved.offsetY === 'number') state.offsetY = saved.offsetY
        if (typeof saved.panel === 'boolean') state.panel = saved.panel
        if (saved.opacity && typeof saved.opacity === 'object') {
          for (var i = 0; i < REGIONS.length; i++) {
            var k = REGIONS[i].key
            if (typeof saved.opacity[k] === 'number') {
              state.opacity[k] = Math.max(0.05, Math.min(1, saved.opacity[k]))
            }
          }
        }
      } catch (e) { /* 读不到就用默认值 */ }
    }

    function saveState() {
      try {
        window.localStorage.setItem(STATE_KEY, JSON.stringify(state))
      } catch (e) { /* 配额满了也不影响显示 */ }
    }

    /* ── 样式 ───────────────────────────────────────────────────────────── */

    var CSS = [
      '.' + LAYER_CLASS + '{position:fixed;top:0;left:0;pointer-events:none;z-index:-1;background-repeat:no-repeat;background-position:0 0;will-change:transform;transform-origin:0 0}',
      '#' + BG_ID + '{background-color:transparent}',
      '#' + SCRIM_ID + '{background-color:#000;opacity:0}',
      /* 只清掉「容器自己」的底色，不动子元素的不透明度 —— 否则会与分区 opacity 相乘 */
      'html,body{background:transparent !important}',
      '.dshDesktopFrame,.dshDesktopContentViewport{background:transparent !important}',
      '#' + PANEL_ID + '{position:fixed;right:14px;bottom:14px;z-index:2147483600;width:288px;box-sizing:border-box;',
      'font:12px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:#eaeaea;',
      'background:rgba(24,24,28,.92);border:1px solid rgba(255,255,255,.14);border-radius:12px;',
      'box-shadow:0 12px 32px rgba(0,0,0,.45);backdrop-filter:blur(12px);overflow:hidden;user-select:none}',
      '#' + PANEL_ID + ' .h{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;',
      'background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.1)}',
      '#' + PANEL_ID + ' .h b{font-weight:600;font-size:12px;letter-spacing:.02em}',
      '#' + PANEL_ID + ' .h .x{margin-left:auto;cursor:pointer;opacity:.7;padding:0 4px;font-size:14px;line-height:1}',
      '#' + PANEL_ID + ' .h .x:hover{opacity:1}',
      '#' + PANEL_ID + ' .b{padding:8px 10px 10px;display:flex;flex-direction:column;gap:7px;max-height:70vh;overflow:auto}',
      '#' + PANEL_ID + ' .r{display:grid;grid-template-columns:64px 1fr 38px;align-items:center;gap:8px}',
      '#' + PANEL_ID + ' .r label{color:#cfcfd6;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#' + PANEL_ID + ' .r .v{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#9fb4ff;text-align:right}',
      '#' + PANEL_ID + ' input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:16px;background:transparent;cursor:pointer}',
      '#' + PANEL_ID + ' input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(255,255,255,.18)}',
      '#' + PANEL_ID + ' input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;background:#7f9dff;box-shadow:0 0 0 1px rgba(0,0,0,.4)}',
      '#' + PANEL_ID + ' .sep{height:1px;background:rgba(255,255,255,.1);margin:3px 0}',
      '#' + PANEL_ID + ' .f{display:flex;gap:6px;align-items:center}',
      '#' + PANEL_ID + ' button{flex:1;font:inherit;font-size:11.5px;color:#eaeaea;background:rgba(255,255,255,.1);',
      'border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:5px 8px;cursor:pointer}',
      '#' + PANEL_ID + ' button:hover{background:rgba(255,255,255,.18)}',
      '#' + PANEL_ID + ' .tip{color:#8a8a95;font-size:10.5px;line-height:1.5}',
      '#' + PANEL_ID + ' .geo{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#8a8a95;white-space:pre;line-height:1.45}',
      /* 面板收起后的小圆点入口，避免关掉之后找不到回来的路 */
      '#' + HANDLE_ID + '{position:fixed;right:14px;bottom:14px;z-index:2147483600;width:30px;height:30px;',
      'display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;',
      'font:15px/1 system-ui,sans-serif;color:#eaeaea;background:rgba(24,24,28,.88);',
      'border:1px solid rgba(255,255,255,.16);border-radius:50%;box-shadow:0 6px 18px rgba(0,0,0,.4);',
      'opacity:.72;transition:opacity .15s ease}',
      '#' + HANDLE_ID + ':hover{opacity:1}'
    ].join('') + STRUCT_CSS

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    /* ── 背景图层 ───────────────────────────────────────────────────────── */

    function ensureLayers() {
      if (!document.getElementById(BG_ID)) {
        var bg = document.createElement('div')
        bg.id = BG_ID
        bg.className = LAYER_CLASS
        document.body.appendChild(bg)
      }
      if (!document.getElementById(SCRIM_ID)) {
        var scrim = document.createElement('div')
        scrim.id = SCRIM_ID
        scrim.className = LAYER_CLASS
        document.body.appendChild(scrim)
      }
    }

    /* ── 几何对齐（与 v0.1 相同） ───────────────────────────────────────── */

    function readGeometry() {
      var sw = Math.round(window.screen ? window.screen.width : window.innerWidth)
      var sh = Math.round(window.screen ? window.screen.height : window.innerHeight)
      var wx = Math.round(typeof window.screenX === 'number' ? window.screenX : 0)
      var wy = Math.round(typeof window.screenY === 'number' ? window.screenY : 0)
      return {
        sw: sw, sh: sh, wx: wx, wy: wy,
        vw: Math.round(window.innerWidth),
        vh: Math.round(window.innerHeight),
        dpr: window.devicePixelRatio || 1
      }
    }

    function applyGeometry(force) {
      var bg = document.getElementById(BG_ID)
      var scrim = document.getElementById(SCRIM_ID)
      if (!bg || !scrim) return
      var g = readGeometry()
      var key = [g.sw, g.sh, g.wx, g.wy, g.vw, g.vh,
        state.blur, state.offsetX, state.offsetY, state.dim].join('|')
      if (!force && key === lastKey) return
      lastKey = key

      var pad = Math.max(0, state.blur) * 3
      bg.style.width = (g.sw + pad * 2) + 'px'
      bg.style.height = (g.sh + pad * 2) + 'px'
      bg.style.backgroundSize = g.sw + 'px ' + g.sh + 'px'
      bg.style.backgroundPosition = pad + 'px ' + pad + 'px'
      /* 压暗双管齐下：壁纸本身亮度衰减 + 上层黑色遮罩。
         只靠遮罩时，最深也只能盖到「黑色蒙一层」，壁纸的亮部仍会透出来；
         加上 brightness 后，压到 1.0 就是纯黑。 */
      bg.style.filter = 'blur(' + Math.max(0, state.blur) + 'px) brightness(' +
        (Math.max(0, Math.min(1, 1 - state.dim)) * 100).toFixed(1) + '%)'
      bg.style.transform =
        'translate3d(' + (-g.wx - pad + state.offsetX) + 'px,' +
        (-g.wy - pad + state.offsetY) + 'px,0)'
      scrim.style.opacity = String(Math.max(0, Math.min(1, state.dim)))

      var geo = geoEl
      if (geo) {
        var gt = 'screen ' + g.sw + '×' + g.sh + ' @' + g.dpr + 'x\n' +
          'win ' + g.wx + ',' + g.wy + '  view ' + g.vw + '×' + g.vh
        if (geo.textContent !== gt) geo.textContent = gt
      }
    }

    /* ── 分区透明度 ─────────────────────────────────────────────────────── */

    function applyRegions() {
      if (!state.enabled) return
      for (var i = 0; i < REGIONS.length; i++) {
        var r = REGIONS[i]
        var v = state.opacity[r.key]
        var nodes = null
        try {
          nodes = document.querySelectorAll(r.sel)
        } catch (e) {
          nodes = null
        }
        regionCounts[r.key] = nodes ? nodes.length : 0
        if (typeof v === 'number' && nodes) {
          var clamped = String(Math.max(0.05, Math.min(1, v)))
          for (var j = 0; j < nodes.length; j++) nodes[j].style.opacity = clamped
        }
      }
      /* 关键：这里绝不能写 DOM 文本。
         面板标签若在此更新，会触发 MutationObserver(childList) →
         再次进入 applyRegions → 再写文本 → 无限自激 → 渲染进程卡死、启动失败。
         标签更新交给 syncPanelLabels()，只在低频定时器里、且值变化时才写。 */
    }

    /** 只在值真的变化时才写 DOM，避免制造多余的 mutation。 */
    function syncPanelLabels() {
      for (var i = 0; i < REGIONS.length; i++) {
        var r = REGIONS[i]
        var el = regionLabels[r.key]
        if (!el) continue
        var n = regionCounts[r.key] || 0
        var text = n ? r.label : r.label + ' ⚠'
        if (el.textContent !== text) el.textContent = text
        var color = n ? '#cfcfd6' : '#ff8a8a'
        if (el.style.color !== color) el.style.color = color
        var tip = n ? r.label + '（匹配 ' + n + ' 个元素）'
          : r.label + '：没匹配到任何元素，告诉我实际结构我来修'
        if (el.title !== tip) el.title = tip
      }
    }

    /** 关闭时把所有区域的不透明度还回去。 */
    function clearRegions() {
      for (var i = 0; i < REGIONS.length; i++) {
        var nodes
        try {
          nodes = document.querySelectorAll(REGIONS[i].sel)
        } catch (e) {
          continue
        }
        for (var j = 0; j < nodes.length; j++) nodes[j].style.opacity = ''
      }
    }

    /* ── 壁纸 ───────────────────────────────────────────────────────────── */

    function paintWallpaper(mtimeMs) {
      var bg = document.getElementById(BG_ID)
      if (!bg) return
      bg.style.backgroundImage = 'url("' + API_IMG + '?v=' + encodeURIComponent(String(mtimeMs)) + '")'
      lastMtime = mtimeMs
      applyGeometry(true)
    }

    function refreshWallpaper() {
      try {
        var XHR = window.XMLHttpRequest || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null)
        if (!XHR) return
        var xhr = new XHR()
        xhr.open('GET', API_INFO + '?t=' + Date.now(), true)
        xhr.setRequestHeader('Cache-Control', 'no-store')
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4 || xhr.status !== 200) return
          try {
            var info = JSON.parse(xhr.responseText)
            if (info && info.ok && info.mtimeMs !== lastMtime) paintWallpaper(info.mtimeMs)
          } catch (e) { /* 忽略 */ }
        }
        xhr.onerror = function () {}
        xhr.send()
      } catch (e) { /* 网络异常不打断启动 */ }
    }

    /* ── 界面结构快照 ───────────────────────────────────────────────────── */

    /** 把当前 DOM 树压成紧凑 JSON 传给 Host 落盘。
        分区选择器对不上时，靠这份实测数据定位正确的类名。 */
    function dumpDom() {
      try {
        var XHR = window.XMLHttpRequest || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null)
        if (!XHR) return
        var MAXD = 12

        function walk(el, depth) {
          if (!el || depth > MAXD) return null
          var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null
          var cs = window.getComputedStyle ? window.getComputedStyle(el) : null
          var node = {
            t: String(el.tagName || '').toLowerCase(),
            i: el.id || '',
            c: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
            w: rect ? Math.round(rect.width) : 0,
            h: rect ? Math.round(rect.height) : 0,
            p: cs ? String(cs.position) : '',
            z: cs ? String(cs.zIndex) : '',
            bg: cs ? String(cs.backgroundColor) : ''
          }
          var da = null
          if (el.attributes) {
            for (var ai = 0; ai < el.attributes.length; ai++) {
              var a = el.attributes[ai]
              if (a && a.name && a.name.indexOf('data-') === 0) {
                da = da || {}
                da[a.name] = String(a.value).slice(0, 60)
              }
            }
          }
          if (da) node.d = da
          var kids = []
          var ch = el.children || []
          for (var ci = 0; ci < ch.length; ci++) {
            var k = walk(ch[ci], depth + 1)
            if (k) kids.push(k)
          }
          if (kids.length) node.k = kids
          return node
        }

        var body = document.body
        var payload = JSON.stringify({
          at: new Date().toISOString(),
          mode: body.getAttribute ? body.getAttribute('data-dsh-desktop-mode') : '',
          platform: body.getAttribute ? body.getAttribute('data-dsh-desktop-platform') : '',
          matchCounts: regionCounts,
          screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
          tree: walk(body, 0)
        })

        var xhr = new XHR()
        xhr.open('POST', API_DOM, true)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return
          try {
            var r2 = JSON.parse(xhr.responseText)
            if (r2 && r2.ok) console.info('[' + NS + '] 界面结构快照已保存: ' + r2.file)
          } catch (e) { /* 忽略 */ }
        }
        xhr.onerror = function () {}
        xhr.send(payload)
      } catch (e) { /* 快照失败绝不打扰用户 */ }
    }

    /* ── 自适应刷新 ─────────────────────────────────────────────────────── */

    function tick() {
      rafId = 0
      var before = lastKey
      applyGeometry(false)
      if (lastKey !== before) {
        idleFrames = 0
        rafId = window.requestAnimationFrame(tick)
      } else {
        idleFrames++
        if (idleFrames > 20) scheduleIdle()
        else rafId = window.requestAnimationFrame(tick)
      }
    }

    function scheduleIdle() {
      if (timerId) return
      timerId = window.setTimeout(function () {
        timerId = 0
        rafId = window.requestAnimationFrame(tick)
      }, 250)
    }

    function kick() {
      idleFrames = 0
      if (!rafId && !timerId) rafId = window.requestAnimationFrame(tick)
    }

    /* ── 控制面板 ───────────────────────────────────────────────────────── */

    function row(labelText, value, min, max, step, onInput) {
      var wrap = document.createElement('div')
      wrap.className = 'r'

      var lab = document.createElement('label')
      lab.textContent = labelText
      lab.title = labelText

      var input = document.createElement('input')
      input.type = 'range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(value)

      var val = document.createElement('span')
      val.className = 'v'
      val.textContent = fmt(value, step)

      input.addEventListener('input', function () {
        var n = Number(input.value)
        val.textContent = fmt(n, step)
        onInput(n)
      })

      wrap.appendChild(lab)
      wrap.appendChild(input)
      wrap.appendChild(val)
      return wrap
    }

    function fmt(v, step) {
      if (step >= 1) return String(Math.round(v))
      if (step >= 0.5) return Number(v).toFixed(1)
      return Number(v).toFixed(2)
    }


    function buildPanel() {
      if (panelEl) return
      removeHandle()
      var p = document.createElement('div')
      p.id = PANEL_ID

      var h = document.createElement('div')
      h.className = 'h'
      var title = document.createElement('b')
      title.textContent = '透明度 · 分区'
      var x = document.createElement('span')
      x.className = 'x'
      x.textContent = '×'
      x.title = '收起（Ctrl+Alt+H 重新打开）'
      x.addEventListener('click', function () {
        state.panel = false
        saveState()
        p.style.display = 'none'
        panelEl = null
        if (p.parentNode) p.parentNode.removeChild(p)
        ensureHandle()
      })
      h.appendChild(title)
      h.appendChild(x)

      var b = document.createElement('div')
      b.className = 'b'

      /* 五个分区滑块 */
      for (var i = 0; i < REGIONS.length; i++) {
        (function (r) {
          var wrap = row(r.label, state.opacity[r.key], 0.05, 1, 0.01, function (n) {
            state.opacity[r.key] = n
            applyRegions()
            saveState()
          })
          regionLabels[r.key] = wrap.children[0]
          b.appendChild(wrap)
        })(REGIONS[i])
      }

      var sep = document.createElement('div')
      sep.className = 'sep'
      b.appendChild(sep)

      b.appendChild(row('壁纸模糊', state.blur, 0, 60, 1, function (n) {
        state.blur = n
        applyGeometry(true)
        saveState()
      }))
      b.appendChild(row('背景压暗', state.dim, 0, 1, 0.01, function (n) {
        state.dim = n
        applyGeometry(true)
        saveState()
      }))

      var sep1b = document.createElement('div')
      sep1b.className = 'sep'
      b.appendChild(sep1b)

      /* 对齐微调：无边框窗口的 screenX/screenY 与视觉边框常有偏差。
         量程 ±80px，步进 0.5，足够覆盖边框/最大化外扩等常见情况。 */
      b.appendChild(row('对齐偏移 X', state.offsetX, -80, 80, 0.5, function (n) {
        state.offsetX = n
        applyGeometry(true)
        saveState()
      }))
      b.appendChild(row('对齐偏移 Y', state.offsetY, -80, 80, 0.5, function (n) {
        state.offsetY = n
        applyGeometry(true)
        saveState()
      }))
      var zeroRow = document.createElement('div')
      zeroRow.className = 'f'
      var zeroBtn = document.createElement('button')
      zeroBtn.textContent = '偏移归零'
      zeroBtn.addEventListener('click', function () {
        state.offsetX = 0
        state.offsetY = 0
        saveState()
        applyGeometry(true)
        rebuildPanelBody()
      })
      zeroRow.appendChild(zeroBtn)
      b.appendChild(zeroRow)

      var sep2 = document.createElement('div')
      sep2.className = 'sep'
      b.appendChild(sep2)

      var f = document.createElement('div')
      f.className = 'f'
      var reset = document.createElement('button')
      reset.textContent = '恢复默认'
      reset.addEventListener('click', function () {
        state = JSON.parse(JSON.stringify(DEFAULTS))
        state.panel = true
        saveState()
        rebuildPanelBody()
        applyRegions()
        applyGeometry(true)
      })
      var off = document.createElement('button')
      off.textContent = '全部还原'
      off.addEventListener('click', function () {
        state.enabled = false
        saveState()
        clearRegions()
        var bgEl = document.getElementById(BG_ID)
        if (bgEl) bgEl.style.display = 'none'
        var sc = document.getElementById(SCRIM_ID)
        if (sc) sc.style.display = 'none'
      })
      f.appendChild(reset)
      f.appendChild(off)
      b.appendChild(f)

      var tip = document.createElement('div')
      tip.className = 'tip'
      tip.textContent = '浮层调低会和底下的字叠在一起，建议保持 1.00。拖动标题可移动面板。'
      b.appendChild(tip)

      var geo = document.createElement('div')
      geo.className = 'geo'
      geoEl = geo
      b.appendChild(geo)

      p.appendChild(h)
      p.appendChild(b)
      document.body.appendChild(p)
      panelEl = p

      makeDraggable(p, h, b)
      applyGeometry(true)
    }

    function rebuildPanelBody() {
      if (!panelEl) return
      var old = panelEl
      panelEl = null
      if (old.parentNode) old.parentNode.removeChild(old)
      buildPanel()
    }

    /* ── 面板收起后的小圆点入口 ─────────────────────────────────────────── */

    function removeHandle() {
      var h = document.getElementById(HANDLE_ID)
      if (h && h.parentNode) h.parentNode.removeChild(h)
    }

    function ensureHandle() {
      if (state.panel) {
        removeHandle()
        return
      }
      if (document.getElementById(HANDLE_ID)) return
      var b = document.createElement('div')
      b.id = HANDLE_ID
      b.textContent = '⚙'
      b.title = '打开透明度面板（Ctrl+Alt+H）'
      b.addEventListener('click', function () {
        state.panel = true
        saveState()
        removeHandle()
        buildPanel()
      })
      document.body.appendChild(b)
    }

    function makeDraggable(p, handle, bodyEl) {
      handle.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.className === 'x') return
        var rect = p.getBoundingClientRect()
        dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
        p.style.right = 'auto'
        p.style.bottom = 'auto'
        p.style.left = rect.left + 'px'
        p.style.top = rect.top + 'px'
        try { handle.setPointerCapture(e.pointerId) } catch (err) {}
        e.preventDefault()
      })
      handle.addEventListener('pointermove', function (e) {
        if (!dragState) return
        p.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dragState.dx)) + 'px'
        p.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragState.dy)) + 'px'
      })
      handle.addEventListener('pointerup', function (e) {
        dragState = null
        try { handle.releasePointerCapture(e.pointerId) } catch (err) {}
      })
    }

    /* ── 键盘 ───────────────────────────────────────────────────────────── */

    function onKey(e) {
      if (!e.ctrlKey || !e.altKey) return
      var step = e.shiftKey ? 10 : 1
      var handled = true
      switch (e.key) {
        case 'ArrowLeft': state.offsetX -= step; break
        case 'ArrowRight': state.offsetX += step; break
        case 'ArrowUp': state.offsetY -= step; break
        case 'ArrowDown': state.offsetY += step; break
        case 'h': case 'H':
          state.panel = !state.panel
          saveState()
          if (state.panel) {
            removeHandle()
            buildPanel()
          } else {
            if (panelEl && panelEl.parentNode) {
              panelEl.parentNode.removeChild(panelEl)
              panelEl = null
            }
            ensureHandle()
          }
          return
        case 'd': case 'D':
          /* 手动导出界面结构快照 */
          dumpDom()
          return
        default: handled = false
      }
      if (!handled) return
      e.preventDefault()
      e.stopPropagation()
      saveState()
      applyGeometry(true)
    }

    /* ── 启动 ───────────────────────────────────────────────────────────── */

    /** 该节点是否属于本插件自己（面板 / 背景层）。用于屏蔽自激 mutation。 */
    function isOurNode(node) {
      var el = node
      if (el && el.nodeType !== 1) el = el.parentElement || el.parentNode
      var guard = 0
      while (el && guard++ < 64) {
        if (el.id === PANEL_ID || el.id === HANDLE_ID || el.id === BG_ID || el.id === SCRIM_ID || el.id === STYLE_ID) {
          return true
        }
        el = el.parentElement || el.parentNode
      }
      return false
    }

    function boot() {
      if (started) return
      if (!document.body) {
        window.addEventListener('DOMContentLoaded', boot, { once: true })
        return
      }
      started = true

      loadState()
      if (!state.enabled) return

      ensureStyle()
      ensureLayers()
      applyGeometry(true)

      resizeHandler = function () { kick() }
      window.addEventListener('resize', resizeHandler)

      /* 分区元素由 React 渲染，可能晚于插件挂载出现。
         观察器只对「非本插件节点」的变化做出反应，并且做节流 ——
         否则我们自己的面板写文本会反过来触发观察器，形成自激死循环。 */
      try {
        observer = new MutationObserver(function (records) {
          try {
            /* 节流：哪怕逻辑出错，也不可能打出高频循环 */
            var now = Date.now()
            if (now - lastObserverRun < 100) return
            for (var i = 0; i < records.length; i++) {
              if (!isOurNode(records[i].target)) {
                lastObserverRun = now
                applyRegions()
                return
              }
            }
          } catch (e) { /* 观察器内部异常绝不外溢 */ }
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (e) { /* 忽略 */ }
      applyRegions()
      syncPanelLabels()

      keyHandler = onKey
      window.addEventListener('keydown', keyHandler, true)

      try {
        pollTimer = window.setInterval(refreshWallpaper, 5000)
        /* 低频补刷：兜住观察器漏掉的情况（例如仅属性变化的弹窗） */
        syncTimer = window.setInterval(function () {
          applyRegions()
          syncPanelLabels()
        }, 1000)
      } catch (e) { /* 忽略 */ }

      if (state.panel) buildPanel()
      else ensureHandle()

      kick()
      refreshWallpaper()

      /* 等界面挂载稳定后自动导出一份结构快照，供校准选择器用 */
      try {
        window.setTimeout(dumpDom, 6000)
      } catch (e) { /* 忽略 */ }
    }

    function apply() {
      try {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', boot, { once: true })
        } else {
          boot()
        }
      } catch (err) {
        try { console.warn('[' + NS + '] 初始化失败', err) } catch (e) {}
      }

      return function dispose() {
        try {
          if (rafId) window.cancelAnimationFrame(rafId)
          if (timerId) window.clearTimeout(timerId)
          if (pollTimer) window.clearInterval(pollTimer)
          if (syncTimer) window.clearInterval(syncTimer)
          if (observer) observer.disconnect()
          if (resizeHandler) window.removeEventListener('resize', resizeHandler)
          if (keyHandler) window.removeEventListener('keydown', keyHandler, true)
          clearRegions()
          var ids = [BG_ID, SCRIM_ID, PANEL_ID, HANDLE_ID, STYLE_ID]
          for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i])
            if (el && el.parentNode) el.parentNode.removeChild(el)
          }
        } catch (e) { /* 卸载失败不影响宿主 */ }
      }
    }

    var inject = []
    exports.apply = apply
    exports.inject = inject
    exports.name = NS
    return module.exports
  }
})
