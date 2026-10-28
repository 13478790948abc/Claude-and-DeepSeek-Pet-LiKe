// =============================================================================
// Claude × DeepSeek 桌宠 · Host 半（profile bundle，非会话级动态插件）
//
// 职责：
//   1. 读取本包 assets/ 下的精灵图与两段音效，通过 webServer 注册 exact 路由
//   2. 由 Harness 的 agent 事件（agent/status、agent/error、approval/request、
//      user-questions/request）推导一个桌宠状态机，外加 500ms 的 agents 轮询兜底
//   3. 通过 GET /duo-pet/state 把该状态机暴露给浏览器端（Client 半轮询）
//   4. spawn desktop/pet-overlay.ps1（Windows WPF 悬浮窗），让桌宠在 DSH 主窗口
//      最小化/隐藏时仍然显示在桌面上；非 Windows 或 spawn 失败时自动跳过
//
// 契约：D:\plugging\.dsh-duo-pet\SPEC.md §6。素材缺失时只降级、不抛错。
// =============================================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(BUNDLE_DIR, 'assets')
const DESKTOP_DIR = join(BUNDLE_DIR, 'desktop')
const OVERLAY_SCRIPT = join(DESKTOP_DIR, 'pet-overlay.ps1')
const WINDOW_PROBE_SCRIPT = join(DESKTOP_DIR, 'window-probe.ps1')
const ROUTE_PREFIX = '/duo-pet'
const POLL_MS = 500

// 素材修订号：写进 spriteUrl 的 query，方便以后换图时让浏览器绕过缓存。
// v4 = 当前美术（超 Q 重绘 + 两套新造型）；state 里的 `revision` 与 spriteUrl 的 `?rev=2` 必须一致。
const REVISION = 2
const SPRITE_URL = `${ROUTE_PREFIX}/spritesheet.png?rev=${REVISION}`
const SALLY_URL = `${ROUTE_PREFIX}/sally.mp3`
const DONE_URL = `${ROUTE_PREFIX}/done.mp3`

/** Read one packaged asset; a missing asset degrades the pet instead of failing the Host.
 *  Cached by (mtime, size) so replacing a file on disk is picked up on the next request
 *  without restarting / re-applying the plugin (used for art iterations). */
const assetCache = new Map()
const warnedMissing = new Set()
const loadAsset = (name) => {
  try {
    const path = join(ASSET_DIR, name)
    const info = statSync(path)
    const key = `${info.mtimeMs}:${info.size}`
    const cached = assetCache.get(name)
    if (cached !== undefined && cached.key === key) return cached.bytes
    const bytes = readFileSync(path)
    assetCache.set(name, { key, bytes })
    warnedMissing.delete(name)
    return bytes
  } catch (error) {
    if (!warnedMissing.has(name)) {
      warnedMissing.add(name)
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[duo-pet] cannot read assets/${name}: ${reason}`)
    }
    return null
  }
}

/**
 * Normalize an agent reference to a stable Map key. Events may hand us an id string,
 * a number, or an agent object; the 500ms poll hands us objects. Without normalization
 * the same agent would occupy two different Map slots and celebrate logic would drift.
 */
const agentKey = (agent) => {
  if (agent === undefined || agent === null) return null
  const type = typeof agent
  if (type === 'string' || type === 'number') return String(agent)
  if (type === 'object') {
    for (const field of ['id', 'agentId', 'key', 'name', 'sessionId']) {
      const value = agent[field]
      if (typeof value === 'string' || typeof value === 'number') return String(value)
    }
    return agent
  }
  return null
}

export const inject = ['webServer']

/**
 * Start the desktop overlay process (WPF via Windows PowerShell).
 *
 * The overlay is a separate always-on-top window, so the pet stays on the desktop
 * while the DSH main window is minimized. Everything here is best effort: a missing
 * script, no origin, a non-Windows platform or a failed spawn must never affect the
 * in-window pet or the Host. Returns a stop function (safe to call more than once).
 */
function startDesktopOverlay(webServer) {
  const noop = () => {}
  if (!existsSync(OVERLAY_SCRIPT)) {
    console.error('[duo-pet] desktop/pet-overlay.ps1 is missing; the desktop pet was not started')
    return noop
  }

  let origin
  try {
    origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
  } catch (error) {
    origin = undefined
  }
  if (typeof origin !== 'string' || origin.length === 0) {
    console.error('[duo-pet] webServer origin is unavailable; the desktop pet was not started')
    return noop
  }

  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const systemPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const executable = existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe'
  const logPath = join(tmpdir(), 'dsh-duo-pet-overlay.log')
  const args = [
    '-STA',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', OVERLAY_SCRIPT,
    '-Origin', origin,
    '-HostPid', String(process.pid),
    '-DshPid', String(process.ppid ?? 0),
    '-TitleHint', 'DeepSeek Harness,DSH',
    '-LogPath', logPath,
  ]

  let child
  try {
    child = spawn(executable, args, {
      cwd: DESKTOP_DIR,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    console.error('[duo-pet] failed to spawn the desktop overlay:', error)
    return noop
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      child.kill()
    } catch (error) {
      // the overlay process may already be gone
    }
  }

  child.on('error', (error) => {
    console.error('[duo-pet] desktop overlay process error:', error)
  })
  child.on('exit', (code, signal) => {
    console.log(`[duo-pet] desktop overlay exited (code=${String(code)}, signal=${String(signal)})`)
  })

  console.log(`[duo-pet] desktop overlay started (pid ${String(child.pid)}) against ${origin}`)
  return stop
}

let windowActionSeq = 0

/**
 * Run window-probe.ps1 in its CLI action mode (minimize/restore). Resolves to
 * { ok, found, minimized } and never rejects: a missing window, timeout or failed
 * spawn all degrade to ok:false so the HTTP route can always answer.
 *
 * The child writes its JSON result to a temp file and is spawned with stdio:'ignore'
 * (piped stdio is blocked in the sandboxed Host: spawn EPERM on named pipes).
 */
function runWindowProbeAction(action) {
  const empty = { ok: false, found: false, minimized: false }
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(empty)
      return
    }
    if (!existsSync(WINDOW_PROBE_SCRIPT)) {
      console.error('[duo-pet] desktop/window-probe.ps1 is missing; window action skipped')
      resolve(empty)
      return
    }
    windowActionSeq += 1
    const resultPath = join(tmpdir(), `duo-pet-window-${String(process.pid)}-${String(windowActionSeq)}.json`)
    try { unlinkSync(resultPath) } catch (error) { /* no stale file */ }
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', WINDOW_PROBE_SCRIPT,
        '-Action', action,
        '-DshPid', '0',
        '-TitleHint', 'DeepSeek Harness,DSH',
        '-ResultPath', resultPath,
      ], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      console.error('[duo-pet] failed to spawn window-probe action:', error)
      resolve(empty)
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { unlinkSync(resultPath) } catch (error) { /* already gone */ }
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (error) { /* already gone */ }
      finish(empty)
    }, 8000)
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error('[duo-pet] window-probe action error:', error)
      finish(empty)
    })
    child.on('close', () => {
      clearTimeout(timer)
      let parsed = null
      try {
        const text = readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')
        parsed = JSON.parse(text)
      } catch (error) {
        parsed = null
      }
      finish({
        ok: parsed !== null && parsed.ok === true,
        found: parsed !== null && parsed.found === true,
        minimized: parsed !== null && parsed.minimized === true,
      })
    })
  })
}

export function apply(ctx) {
  // Resolve a service through ctx.get first (the Cordis accessor) and fall back to a
  // direct property so fake/test contexts and compatible builds both work.
  const getService = (name) => {
    if (typeof ctx.get === 'function') {
      try {
        const service = ctx.get(name)
        if (service !== undefined && service !== null) return service
      } catch (error) {
        // fall through to the direct property
      }
    }
    try {
      return ctx[name]
    } catch (error) {
      return undefined
    }
  }

  const webServer = getService('webServer')
  if (webServer === undefined || webServer === null) {
    console.error('[duo-pet] webServer service is unavailable; the pet cannot serve its assets')
    return
  }

  const sprite = loadAsset('spritesheet.png')
  const sally = loadAsset('sally.mp3')
  const done = loadAsset('done.mp3')
  if (sprite !== null) console.log(`[duo-pet] spritesheet loaded: ${sprite.length} bytes`)
  else console.error('[duo-pet] assets/spritesheet.png is missing; the Client will show its emoji fallback')
  if (sally !== null) console.log(`[duo-pet] sally.mp3 loaded: ${sally.length} bytes`)
  else console.error('[duo-pet] assets/sally.mp3 is missing; the waiting sound is disabled')
  if (done !== null) console.log(`[duo-pet] done.mp3 loaded: ${done.length} bytes`)
  else console.error('[duo-pet] assets/done.mp3 is missing; the Client will fall back to speechSynthesis')

  // ---------- pet state machine (process-wide, shared by every session) ----------
  let mode = 'idle'
  let seq = 0
  let waitingSeq = 0
  let celebrateSeq = 0
  let waiting = 0
  // Page-side audio ownership signal (POST /duo-pet/page-visibility). Default true:
  // the in-page pet may play sounds until the browser reports that its page is hidden.
  let pageVisible = true
  let pageVisibleAt = 0
  // Desktop overlay options, shared with the Client/page menu and the overlay menu.
  // Defaults match the overlay's own startup defaults (topmost on, always-show off).
  let overlayTopmost = true
  let overlayAlwaysShow = false

  const statuses = new Map() // agentKey -> 'running' | 'idle'
  const errored = new Set() // agentKey of agents whose last run errored

  const runningCount = () => {
    let total = 0
    for (const status of statuses.values()) if (status === 'running') total += 1
    return total
  }

  const bumpSeq = () => {
    seq += 1
  }

  const setMode = (next) => {
    if (next === mode) return
    mode = next
    bumpSeq()
  }

  const deriveMode = () => {
    if (waiting > 0) setMode('waiting')
    else if (runningCount() > 0) setMode('working')
    else setMode('idle')
  }

  const applyStatus = (agent, status) => {
    if (status !== 'running' && status !== 'idle') return
    const key = agentKey(agent)
    if (key === null) return
    const previous = statuses.get(key)
    if (previous === status) return
    statuses.set(key, status)
    if (previous === 'running' && status === 'idle') {
      const failed = errored.has(key)
      // Celebrate only when that agent finished cleanly, nothing else is running and
      // the user is not being asked anything. `waiting` must be read after the update.
      const celebrate = !failed && runningCount() === 0 && waiting === 0
      errored.delete(key)
      if (celebrate) {
        celebrateSeq += 1
        bumpSeq()
      }
    } else if (status === 'idle' && errored.has(key)) {
      // Settled without an observed running state: drop the stale error flag.
      errored.delete(key)
    }
    deriveMode()
  }

  // ---------- event sources ----------

  // Authoritative live status transitions.
  ctx.on('agent/status', (payload) => {
    if (payload === undefined || payload === null) return
    try {
      applyStatus(payload.agent, payload.status)
    } catch (error) {
      // a malformed payload must never break the Host
    }
  })

  // A step/turn failed: flag the agent so its settle shows no celebration.
  ctx.on('agent/error', (payload) => {
    let agent
    try {
      agent = payload !== null && typeof payload === 'object' ? payload.agent : payload
    } catch (error) {
      agent = undefined
    }
    const key = agentKey(agent)
    if (key !== null) errored.add(key)
  })

  const beginWaiting = () => {
    waiting += 1
    waitingSeq += 1
    bumpSeq()
    deriveMode()
  }

  const endWaiting = () => {
    waiting = Math.max(0, waiting - 1)
    deriveMode()
  }

  // Waterfall handler shared by approvals and user questions (SPEC §6): count the wait
  // before calling `next()`, count it back on settle, and return `next()`'s Promise
  // untouched so the dispatcher's behavior does not change.
  const waitForHuman = (request, next) => {
    beginWaiting()
    let result
    try {
      result = typeof next === 'function' ? next() : undefined
    } catch (error) {
      endWaiting()
      throw error
    }
    Promise.resolve(result).then(endWaiting, endWaiting)
    return result
  }

  ctx.on('approval/request', waitForHuman)
  ctx.on('user-questions/request', waitForHuman)

  // Compatibility fallback: some builds only expose `agent.status`. Accept exact
  // 'running' / 'idle' values only; anything else must not force a false idle.
  const poll = () => {
    const agents = getService('agents')
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return
    let list
    try {
      list = agents.list()
    } catch (error) {
      return
    }
    if (!Array.isArray(list)) return
    for (const agent of list) {
      try {
        applyStatus(agent, agent === undefined || agent === null ? undefined : agent.status)
      } catch (error) {
        // individual agents may be mid-initialization; ignore and keep polling
      }
    }
  }
  poll()
  const pollTimer = setInterval(poll, POLL_MS)

  // ---------- HTTP surface ----------

  // Per-file content stamp: put it in the sprite URL so replacing the PNG on disk makes
  // both the Host (lazy read) and every already-loaded Client fetch the new art on the
  // next poll — no re-install and no hard refresh needed for art-only updates.
  const assetStamp = (name) => {
    try {
      const info = statSync(join(ASSET_DIR, name))
      return `${Math.round(info.mtimeMs)}-${info.size}`
    } catch (error) {
      return null
    }
  }
  const assetUrl = (name, baseUrl) => {
    if (loadAsset(name) === null) return null
    const stamp = assetStamp(name)
    if (stamp === null) return baseUrl
    const separator = baseUrl.indexOf('?') === -1 ? '?' : '&'
    return `${baseUrl}${separator}h=${stamp}`
  }

  // Lightweight request counters: the Client polls /state every 500ms, so a rising
  // counter proves the browser half is alive (used for live diagnostics).
  let stateHits = 0
  let spriteHits = 0

  const snapshot = () => ({
    mode,
    seq,
    waitingSeq,
    celebrateSeq,
    waiting,
    running: runningCount(),
    revision: REVISION,
    spriteUrl: assetUrl('spritesheet.png', SPRITE_URL),
    sallyUrl: loadAsset('sally.mp3') === null ? null : SALLY_URL,
    doneUrl: loadAsset('done.mp3') === null ? null : DONE_URL,
    pageVisible,
    pageVisibleAt,
    overlayTopmost,
    overlayAlwaysShow,
    hits: { state: stateHits, sprite: spriteHits },
  })

  const sendJson = (response, body) => {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
    })
    response.end(body)
  }

  const sendJsonStatus = (response, statusCode, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload)
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
    }
    for (const [key, value] of Object.entries(extraHeaders || {})) headers[key] = value
    response.writeHead(statusCode, headers)
    response.end(body)
  }

  // Read a small JSON request body without ever rejecting (invalid input => null).
  const readJsonBody = (request, limitBytes) => new Promise((resolve) => {
    const chunks = []
    let total = 0
    let tooLarge = false
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) { finish(null); return }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        finish(text === '' ? null : JSON.parse(text))
      } catch (error) {
        finish(null)
      }
    })
    request.on('error', () => finish(null))
    request.on('aborted', () => finish(null))
  })

  const sendBytes = (response, contentType, bytes) => {
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=86400',
    })
    response.end(bytes)
  }

  // Asset routes re-read the file (mtime/size cached), so replacing art on disk is
  // served on the next request without re-installing the bundle.
  const registerAssetRoute = (path, contentType, assetName) => webServer.register({
    kind: 'exact',
    path,
    handler: (request, response) => {
      if (assetName === 'spritesheet.png') spriteHits += 1
      const bytes = loadAsset(assetName)
      if (bytes === null) {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(`${assetName} is unavailable`)
        return
      }
      sendBytes(response, contentType, bytes)
    },
  })

  const routes = [webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (request, response) => {
      stateHits += 1
      sendJson(response, JSON.stringify(snapshot()))
    },
  })]

  // Client half reports whether its page can play sounds. This lets the desktop
  // overlay decide who owns audio: page hidden => overlay plays (even while its own
  // window is hidden), page visible => page plays and the overlay stays quiet.
  routes.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/page-visibility`,
    handler: (request, response) => {
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : ''
      if (method !== 'POST') {
        sendJsonStatus(response, 405, { error: 'method not allowed' }, { Allow: 'POST' })
        return
      }
      return readJsonBody(request, 4096).then((payload) => {
        if (payload === null || typeof payload !== 'object' || typeof payload.visible !== 'boolean') {
          sendJsonStatus(response, 400, { error: 'body must be {"visible": boolean}' })
          return
        }
        pageVisible = payload.visible
        pageVisibleAt = Date.now()
        console.log(`[duo-pet] page visibility: ${pageVisible ? 'visible' : 'hidden'}`)
        sendJsonStatus(response, 200, { ok: true, pageVisible, pageVisibleAt })
      }).catch(() => {
        try {
          sendJsonStatus(response, 400, { error: 'invalid body' })
        } catch (error) {
          // response may already be finished
        }
      })
    },
  }))

  // Client page menu: minimize the DSH main window. Runs window-probe.ps1 in its CLI
  // action mode so the Host itself never touches Win32 APIs. A missing window is a
  // normal {ok:false,found:false,minimized:false} answer, not an HTTP error.
  routes.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/minimize`,
    handler: (request, response) => {
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : ''
      if (method !== 'POST') {
        sendJsonStatus(response, 405, { error: 'method not allowed' }, { Allow: 'POST' })
        return
      }
      return runWindowProbeAction('minimize').then((result) => {
        console.log(`[duo-pet] minimize dsh: ok=${result.ok} found=${result.found} minimized=${result.minimized}`)
        sendJsonStatus(response, 200, { ok: result.ok, found: result.found, minimized: result.minimized })
      }).catch(() => {
        try {
          sendJsonStatus(response, 200, { ok: false, found: false, minimized: false })
        } catch (error) {
          // response may already be finished
        }
      })
    },
  }))

  // Shared overlay options: the page menu and the overlay's own context menu both POST
  // here, and both the page and the desktop overlay read them from /duo-pet/state.
  routes.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/overlay-option`,
    handler: (request, response) => {
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : ''
      if (method !== 'POST') {
        sendJsonStatus(response, 405, { error: 'method not allowed' }, { Allow: 'POST' })
        return
      }
      return readJsonBody(request, 4096).then((payload) => {
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          sendJsonStatus(response, 400, { error: 'body must contain topmost/alwaysShow or toggleTopmost/toggleAlwaysShow booleans' })
          return
        }
        const hasTopmost = Object.prototype.hasOwnProperty.call(payload, 'topmost')
        const hasAlways = Object.prototype.hasOwnProperty.call(payload, 'alwaysShow')
        // Backward compatibility with the in-page menu, which posts toggle flags
        // ({toggleTopmost:true}/{toggleAlwaysShow:true}) instead of absolute values.
        const hasToggleTopmost = Object.prototype.hasOwnProperty.call(payload, 'toggleTopmost')
        const hasToggleAlways = Object.prototype.hasOwnProperty.call(payload, 'toggleAlwaysShow')
        if (!hasTopmost && !hasAlways && !hasToggleTopmost && !hasToggleAlways) {
          sendJsonStatus(response, 400, { error: 'body must contain topmost/alwaysShow or toggleTopmost/toggleAlwaysShow booleans' })
          return
        }
        for (const [name, present] of [
          ['topmost', hasTopmost],
          ['alwaysShow', hasAlways],
          ['toggleTopmost', hasToggleTopmost],
          ['toggleAlwaysShow', hasToggleAlways],
        ]) {
          if (present && typeof payload[name] !== 'boolean') {
            sendJsonStatus(response, 400, { error: `${name} must be a boolean` })
            return
          }
        }
        if (hasTopmost) overlayTopmost = payload.topmost
        if (hasAlways) overlayAlwaysShow = payload.alwaysShow
        if (hasToggleTopmost && payload.toggleTopmost === true) overlayTopmost = !overlayTopmost
        if (hasToggleAlways && payload.toggleAlwaysShow === true) overlayAlwaysShow = !overlayAlwaysShow
        console.log(`[duo-pet] overlay option: topmost=${overlayTopmost} alwaysShow=${overlayAlwaysShow}`)
        sendJsonStatus(response, 200, { ok: true, overlayTopmost, overlayAlwaysShow })
      }).catch(() => {
        try {
          sendJsonStatus(response, 400, { error: 'invalid body' })
        } catch (error) {
          // response may already be finished
        }
      })
    },
  }))

  // Only assets readable at apply time get a route; a missing asset answers 404 by
  // design (and `state` exposes null for its URL). Handlers themselves stay lazy.
  if (sprite !== null) routes.push(registerAssetRoute(`${ROUTE_PREFIX}/spritesheet.png`, 'image/png', 'spritesheet.png'))
  if (sally !== null) routes.push(registerAssetRoute(`${ROUTE_PREFIX}/sally.mp3`, 'audio/mpeg', 'sally.mp3'))
  if (done !== null) routes.push(registerAssetRoute(`${ROUTE_PREFIX}/done.mp3`, 'audio/mpeg', 'done.mp3'))

  // ---------- desktop overlay (visible while the DSH window is minimized) ----------
  // Started after the routes above exist so the overlay can poll /duo-pet/state
  // and load the sprite from the same origin immediately. DSH_DUO_PET_DESKTOP_DISABLE=1
  // keeps the in-window pet only (used by tests and by users who do not want a
  // desktop window).
  let stopOverlay = () => {}
  if (process.platform !== 'win32') {
    console.log('[duo-pet] desktop overlay is Windows-only; skipped')
  } else if (process.env.DSH_DUO_PET_DESKTOP_DISABLE === '1') {
    console.log('[duo-pet] desktop overlay disabled by DSH_DUO_PET_DESKTOP_DISABLE=1')
  } else {
    stopOverlay = startDesktopOverlay(webServer)
  }

  // ---------- teardown ----------
  ctx.effect(() => () => {
    clearInterval(pollTimer)
    for (const dispose of routes) {
      try {
        dispose()
      } catch (error) {
        // route already removed
      }
    }
    try {
      stopOverlay()
    } catch (error) {
      // overlay already stopped
    }
  })
}
