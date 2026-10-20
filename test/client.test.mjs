/**
 * 客户端测试：最小 DOM stub 跑真实 client.js
 *   1) 屏幕坐标对齐（几何）
 *   2) 分区透明度（左栏 / 对话 / 右栏 / 顶栏 / 浮层）
 */
import assert from 'node:assert/strict'

/* ── 极简 DOM ── */
const allElements = []
const createdInputs = []

/* mutation 捕获：用于检测「写 DOM → 触发观察器 → 再写 DOM」的自激死循环 */
let pendingMut = []
let textWrites = 0
const obsCallbacks = []

/* 插件对观察器做了 100ms 节流，测试若在同一毫秒内连刷会被节流挡住、
   测不出循环。用可控时钟让每轮至少推进 200ms。 */
let fakeNow = 1e12
const realDateNow = Date.now
Date.now = () => fakeNow

function flushMutations(limit = 25) {
  let rounds = 0
  while (pendingMut.length && rounds < limit) {
    fakeNow += 200
    const recs = pendingMut
    pendingMut = []
    for (let i = 0; i < obsCallbacks.length; i++) obsCallbacks[i](recs, {})
    rounds++
  }
  return rounds
}

function makeEl(tag) {
  const listeners = {}
  const attrs = {}
  const el = {
    tagName: tag,
    id: '',
    style: {},
    children: [],
    _text: '',
    value: '',
    type: '',
    title: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) },
      remove(c) { this._s.delete(c) },
      contains(c) { return this._s.has(c) }
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c },
    removeChild(c) {
      const i = el.children.indexOf(c)
      if (i >= 0) el.children.splice(i, 1)
      if (c.id && registry.get(c.id) === c) registry.delete(c.id)
      c.parentNode = null
      return c
    },
    remove() {
      if (el.id && registry.get(el.id) === el) registry.delete(el.id)
      const p = el.parentNode
      if (!p) return
      const i = p.children.indexOf(el)
      if (i >= 0) p.children.splice(i, 1)
    },
    setAttribute(k, v) { attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener(t, fn) {
      const arr = listeners[t]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    _fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev || {})) },
    _attrs: attrs,
    parentNode: null
  }
  /* 真实 DOM 里给 textContent 赋「同样的值」也会产生 childList mutation，
     桩必须照做 —— 否则测不出「重复写文本」造成的自激。 */
  Object.defineProperty(el, 'textContent', {
    get() { return el._text },
    set(v) {
      el._text = String(v)
      textWrites++
      pendingMut.push({ type: 'childList', target: el })
    }
  })
  Object.defineProperty(el, 'className', {
    get() { return Array.from(el.classList._s).join(' ') },
    set(v) {
      el.classList._s.clear()
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => el.classList._s.add(c))
    }
  })
  allElements.push(el)
  return el
}

const registry = new Map()
const body = makeEl('body')
const head = makeEl('head')

function matches(el, part) {
  part = part.trim()
  if (!part) return false
  let tag = null
  const tm = /^([a-zA-Z][\w-]*)/.exec(part)
  if (tm) { tag = tm[1].toLowerCase(); part = part.slice(tm[1].length) }
  if (tag && String(el.tagName).toLowerCase() !== tag) return false
  if (!part) return true
  if (part[0] === '.') {
    return el.classList && el.classList.contains(part.slice(1).split('.')[0])
  }
  /* [attr="value"] */
  const m = /^\[([^=\]]+)="([^"]*)"\]$/.exec(part)
  if (m) return el.getAttribute(m[1]) === m[2]
  /* [attr] 仅存在性 */
  const p = /^\[([^\]]+)\]$/.exec(part)
  if (p) return el.getAttribute(p[1]) !== null
  return false
}

function querySelectorAll(sel) {
  const parts = String(sel).split(',')
  const out = []
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i]
    if (!el.parentNode) continue          // 只算在文档里的
    for (let j = 0; j < parts.length; j++) {
      if (matches(el, parts[j])) { out.push(el); break }
    }
  }
  return out
}

const document = {
  readyState: 'complete',
  body,
  head,
  documentElement: makeEl('html'),
  createElement: (t) => {
    const el = makeEl(t)
    if (t === 'input') createdInputs.push(el)
    return el
  },
  getElementById: (id) => registry.get(id) || null,
  querySelectorAll,
  addEventListener() {}
}

const origAppend = body.appendChild.bind(body)
body.appendChild = (c) => {
  const r = origAppend(c)
  if (c.id) registry.set(c.id, c)
  return r
}

const listeners = []
const rafQueue = []

function flushAll(limit = 40) {
  for (let i = 0; i < limit; i++) {
    const fn = rafQueue.shift()
    if (!fn) break
    fn()
  }
}

const window = {
  screen: { width: 1536, height: 864 },
  screenX: 0,
  screenY: 0,
  innerWidth: 1536,
  innerHeight: 864,
  devicePixelRatio: 1.25,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
  cancelAnimationFrame: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: (t, fn) => listeners.push([t, fn]),
  removeEventListener: () => {},
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
    setItem(k, v) { this._m.set(k, v) }
  },
  __ModuleLoader__: { load(opts) { window.__loaded = opts } }
}

globalThis.window = window
globalThis.document = document
globalThis.MutationObserver = function (cb) {
  obsCallbacks.push(cb)
  this.observe = () => {}
  this.disconnect = () => {}
}

/* ── 预置真实结构（取自实测 DOM 快照） ── */
function region(tag, cls, attr) {
  const el = makeEl(tag)
  if (cls) el.className = cls
  if (attr) el.setAttribute(attr[0], attr[1])
  document.body.appendChild(el)
  return el
}

const elSidebar = region('div', 'MnhYfG_sidebarCol')
const elConversation = region('div', '_727C8a_body')
const elHeader = region('header', '_727C8a_header')
const elRightbar = region('div', 'THMRvG_panel', ['data-sidebar-right-panel', 'push'])
const elOverlay = region('div', 'MnhYfG_overlayLayer', ['data-shell-overlay', 'true'])
const elDialog = region('div', 'dshDialog')
const elPlain = region('div', 'someUnrelatedThing')

/* ── 载入真实 client.js ── */
await import('../lib/client.js')
assert.ok(window.__loaded, 'ModuleLoader 未被调用')
assert.equal(window.__loaded.id, 'dsh-desktop-transparency')

const mod = window.__loaded.factory(() => {
  throw new Error('本插件不应 require 任何模块')
})
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, [])

const ranges = () => createdInputs.filter((el) => el.type === 'range' + '')

const dispose = mod.apply({})

const bg = registry.get('dsh-dtp-bg')
assert.ok(bg, '背景层未创建')
console.log('ok  图层已创建')

/* ── 默认偏移必须为 0 ──
 * 校准值取决于窗口外框内缩与 DPI 缩放，因人而异；
 * 写死成作者本机的值会让别人的机器一装上就错位。 */
{
  const m = /translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(bg.style.transform)
  const tx = parseFloat(/translate3d\((-?[\d.]+)px/.exec(bg.style.transform)[1])
  const ty = parseFloat(m[1])
  assert.ok(Math.abs(tx + 87) < 0.001, '默认 X 偏移应为 0，实际 tx=' + tx)
  assert.ok(Math.abs(ty + 87) < 0.001, '默认 Y 偏移应为 0，实际 ty=' + ty)
  console.log('ok  默认偏移为 0（校准值由用户自调）')
}

/* ── 一、几何对齐 ── */

function imageOriginOnScreen() {
  const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(bg.style.transform)
  assert.ok(m, 'transform 解析失败: ' + bg.style.transform)
  const [bpx, bpy] = bg.style.backgroundPosition.split(' ').map((s) => parseFloat(s))
  return {
    ox: window.screenX + parseFloat(m[1]) + bpx,
    oy: window.screenY + parseFloat(m[2]) + bpy,
    tx: parseFloat(m[1]),
    ty: parseFloat(m[2])
  }
}

const cases = [
  { x: 0, y: 0, label: '窗口在原点' },
  { x: 300, y: 150, label: '窗口居中偏移' },
  { x: -200, y: -80, label: '窗口移出左上' },
  { x: 1200, y: 700, label: '窗口贴右下' }
]

for (const c of cases) {
  window.screenX = c.x
  window.screenY = c.y
  const fn = listeners.filter(([t]) => t === 'resize').pop()
  assert.ok(fn, 'resize 监听器未注册')
  fn[1]()
  flushAll()
  const o = imageOriginOnScreen()
  assert.ok(Math.abs(o.ox) < 0.001, `${c.label}: X 偏移 ${o.ox}`)
  assert.ok(Math.abs(o.oy) < 0.001, `${c.label}: Y 偏移 ${o.oy}`)
  console.log(`ok  ${c.label}  屏幕(${c.x},${c.y}) → tx=${o.tx} ty=${o.ty}`)
}

/* 窗口缩放不得拉伸背景 */
window.screenX = 0
window.screenY = 0
window.innerWidth = 800
window.innerHeight = 600
{
  const fn = listeners.filter(([t]) => t === 'resize').pop()
  fn[1]()
  flushAll()
  /* 默认模糊 29px → 四周外扩 3 倍 = 87px，用于吸收模糊边缘 */
  const pad = 29 * 3
  assert.equal(bg.style.width, (1536 + pad * 2) + 'px', '元素宽应为屏幕宽 + 模糊余量')
  assert.equal(bg.style.height, (864 + pad * 2) + 'px', '元素高应为屏幕高 + 模糊余量')
  assert.equal(bg.style.backgroundSize, '1536px 864px', 'background-size 必须等于屏幕尺寸')
  console.log('ok  窗口 800×600 时背景仍按 1536×864 排版（外扩 ' + pad + 'px 吸收模糊）')
}

/* ── 二、分区透明度 ── */

assert.equal(elSidebar.style.opacity, '0.81', '左栏默认透明度不对')
assert.equal(elConversation.style.opacity, '0.6', '对话区默认透明度不对')
assert.equal(elHeader.style.opacity, '0.86', '顶栏默认透明度不对')
assert.equal(elRightbar.style.opacity, '0.66', '右栏默认透明度不对')
assert.equal(elOverlay.style.opacity, '0.96', '浮层默认透明度不对')
assert.equal(elPlain.style.opacity, undefined, '无关元素不得被改动')
console.log('ok  五个分区各按默认值取到独立透明度，无关元素未受影响')

/* 顶栏与对话区互不干扰（这是用户抱怨的重点） */
assert.notEqual(elHeader.style.opacity, elConversation.style.opacity,
  '顶栏与对话区应有不同的默认值')
console.log('ok  顶栏与对话区互不干扰')

/* 拖动左栏滑块只改左栏 */
{
  const slider = ranges()[0]
  assert.ok(slider, '未找到左栏滑块')
  slider.value = '0.30'
  slider._fire('input')
  assert.equal(elSidebar.style.opacity, '0.3', '左栏未被更新')
  assert.equal(elConversation.style.opacity, '0.6', '对话区被误改')
  assert.equal(elHeader.style.opacity, '0.86', '顶栏被误改')
  assert.equal(elOverlay.style.opacity, '0.96', '浮层被误改')
  console.log('ok  拖动「左侧栏」滑块仅影响左栏')
}

/* 拖动顶栏滑块只改顶栏（第 3 个滑块） */
{
  const headerSlider = ranges()[2]
  assert.ok(headerSlider, '未找到顶栏滑块')
  headerSlider.value = '0.40'
  headerSlider._fire('input')
  assert.equal(elHeader.style.opacity, '0.4', '顶栏未被更新')
  assert.equal(elConversation.style.opacity, '0.6', '对话区被误改')
  console.log('ok  拖动「顶栏」滑块仅影响顶栏')
}

/* 把浮层调低 → 确实生效 */
{
  const overlaySlider = ranges()[4]
  overlaySlider.value = '0.50'
  overlaySlider._fire('input')
  assert.equal(elOverlay.style.opacity, '0.5')
  console.log('ok  「浮层 / 弹窗」滑块生效')
}

/* 对齐偏移滑块（面板上第 8、9 个滑块） */
{
  window.screenX = 100
  window.screenY = 50
  const rl = listeners.filter(([t]) => t === 'resize').pop()
  rl[1]()
  flushAll()

  const base = imageOriginOnScreen()
  assert.ok(Math.abs(base.ox) < 0.001, '初始原点应为 0')

  const sx = ranges()[7]
  const sy = ranges()[8]
  assert.ok(sx && sy, '未找到偏移滑块')

  sx.value = '2.5'
  sx._fire('input')
  sy.value = '-1.5'
  sy._fire('input')

  const after = imageOriginOnScreen()
  assert.ok(Math.abs(after.ox - 2.5) < 0.001, 'X 偏移未生效: ' + after.ox)
  assert.ok(Math.abs(after.oy + 1.5) < 0.001, 'Y 偏移未生效: ' + after.oy)
  console.log('ok  对齐偏移滑块生效（+2.5 / -1.5 px）')

  /* 归零 */
  sx.value = '0'
  sx._fire('input')
  sy.value = '0'
  sy._fire('input')
  const back = imageOriginOnScreen()
  assert.ok(Math.abs(back.ox) < 0.001 && Math.abs(back.oy) < 0.001, '归零失败')
  console.log('ok  偏移归零后原点回到 (0,0)')

  /* 量程边界：滑块必须能到 ±80 */
  sx.value = '80'
  sx._fire('input')
  const far = imageOriginOnScreen()
  assert.ok(Math.abs(far.ox - 80) < 0.001, '量程上限未生效: ' + far.ox)
  sx.value = '-80'
  sx._fire('input')
  const farNeg = imageOriginOnScreen()
  assert.ok(Math.abs(farNeg.ox + 80) < 0.001, '量程下限未生效: ' + farNeg.ox)
  console.log('ok  偏移量程两端 ±80 均可用')

  /* 面板不应再有数值输入框 */
  const nums = createdInputs.filter((el) => el.type === 'number')
  assert.equal(nums.length, 0, '数值输入框应已移除，实际还有 ' + nums.length + ' 个')
  console.log('ok  数值输入框已移除')

  /* 归零，避免影响后续用例 */
  sx.value = '0'
  sx._fire('input')
}

/* ── 四、自激死循环回归测试 ──────────────────────────────────────────────
 * 历史事故：v0.3.0 在 applyRegions() 里更新面板标签文本，
 * 面板文本变化触发 MutationObserver → 再调 applyRegions → 再写文本 →
 * 无限自激，渲染进程 CPU 打满、页面加载超时（ERR_FAILED），桌面端起不来。
 * 这条测试就是钉住这个 bug。 */
{
  /* 先排干启动阶段产生的 mutation */
  flushMutations()
  pendingMut = []
  textWrites = 0

  /* 模拟 React 新插入一个分区节点（外部变化，应当被观察器看到） */
  const extra = makeEl('div')
  extra.className = 'dshDesktopOverlay'
  document.body.appendChild(extra)
  pendingMut.push({ type: 'childList', target: document.body })

  const rounds = flushMutations()
  assert.ok(rounds <= 3, '观察器被反复触发 ' + rounds + ' 轮，疑似自激')
  assert.equal(textWrites, 0,
    '稳定状态下面板文本被重写 ' + textWrites + ' 次 —— 自激死循环复发')
  console.log('ok  外部 DOM 变化不引发自激（观察器 ' + rounds + ' 轮，文本重写 ' + textWrites + ' 次）')

  /* 面板自身的变化必须被忽略，不能反过来再触发一轮 */
  textWrites = 0
  pendingMut = []
  const panel = registry.get('dsh-dtp-panel')
  assert.ok(panel, '面板未创建')
  const label = panel.children[1].children[0].children[0]
  label.textContent = '自己改自己'
  pendingMut.push({ type: 'childList', target: label })
  flushMutations()
  assert.equal(textWrites, 1, '面板自身的 mutation 被重复处理了')
  console.log('ok  面板自身 mutation 被正确忽略')
}

/* ── 五、面板收起 / 找回 ───────────────────────────────────────────────── */
{
  const panel = registry.get('dsh-dtp-panel')
  assert.ok(panel, '面板未创建')

  /* 点 × 收起 */
  const header = panel.children[0]
  const closeBtn = header.children[1]
  assert.equal(closeBtn.className, 'x', '关闭按钮位置不对')
  closeBtn._fire('click')
  assert.equal(registry.get('dsh-dtp-panel'), undefined, '面板未收起')
  assert.ok(registry.get('dsh-dtp-handle'), '收起后应出现找回圆点')
  console.log('ok  收起面板后出现找回圆点')

  /* 点圆点找回 */
  registry.get('dsh-dtp-handle')._fire('click')
  assert.ok(registry.get('dsh-dtp-panel'), '圆点未能重新打开面板')
  assert.equal(registry.get('dsh-dtp-handle'), undefined, '重开后圆点应移除')
  console.log('ok  点击圆点可重新打开面板')
}

/* ── 三、卸载还原 ── */
{
  dispose()
  assert.equal(registry.get('dsh-dtp-bg'), undefined, '背景层未移除')
  assert.equal(elSidebar.style.opacity, '', '左栏不透明度未还原')
  assert.equal(elHeader.style.opacity, '', '顶栏不透明度未还原')
  console.log('ok  卸载后节点清除且所有分区还原')
}

console.log('\n全部通过')
