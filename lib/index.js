/* ============================================================================
 * dsh-desktop-transparency — Host 半侧
 * ----------------------------------------------------------------------------
 * 只做两件事：
 *   1) 找到 Windows 当前正在显示的桌面壁纸文件
 *   2) 通过两条路由把它交给浏览器半侧
 *        GET /dsh-bg/info        → { ok, file, mtimeMs, size, mime }
 *        GET /dsh-bg/wallpaper   → 图片字节（no-store，靠 ?v=mtime 破缓存）
 *
 * 为什么用 TranscodedWallpaper：
 *   Windows 实际绘制到屏幕上的是 %APPDATA%\Microsoft\Windows\Themes\
 *   TranscodedWallpaper —— 它是系统按「填充方式」处理过之后的成品。
 *   直接用它，和真实桌面的一致性最高；注册表里的 Wallpaper 只作兜底。
 *
 * 壁纸轮换（Windows 聚焦 / 幻灯片）时文件内容变化但路径不变，
 * 所以靠 mtime 判断，浏览器半侧轮询 /info 即可跟上。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const NS = 'dsh-desktop-transparency'
const ROUTE_BASE = '/dsh-bg'

const APP_DATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const TRANSCODED = path.join(APP_DATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')

const name = NS
const inject = ['webServer', 'connection']

/* ── 壁纸发现 ───────────────────────────────────────────────────────────── */

/** 读注册表里的原图路径（可能是任意扩展名，也可能被 %% 展开）。 */
function registryWallpaper() {
  return new Promise((resolve) => {
    try {
      execFile(
        'reg',
        ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          const m = /Wallpaper\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(stdout)
          if (!m) return resolve(null)
          const raw = m[1].trim()
          resolve(raw ? path.normalize(raw) : null)
        }
      )
    } catch (err) {
      resolve(null)
    }
  })
}

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile()
  } catch (err) {
    return false
  }
}

/** 按优先级挑一个真实存在的壁纸文件。 */
async function findWallpaper() {
  if (isFile(TRANSCODED)) return TRANSCODED
  const reg = await registryWallpaper()
  if (isFile(reg)) return reg
  return null
}

/** 按magic bytes判断图片类型（TranscodedWallpaper 没有扩展名）。 */
function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E) return 'image/png'
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42) return 'image/webp'
  return 'application/octet-stream'
}

/** 缓存：壁纸没换就不重复读盘。 */
const cache = { file: null, mtimeMs: 0, buf: null, mime: 'image/jpeg' }

function loadWallpaper(file) {
  const st = fs.statSync(file)
  if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.buf) return cache
  const buf = fs.readFileSync(file)
  cache.file = file
  cache.mtimeMs = st.mtimeMs
  cache.buf = buf
  cache.mime = sniffMime(buf)
  return cache
}

/* ── 插件入口 ───────────────────────────────────────────────────────────── */

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch (err) { /* 取不到就当没有 */ }
  return ctx.webServer
}

function hasRoutes(server) {
  return !!server && typeof server.register === 'function'
}

function apply(ctx) {
  const webServer = resolveWebServer(ctx)

  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.('[' + NS + '] 当前 profile 没有可用的 webServer，界面背景将无法加载。')
    } catch (err) { /* 日志失败不影响加载 */ }
    return
  }

  /** 信任栅栏：自定义路由必须过一遍，否则任意网页都能读你的壁纸。 */
  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) {
      return false
    }
  }

  function registerRoute(route) {
    const inner = route && route.handler
    const wrapped = Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      }
    })
    return webServer.register(wrapped)
  }

  function sendJson(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length)
    })
    res.end(body)
  }

  function readBody(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          req.destroy()
          resolve('')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  /** 界面结构快照落盘：优先 DSH_HOME（路径稳定好找），写不了就退到临时目录。 */
  function dumpCandidates() {
    return [
      path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-dtp-dom.json'),
      path.join(os.tmpdir(), 'dsh-dtp-dom.json')
    ]
  }

  function writeDump(text) {
    let lastErr = null
    const list = dumpCandidates()
    for (let i = 0; i < list.length; i++) {
      try {
        fs.writeFileSync(list[i], text, 'utf8')
        return list[i]
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new Error('no writable location')
  }

  /* 壁纸元信息：浏览器半侧轮询它来判断壁纸有没有换过。 */
  registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/info',
    handler: async (req, res) => {
      try {
        const file = await findWallpaper()
        if (!file) return sendJson(res, 200, { ok: false, reason: 'wallpaper-not-found' })
        const entry = loadWallpaper(file)
        sendJson(res, 200, {
          ok: true,
          file: entry.file,
          mtimeMs: entry.mtimeMs,
          size: entry.buf.length,
          mime: entry.mime
        })
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String(err && err.message || err) })
      }
    }
  })

  /* 壁纸本体。 */
  registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/wallpaper',
    handler: async (req, res) => {
      try {
        const file = await findWallpaper()
        if (!file) {
          res.writeHead(404, { 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        const entry = loadWallpaper(file)
        res.writeHead(200, {
          'Content-Type': entry.mime,
          'Cache-Control': 'no-store',
          'Content-Length': String(entry.buf.length)
        })
        res.end(entry.buf)
      } catch (err) {
        try {
          res.writeHead(500, { 'Cache-Control': 'no-store' })
          res.end()
        } catch (e) { /* 连接已断 */ }
      }
    }
  })

  /* 界面结构快照：浏览器半侧把 DOM 树 POST 上来，这里写盘。
     用于确认分区选择器在不同 desktop mode（compatibility / extended / advanced）
     下到底应该怎么写 —— 选择器要实测，不靠猜。 */
  registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/_dom',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          const list = dumpCandidates()
          sendJson(res, 200, { ok: true, file: list[0], exists: fs.existsSync(list[0]) })
          return
        }
        const text = await readBody(req)
        if (!text) {
          sendJson(res, 400, { ok: false, reason: 'empty-body' })
          return
        }
        JSON.parse(text) // 先校验，避免把半截垃圾写进文件
        const saved = writeDump(text)
        sendJson(res, 200, { ok: true, file: saved, bytes: Buffer.byteLength(text) })
      } catch (err) {
        sendJson(res, 500, { ok: false, reason: String(err && err.message || err) })
      }
    }
  })
}

export { apply, inject, name }
