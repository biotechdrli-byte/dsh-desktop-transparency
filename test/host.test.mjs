/**
 * Host 半侧冒烟测试：用假的 ctx / webServer 跑真实代码，
 * 验证壁纸发现、mime 识别、两条路由的响应。
 */
import assert from 'node:assert/strict'

const routes = new Map()
const fakeWebServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  }
}
const ctx = {
  get(name) {
    if (name === 'webServer') return fakeWebServer
    if (name === 'connection') return { requestRejection: () => false }
    return undefined
  },
  logger: { warn: () => {} }
}

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-desktop-transparency')
assert.deepEqual(mod.inject, ['webServer', 'connection'])

mod.apply(ctx)

/* ── 路由已注册 ── */
assert.ok(routes.has('/dsh-bg/info'), '缺少 /dsh-bg/info')
assert.ok(routes.has('/dsh-bg/wallpaper'), '缺少 /dsh-bg/wallpaper')
console.log('ok  注册两条路由')

/* ── 假 res ── */
function makeRes() {
  const r = { statusCode: 0, headers: null, body: null, ended: false }
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers || {} }
  r.end = (body) => { r.body = body; r.ended = true; return undefined }
  r.setHeader = () => {}
  return r
}

/* ── /info ── */
{
  const res = makeRes()
  await routes.get('/dsh-bg/info').handler({ url: '/dsh-bg/info', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const info = JSON.parse(res.body.toString('utf8'))
  assert.equal(info.ok, true, '未找到壁纸: ' + JSON.stringify(info))
  assert.ok(info.mtimeMs > 0, 'mtime 无效')
  assert.ok(info.size > 1000, '文件太小')
  assert.match(info.mime, /^image\//)
  console.log('ok  /info →', info.mime, Math.round(info.size / 1024) + 'KB')
  console.log('    file =', info.file)
}

/* ── /wallpaper ── */
{
  const res = makeRes()
  await routes.get('/dsh-bg/wallpaper').handler({ url: '/dsh-bg/wallpaper', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.ok(Buffer.isBuffer(res.body), '响应体不是 Buffer')
  /* JPEG: FF D8 FF */
  assert.equal(res.body[0], 0xFF, '不是 JPEG 头')
  assert.equal(res.body[1], 0xD8, '不是 JPEG 头')
  console.log('ok  /wallpaper →', Math.round(res.body.length / 1024) + 'KB, JPEG 头正确')
}

/* ── 信任栅栏：被拒时不得继续 ── */
{
  const denyCtx = {
    get(name) {
      if (name === 'webServer') return fakeWebServer
      if (name === 'connection') return { requestRejection: () => 401 }
      return undefined
    },
    logger: { warn: () => {} }
  }
  const denyRoutes = new Map()
  const denyServer = {
    register(r) { denyRoutes.set(r.path, r); return () => {} }
  }
  denyCtx.get = (n) => n === 'webServer' ? denyServer : (n === 'connection' ? { requestRejection: () => 401 } : undefined)
  mod.apply(denyCtx)

  const res = makeRes()
  await denyRoutes.get('/dsh-bg/wallpaper').handler({ url: '/dsh-bg/wallpaper', headers: {} }, res)
  assert.equal(res.statusCode, 401, '信任栅栏未生效')
  assert.equal(res.body, undefined, '被拒后不应写 body')
  console.log('ok  信任栅栏 → 401 且未泄露内容')
}

/* ── /_dom 界面结构快照 ── */
{
  const res = makeRes()
  const payload = { at: 'test', matchCounts: { sidebar: 0 }, tree: { t: 'body' } }
  const req = {
    method: 'POST',
    headers: {},
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(payload)))
      if (ev === 'end') fn()
    },
    destroy() {}
  }
  await routes.get('/dsh-bg/_dom').handler(req, res)
  assert.equal(res.statusCode, 200)
  const out = JSON.parse(res.body.toString('utf8'))
  assert.equal(out.ok, true, '快照未保存: ' + JSON.stringify(out))
  assert.ok(out.file && out.file.endsWith('dsh-dtp-dom.json'), '落盘路径不对')
  console.log('ok  /_dom 快照已落盘 →', out.file, '(' + out.bytes + ' bytes)')
}

/* ── 没有 webServer 时不得抛异常 ── */
{
  const bare = { get: () => undefined, webServer: undefined, logger: { warn: () => {} } }
  assert.doesNotThrow(() => mod.apply(bare))
  console.log('ok  无 webServer 时安全降级')
}

console.log('\n全部通过')
