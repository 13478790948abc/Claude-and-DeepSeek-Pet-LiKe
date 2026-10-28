#!/usr/bin/env node
/**
 * Independent acceptance harness for the `@local/dsh-duo-pet` profile bundle.
 *
 * Written by qa-verifier from D:\plugging\.dsh-duo-pet\SPEC.md (the binding
 * contract). It never trusts engineer self-tests, never modifies files outside
 * `.dsh-duo-pet/dev/`, never installs the plugin, never starts a server/browser.
 *
 * Covered here (SPEC section 10 items 1-3, 5):
 *   A. Files present, `node --check`, JSON.parse, cordis.patch.yml structure,
 *      package.json manifest (exports/files/dsh/license/no deps).
 *   B. Host half over a fake Cordis ctx: route set, /duo-pet/state field types
 *      and URL shapes, approval/request + user-questions/request waiting &
 *      waitingSeq rise/fall (waterfall promise preserved), agent/status
 *      running->idle celebration, agent/error suppression, 500ms agents
 *      calibration, byte-exact asset routes (content-type/cache/content-length),
 *      ctx.effect cleanup (routes + interval), missing-asset and partial-asset
 *      degradation in temp copies.
 *   C. Client half over fake window.__ModuleLoader__ / react / slots / locale /
 *      timer: module id, inject list, shell.overlay registration (name/id/order/
 *      label/component), locale dictionaries vs JSON, _internals ANIMATIONS /
 *      frameFor / durationsOf (2000 / 2988 / 1200 ms), no fetch/timer/listener
 *      side effects at load/factory/apply, safe exit when services are missing,
 *      static contract tokens.
 *   D. Art/audio assets via dev/verify-assets.py (Pillow + ffmpeg).
 *   E. locale JSON key completeness + package exports/files coverage.
 *
 * Usage:
 *   node verify-bundle.mjs [--json <path>] [--pkg <dir>] [--python <exe>]
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = NOT-READY (files/assets missing), 3 = harness error.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Constants / paths
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PKG = resolveArg('--pkg', join(ROOT, 'duo-pet-plugin'))
const TMP = join(HERE, 'tmp')
const REPORT_PATH = resolveArg('--json', join(HERE, 'report-latest.json'))
const ASSET_SCRIPT = join(HERE, 'verify-assets.py')
const ASSET_REPORT = join(TMP, 'assets-report.json')
const PYTHON = resolveArg('--python', process.env.DUO_PET_PYTHON || 'D:\\APP\\Anaconda3\\python.exe')
const NODE_BIN = process.env.DUO_PET_NODE || process.execPath

const PACKAGE_NAME = '@local/dsh-duo-pet'
const PLUGIN_ROW_ID = 'duo-pet'
const SHELL_SLOT = 'shell.overlay'
const POSITION_KEY = 'dsh.duo-pet.pos'
const REAL_SET_TIMEOUT = globalThis.setTimeout

const CODE_FILES = [
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml',
  'locale/zh.json', 'locale/en.json', 'README.md',
]
const ASSET_FILES = [
  'assets/spritesheet.png', 'assets/sally.mp3', 'assets/done.mp3', 'icon.png',
]
// Desktop floating overlay (2026-10-28 addition). Installed with the bundle and
// spawned by index.js only on Windows (DSH_DUO_PET_DESKTOP_DISABLE=1 disables it).
const DESKTOP_FILES = [
  'desktop/pet-overlay.ps1',
  'desktop/window-probe.ps1',
  'desktop/messages.json',
]
const RUNTIME_FILES = [...CODE_FILES, ...ASSET_FILES, ...DESKTOP_FILES]
// npm always packs package.json regardless of files[], so files[] only needs to
// cover every OTHER runtime file (SPEC section 8).
const PACKED_FILES = RUNTIME_FILES.filter((rel) => rel !== 'package.json')

const ROUTES = {
  state: '/duo-pet/state',
  visibility: '/duo-pet/page-visibility',
  minimize: '/duo-pet/minimize',
  overlayOption: '/duo-pet/overlay-option',
  sprite: '/duo-pet/spritesheet.png',
  sally: '/duo-pet/sally.mp3',
  done: '/duo-pet/done.mp3',
}
const EXPECTED_ROUTES = Object.values(ROUTES).sort()

// SPEC section 6 example: "/duo-pet/spritesheet.png?rev=2". The v4 Host also appends
// an optional content stamp "&h=<round(mtimeMs)>-<size>" so replacing the PNG on
// disk hot-reloads the art without a revision bump (index.js assetUrl()). QA accepts
// that extension but verifies the stamp against the real file (see B5/B5b).
const SPRITE_URL_SHAPE = /^\/duo-pet\/spritesheet\.png\?rev=(\d+)(?:&h=(\d+)-(\d+))?$/
function parseSpriteUrl(url) {
  if (typeof url !== 'string') return null
  const match = url.match(SPRITE_URL_SHAPE)
  if (!match) return null
  return { rev: Number(match[1]), stamp: match[2] === undefined ? null : `${match[2]}-${match[3]}` }
}
function currentSheetStamp() {
  const abs = join(PKG, 'assets', 'spritesheet.png')
  if (!existsSync(abs)) return null
  const info = statSync(abs)
  return `${Math.round(info.mtimeMs)}-${info.size}`
}

const REQUIRED_LOCALE_FLAT = [
  'meta.title', 'meta.description',
  'bubble.sally', 'bubble.done', 'bubble.hint', 'bubble.dragging', 'bubble.closed',
  // 2026-10-28: in-page right-click menu entries (client + locale JSON menu section).
  'menu.snuggle', 'menu.celebrate', 'menu.idle',
  // 2026-10-28 round 2: unified page/desktop menu entries.
  'menu.minimizeDsh', 'menu.action', 'menu.topmost', 'menu.alwaysShow', 'menu.closePet',
  // 2026-10-28 round 3: dynamic "cancel" labels for the page menu.
  'menu.untopmost', 'menu.cancelAlwaysShow',
]
const EXPECTED_EXPORTS = ['.', './client', './locale/*.json', './icon', './package.json']
const FRAME_SPEC = {
  idle: { count: 8, ms: 250, total: 2000, row: 0 },
  snuggle: { count: 36, ms: 83, total: 2988 },
  done: { count: 12, ms: 100, total: 1200, row: 4 },
}
// v1 (330x360) art hashes: the v2 refresh must change both files. A run against
// these hashes means art-master has not delivered the redraw yet -> FAIL (not a
// valid v2 acceptance), never PASS with the stale sheet.
const V1_SPRITE_SHA256 = '523a4b41f4aa3845e74386572a55b609fa484ed1f3d7feba0f244d54d98ff576'
const V1_ICON_SHA256 = 'cb7a65c3346a8e33e4106c3327f7bc621b0dc3be8474bfc1867af8aefd7c50f9'

// ---------------------------------------------------------------------------
// Result rows
// ---------------------------------------------------------------------------
const rows = []
const STATUS = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO', NOTREADY: 'NOT-READY' }
const severityOf = new Map()
let assetEvidence = {}

function resolveArg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
function record(id, title, status, evidence, opts = {}) {
  rows.push({ id, title, pass: status === STATUS.PASS, status, evidence: String(evidence ?? '') })
  severityOf.set(id, opts.severity || 'required')
  console.log(`[${status}] ${id} ${title} :: ${String(evidence ?? '')}`)
  return status
}
function check(id, title, fn, opts = {}) {
  try {
    const evidence = fn()
    return record(id, title, STATUS.PASS, evidence === undefined ? 'ok' : evidence, opts)
  } catch (error) {
    return record(id, title, STATUS.FAIL, error && error.message ? error.message : String(error), opts)
  }
}
async function checkAsync(id, title, fn, opts = {}) {
  try {
    const evidence = await fn()
    return record(id, title, STATUS.PASS, evidence === undefined ? 'ok' : evidence, opts)
  } catch (error) {
    return record(id, title, STATUS.FAIL, error && error.message ? error.message : String(error), opts)
  }
}
function notReady(id, title, evidence) {
  return record(id, title, STATUS.NOTREADY, evidence)
}
function informational(id, title, evidence) {
  return record(id, title, STATUS.INFO, evidence, { severity: 'informational' })
}
function warn(id, title, evidence) {
  return record(id, title, STATUS.WARN, evidence, { severity: 'informational' })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const exists = (p) => existsSync(p)
const readText = (p) => readFileSync(p, 'utf8')
function readJsonOrNull(p) {
  try { return JSON.parse(readText(p)) } catch { return null }
}
const sleep = (ms) => new Promise((done) => REAL_SET_TIMEOUT(done, ms))
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
function relToPkg(p) {
  return p.slice(PKG.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1 } else { out += '[^/]*' }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(ch)
    }
  }
  return new RegExp(`^${out}$`)
}
function listFilesRecursive(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) listFilesRecursive(abs, base, out)
    else if (entry.isFile()) out.push(abs.slice(base.length + 1).replace(/\\/g, '/'))
  }
  return out
}
function freshImport(file) {
  const url = `${pathToFileURL(file).href}?qa=${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  return import(url)
}
function flattenLocaleDictionary(dict) {
  const flat = {}
  if (dict && typeof dict === 'object') {
    for (const [section, value] of Object.entries(dict)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, text] of Object.entries(value)) flat[`${section}.${name}`] = text
      } else {
        flat[section] = value
      }
    }
  }
  return flat
}
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, '')
}

// ---------------------------------------------------------------------------
// Section A: files, syntax, JSON, patch, manifest
// ---------------------------------------------------------------------------
function checkJsSyntax(file) {
  const res = spawnSync(NODE_BIN, ['--check', file], {
    cwd: PKG,
    // DSH sandbox forbids piped child stdio; inherit/ignore is allowed.
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 30_000,
  })
  assert.equal(res.error, undefined, `failed to spawn node --check: ${res.error && (res.error.code || res.error.message)}`)
  assert.equal(res.status, 0, `node --check exited ${res.status} (stderr shown above)`)
  return `node --check ${relToPkg(file)} exit 0`
}

function parsePatch(text) {
  const lines = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    lines.push({ raw, trimmed, line: index + 1, indent: raw.match(/^\s*/)[0].length })
  })
  assert(lines.length > 0, 'cordis.patch.yml is empty')
  const topBullets = lines.filter((l) => /^-\s+/.test(l.trimmed) && l.indent === 0)
  assert.equal(topBullets.length, 1,
    `expected exactly one top-level "- insert:" item, found ${topBullets.length}: ` +
    `${JSON.stringify(topBullets.map((l) => `line ${l.line}: ${l.trimmed}`))}`)
  assert.match(topBullets[0].trimmed, /^-\s+insert:\s*$/,
    `line ${topBullets[0].line}: expected "- insert:" but got "${topBullets[0].trimmed}"`)
  const nested = lines.filter((l) => /^-\s+/.test(l.trimmed) && l.indent > 0)
  assert.equal(nested.length, 1,
    `expected exactly one nested item under insert (the plugin row "- id: ${PLUGIN_ROW_ID}"), ` +
    `found ${nested.length}: ${JSON.stringify(nested.map((l) => `line ${l.line}: ${l.trimmed}`))}`)
  assert.match(nested[0].trimmed, new RegExp(`^-\\s+id:\\s*${escapeRegExp(PLUGIN_ROW_ID)}\\s*$`),
    `expected "- id: ${PLUGIN_ROW_ID}" but got "${nested[0].trimmed}" (line ${nested[0].line})`)
  const nameLines = lines.filter((l) => /^\s*name:\s*/.test(l.raw))
  assert.equal(nameLines.length, 1, `expected exactly one "name:" field, found ${nameLines.length}`)
  const nameValue = nameLines[0].raw.trim().replace(/^name:\s*/, '').replace(/^['"]|['"]$/g, '')
  assert.equal(nameValue, PACKAGE_NAME,
    `patch row name "${nameValue}" !== package name "${PACKAGE_NAME}" (line ${nameLines[0].line})`)
  const allowedKeys = new Set(['id', 'name', 'config'])
  const badKeys = lines
    .filter((l) => /^\s+[A-Za-z0-9_-]+:/.test(l.raw))
    .map((l) => l.raw.trim().split(':')[0])
    .filter((key) => !allowedKeys.has(key))
  assert.equal(badKeys.length, 0, `unexpected keys inside the insert item: ${[...new Set(badKeys)].join(', ')}`)
  const forbidden = ['override', 'disabled', 'group', 'isolate']
  const hits = forbidden.filter((word) => new RegExp(`^\\s*-?\\s*${word}:`, 'm').test(text))
  assert.equal(hits.length, 0, `patch must not override other rows; found: ${hits.join(', ')}`)
  return `insert -> id: ${PLUGIN_ROW_ID}, name: ${PACKAGE_NAME}`
}

function runSectionA() {
  const missingCode = CODE_FILES.filter((rel) => !exists(join(PKG, rel)))
  const missingAssets = ASSET_FILES.filter((rel) => !exists(join(PKG, rel)))
  if (missingCode.length > 0) {
    notReady('A1', 'required package files present', `missing: ${missingCode.join(', ')} (engineer bundle not ready)`)
  } else {
    check('A1', 'required package files present', () => `present: ${CODE_FILES.join(', ')}`)
  }
  if (missingAssets.length > 0) {
    notReady('A1b', 'required art/audio assets present', `missing: ${missingAssets.join(', ')} (art pipeline not ready)`)
  } else {
    check('A1b', 'required art/audio assets present', () => `present: ${ASSET_FILES.join(', ')}`)
  }
  const sheetAbs = join(PKG, 'assets/spritesheet.png')
  const iconAbs = join(PKG, 'icon.png')
  if (exists(sheetAbs) && exists(iconAbs)) {
    check('A1c', 'refreshed art (v2+): spritesheet/icon hashes differ from the v1 330x360 art (no stale art)', () => {
      const sheetSha = sha256(sheetAbs)
      const iconSha = sha256(iconAbs)
      const stale = []
      if (sheetSha === V1_SPRITE_SHA256) stale.push('spritesheet.png is still the v1 sheet')
      if (iconSha === V1_ICON_SHA256) stale.push('icon.png is still the v1 icon')
      assert.equal(stale.length, 0,
        `${stale.join('; ')} — the refreshed art has not landed yet, do not accept with v1 art ` +
        `(sheet=${sheetSha.slice(0, 12)}…, icon=${iconSha.slice(0, 12)}…)`)
      return `refreshed art confirmed: spritesheet ${sheetSha.slice(0, 16)}… (${statSync(sheetAbs).size}B), ` +
        `icon ${iconSha.slice(0, 16)}… (${statSync(iconAbs).size}B); neither matches the v1 hashes`
    })
  } else {
    notReady('A1c', 'refreshed art present', 'spritesheet.png and/or icon.png missing — cannot confirm the refreshed art yet')
  }

  for (const file of ['index.js', 'client.js']) {
    const abs = join(PKG, file)
    if (!exists(abs)) { notReady(`A2.${file}`, `node --check ${file}`, 'file missing'); continue }
    check(`A2.${file}`, `node --check ${file}`, () => checkJsSyntax(abs))
  }

  let pkg = null
  if (!exists(join(PKG, 'package.json'))) {
    notReady('A3a', 'JSON.parse package.json', 'package.json missing')
  } else {
    const status = check('A3a', 'JSON.parse package.json', () => {
      pkg = JSON.parse(readText(join(PKG, 'package.json')))
      return `parsed; top-level keys: ${Object.keys(pkg).join(', ')}`
    })
    if (status === STATUS.FAIL) pkg = null
  }

  const locale = {}
  for (const lang of ['zh', 'en']) {
    const abs = join(PKG, 'locale', `${lang}.json`)
    if (!exists(abs)) { notReady(`A3b.${lang}`, `JSON.parse locale/${lang}.json`, 'missing'); continue }
    check(`A3b.${lang}`, `JSON.parse locale/${lang}.json`, () => {
      locale[lang] = JSON.parse(readText(abs))
      return `parsed; sections: ${Object.keys(locale[lang]).join(', ')}`
    })
  }

  if (!exists(join(PKG, 'cordis.patch.yml'))) {
    notReady('A4', 'cordis.patch.yml inserts exactly the duo-pet row', 'cordis.patch.yml missing')
  } else {
    check('A4', 'cordis.patch.yml inserts exactly the duo-pet row', () => parsePatch(readText(join(PKG, 'cordis.patch.yml'))))
  }

  if (pkg) {
    check('A5a', 'package identity fields (name/version/private/type/main/icon/license)', () => {
      assert.equal(pkg.name, PACKAGE_NAME, `name is ${JSON.stringify(pkg.name)}`)
      assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/, `version is ${JSON.stringify(pkg.version)}`)
      assert.equal(pkg.private, true, 'private must be true')
      assert.equal(pkg.type, 'module', 'type must be "module"')
      assert.equal(pkg.main, 'index.js', 'main must be "index.js"')
      assert.equal(pkg.icon, 'icon.png', 'icon must be "icon.png"')
      assert.equal(pkg.license, 'MIT', 'license must be "MIT"')
      return `${pkg.name}@${pkg.version} private=${pkg.private} type=${pkg.type} main=${pkg.main} icon=${pkg.icon} license=${pkg.license}`
    })
    check('A5b', 'dsh.bundle.patch + dsh.client manifest sections', () => {
      const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
      assert.equal(patch, './cordis.patch.yml', `dsh.bundle.patch is ${JSON.stringify(patch)}`)
      assert.deepEqual(pkg.dsh.client, {
        platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-layout'],
      }, `dsh.client is ${JSON.stringify(pkg.dsh.client)}`)
      return `patch=${patch}; client={platform:web, immediately:true, inject:[@deepseek-ai/dsh-client-ui-layout]}`
    })
    check('A5c', 'package exports keys and on-disk targets', () => {
      const exportsMap = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
      for (const key of EXPECTED_EXPORTS) {
        assert.ok(Object.prototype.hasOwnProperty.call(exportsMap, key), `exports["${key}"] is missing`)
      }
      assert.equal(exportsMap['./icon'], './icon.png',
        `exports["./icon"] is ${JSON.stringify(exportsMap['./icon'])}, expected "./icon.png"`)
      const missingTargets = []
      for (const [key, target] of Object.entries(exportsMap)) {
        if (typeof target !== 'string' || target.includes('*')) continue
        // Art assets are covered by A1b/A0 (and may legitimately not exist yet while
        // the art pipeline is running); their absence must not fail the manifest check.
        if (target === './icon.png' || target.startsWith('./assets/')) continue
        if (!exists(join(PKG, target))) missingTargets.push(`${key} -> ${target}`)
      }
      assert.equal(missingTargets.length, 0, `exports targets missing on disk: ${missingTargets.join('; ')}`)
      return Object.entries(exportsMap).map(([key, value]) => `${key}->${value}`).join(', ')
    })
    check('A5d', 'files[] covers every runtime file (code + png + mp3 + README)', () => {
      const patterns = (Array.isArray(pkg.files) ? pkg.files.map(String) : []).map(globToRegExp)
      const uncovered = PACKED_FILES.filter((rel) => !patterns.some((re) => re.test(rel)))
      assert.equal(uncovered.length, 0, `files[] does not cover: ${uncovered.join(', ')}`)
      return `files=${JSON.stringify(pkg.files)} covers all ${PACKED_FILES.length} runtime files (package.json is always packed by npm)`
    })
    check('A5e', 'no third-party runtime dependencies (SPEC section 9)', () => {
      const deps = pkg.dependencies && Object.keys(pkg.dependencies).length
        ? pkg.dependencies : null
      assert.equal(deps, null, `dependencies must be empty/absent, found ${JSON.stringify(pkg.dependencies)}`)
      return 'dependencies: none; pure ESM + loader-injected React'
    })
    informational('A5f', 'package.json description wording (informational)', (() => {
      const description = String(pkg.description || '')
      const stale = /lick/i.test(description)
      return `description=${JSON.stringify(description)}${stale ? ' — still mentions "licks" (stale after the snuggle requirement; locale/README are up to date)' : ''}`
    })())
  } else {
    notReady('A5', 'package manifest checks', 'package.json missing or not valid JSON')
  }

  return { pkg, locale }
}

// ---------------------------------------------------------------------------
// Section B: Host half over a fake Cordis context
// ---------------------------------------------------------------------------
function makeHostHarness() {
  const routes = new Map() // path -> { route, disposed, disposeCalls }
  const listeners = new Map() // event name -> handler
  const onDisposers = []
  const effectEntries = []
  const getCalls = []
  const agentsState = { list: () => [] }
  const timerTrap = {
    installed: false,
    intervals: [], // { fn, ms, cleared }
    timeouts: [],
    nextId: 0,
    realSetInterval: globalThis.setInterval,
    realClearInterval: globalThis.clearInterval,
    install() {
      if (timerTrap.installed) return
      timerTrap.installed = true
      globalThis.setInterval = (fn, ms, ...args) => {
        const id = { qaInterval: ++timerTrap.nextId, unref() { return id }, ref() { return id } }
        timerTrap.intervals.push({ id, fn, ms, args, cleared: false })
        return id
      }
      globalThis.clearInterval = (id) => {
        const rec = timerTrap.intervals.find((entry) => entry.id === id)
        if (rec) { rec.cleared = true; return }
        if (id && typeof id === 'object' && id.qaInterval === undefined) return
      }
    },
    restore() {
      if (!timerTrap.installed) return
      timerTrap.installed = false
      globalThis.setInterval = timerTrap.realSetInterval
      globalThis.clearInterval = timerTrap.realClearInterval
    },
  }
  const webServer = {
    register(route) {
      assert.ok(route && typeof route === 'object', 'webServer.register(route) called without a route object')
      assert.equal(typeof route.handler, 'function', `route ${route.path} has no handler function`)
      assert.equal(route.kind, 'exact', `route ${route.path} kind is ${JSON.stringify(route.kind)}, expected "exact"`)
      if (routes.has(route.path)) throw new Error(`duplicate route registration: ${route.path}`)
      const entry = { route, disposed: false, disposeCalls: 0 }
      routes.set(route.path, entry)
      return () => {
        entry.disposeCalls += 1
        entry.disposed = true
        routes.delete(route.path)
      }
    },
  }
  const ctxIntervals = [] // ctx.interval(fn, ms) usage
  const ctxTimeouts = []
  const ctx = {
    webServer,
    agents: agentsState,
    get(key) {
      getCalls.push(String(key))
      if (key === 'webServer') return webServer
      if (key === 'agents') return agentsState
      if (key === 'logger') return console
      return undefined
    },
    on(name, handler) {
      assert.equal(typeof handler, 'function', `ctx.on("${name}") registered a non-function handler`)
      if (listeners.has(name)) throw new Error(`duplicate ctx.on listener for "${name}"`)
      listeners.set(name, handler)
      const dispose = () => listeners.delete(name)
      onDisposers.push(dispose)
      return dispose
    },
    effect(fn) { return ctx.effect(fn) },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false }
      ctxIntervals.push(entry)
      return () => { entry.disposed = true }
    },
    timeout(fn, ms) {
      const entry = { fn, ms, disposed: false }
      ctxTimeouts.push(entry)
      return () => { entry.disposed = true }
    },
    logger: console,
  }
  const allDisposers = []
  function runDisposer(disposer) {
    if (typeof disposer === 'function') {
      const result = disposer()
      if (result && typeof result.then === 'function') allDisposers.push(result)
    } else if (Array.isArray(disposer)) {
      for (const item of disposer) runDisposer(item)
    }
  }
  const effectResults = []
  ctx.effect = (fn) => {
    assert.equal(typeof fn, 'function', 'ctx.effect(fn) called without a function')
    effectEntries.push(fn)
    const disposer = fn()
    effectResults.push(disposer)
    return () => runDisposer(disposer)
  }
  async function dispose() {
    for (let i = effectResults.length - 1; i >= 0; i -= 1) runDisposer(effectResults[i])
    await Promise.all(allDisposers)
    for (const disposeListener of onDisposers) disposeListener()
    timerTrap.restore()
  }
  return { ctx, webServer, routes, listeners, effectEntries, effectResults, getCalls, agentsState, timerTrap, ctxIntervals, ctxTimeouts, dispose, runDisposer }
}

function makeResponse() {
  const headers = {}
  const chunks = []
  const res = {
    statusCode: 200,
    headersSent: false,
    finished: false,
    headers,
    chunks,
    writeHead(code, headerBag) {
      if (typeof code === 'number') res.statusCode = code
      if (headerBag && typeof headerBag === 'object') {
        for (const [name, value] of Object.entries(headerBag)) headers[String(name).toLowerCase()] = value
      }
      res.headersSent = true
      return res
    },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; return res },
    getHeader(name) { return headers[String(name).toLowerCase()] },
    removeHeader(name) { delete headers[String(name).toLowerCase()] },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk))
      res.finished = true
      return res
    },
    on() { return res },
    once() { return res },
    emit() { return false },
  }
  return res
}
async function invokeRoute(route, { method = 'GET', url = route.path, body = undefined, rawBody = undefined } = {}) {
  // The Host reads the page-visibility body through request.on('data'/'end'), so the
  // fake request must be an EventEmitter; for all other routes the extra events are
  // harmless (no listeners).
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:41810' }
  req.socket = {}
  const res = makeResponse()
  const result = route.handler(req, res)
  if (rawBody !== undefined) {
    req.emit('data', Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
  } else if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
  }
  req.emit('end')
  if (result && typeof result.then === 'function') await result
  const responseBody = Buffer.concat(res.chunks)
  return { status: res.statusCode, headers: res.headers, body: responseBody }
}
function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()]
  if (Array.isArray(value)) return value.join(', ')
  return value === undefined ? undefined : String(value)
}

async function readState(harness) {
  const entry = harness.routes.get(ROUTES.state)
  assert.ok(entry, `GET ${ROUTES.state} route is not registered; routes: ${[...harness.routes.keys()].join(', ')}`)
  const response = await invokeRoute(entry.route)
  assert.equal(response.status, 200, `GET ${ROUTES.state} status is ${response.status}`)
  let parsed
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch (error) {
    throw new Error(`GET ${ROUTES.state} body is not JSON: ${response.body.toString('utf8').slice(0, 200)}`)
  }
  return { state: parsed, response }
}
function assertStateShape(state, label) {
  const problems = []
  const modes = new Set(['idle', 'working', 'waiting'])
  if (!modes.has(state.mode)) problems.push(`mode=${JSON.stringify(state.mode)} not in idle/working/waiting`)
  for (const key of ['seq', 'waitingSeq', 'celebrateSeq', 'waiting', 'running', 'revision']) {
    if (numberOrNull(state[key]) === null || !Number.isInteger(state[key])) {
      problems.push(`${key}=${JSON.stringify(state[key])} is not an integer`)
    }
  }
  const spriteOk = state.spriteUrl === null || parseSpriteUrl(state.spriteUrl) !== null
  if (!spriteOk) problems.push(`spriteUrl=${JSON.stringify(state.spriteUrl)} does not match /duo-pet/spritesheet.png?rev=N[&h=mtime-size] or null`)
  if (typeof state.pageVisible !== 'boolean') {
    problems.push(`pageVisible=${JSON.stringify(state.pageVisible)} is not a boolean`)
  }
  if (numberOrNull(state.pageVisibleAt) === null || !Number.isInteger(state.pageVisibleAt) || state.pageVisibleAt < 0) {
    problems.push(`pageVisibleAt=${JSON.stringify(state.pageVisibleAt)} is not a non-negative integer`)
  }
  for (const key of ['overlayTopmost', 'overlayAlwaysShow']) {
    if (typeof state[key] !== 'boolean') problems.push(`${key}=${JSON.stringify(state[key])} is not a boolean`)
  }
  for (const key of ['sallyUrl', 'doneUrl']) {
    const value = state[key]
    const ok = value === null || value === `/duo-pet/${key.replace('Url', '.mp3')}`
      || (key === 'sallyUrl' && value === ROUTES.sally)
      || (key === 'doneUrl' && value === ROUTES.done)
    if (!ok) problems.push(`${key}=${JSON.stringify(value)} (expected "${key === 'sallyUrl' ? ROUTES.sally : ROUTES.done}" or null)`)
  }
  assert.equal(problems.length, 0, `[${label}] ${problems.join('; ')} — state=${JSON.stringify(state)}`)
  return state
}

async function runSectionB() {
  const indexAbs = join(PKG, 'index.js')
  if (!exists(indexAbs)) {
    notReady('B0', 'Host half checks (fake ctx)', 'index.js missing — cannot exercise the Host state machine yet')
    return
  }
  let module = null
  const importStatus = await checkAsync('B1', "index.js exports apply() and inject=['webServer']", async () => {
    module = await freshImport(indexAbs)
    assert.equal(typeof module.apply, 'function', 'index.js must export function apply(ctx)')
    assert.deepEqual(module.inject, ['webServer'], `inject is ${JSON.stringify(module.inject)}`)
    return 'apply() function + inject=[webServer]'
  })
  if (importStatus !== STATUS.PASS || !module) return

  const sheetBytes = exists(join(PKG, 'assets/spritesheet.png')) ? readFileSync(join(PKG, 'assets/spritesheet.png')) : null
  const sallyBytes = exists(join(PKG, 'assets/sally.mp3')) ? readFileSync(join(PKG, 'assets/sally.mp3')) : null
  const doneBytes = exists(join(PKG, 'assets/done.mp3')) ? readFileSync(join(PKG, 'assets/done.mp3')) : null

  const harness = makeHostHarness()
  harness.timerTrap.install()
  let applyError = null
  try {
    await module.apply(harness.ctx)
    await sleep(30)
  } catch (error) {
    applyError = error
  }
  if (applyError) {
    harness.timerTrap.restore()
    record('B2', 'Host apply(ctx) completes without throwing', STATUS.FAIL, applyError.message)
    return
  }
  check('B2', 'Host apply(ctx) completes without throwing', () => 'apply(ctx) resolved; routes + listeners registered')

  // -- listener set --------------------------------------------------------
  check('B3', 'ctx.on subscribes agent/status, agent/error, approval/request, user-questions/request', () => {
    const required = ['agent/status', 'agent/error', 'approval/request', 'user-questions/request']
    const missing = required.filter((name) => !harness.listeners.has(name))
    assert.equal(missing.length, 0, `missing listeners: ${missing.join(', ')}; registered: ${[...harness.listeners.keys()].join(', ')}`)
    const extras = [...harness.listeners.keys()].filter((name) => !required.includes(name))
    return `listeners=${JSON.stringify([...harness.listeners.keys()])}${extras.length ? `; extra: ${extras.join(', ')}` : ''}`
  })

  // -- route set -----------------------------------------------------------
  const expectedRouteSet = [
    ROUTES.state,
    ROUTES.visibility,
    ROUTES.minimize,
    ROUTES.overlayOption,
    ...(sheetBytes ? [ROUTES.sprite] : []),
    ...(sallyBytes ? [ROUTES.sally] : []),
    ...(doneBytes ? [ROUTES.done] : []),
  ].sort()
  check('B4', 'routes are exactly the expected exact-match duo-pet routes', () => {
    const actual = [...harness.routes.keys()].sort()
    assert.deepEqual(actual, expectedRouteSet,
      `routes are ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedRouteSet)}`)
    assert.equal(harness.routes.has('/duo-pet/meta.json'), false, 'the forbidden /duo-pet/meta.json route is registered')
    return `${actual.length} exact routes: ${actual.join(', ')}`
  })

  // -- initial state -------------------------------------------------------
  let state = null
  await checkAsync('B5', 'GET /duo-pet/state: JSON, headers, field types, URL shapes', async () => {
    const { state: initial, response } = await readState(harness)
    state = initial
    assert.match(String(headerValue(response.headers, 'content-type')), /^application\/json;\s*charset=utf-8$/i,
      `content-type is ${JSON.stringify(headerValue(response.headers, 'content-type'))}`)
    assert.match(String(headerValue(response.headers, 'cache-control')), /no-store/i,
      `cache-control is ${JSON.stringify(headerValue(response.headers, 'cache-control'))}`)
    assertStateShape(initial, 'initial')
    assert.equal(initial.mode, 'idle', `initial mode is ${JSON.stringify(initial.mode)}`)
    assert.equal(initial.seq, 0, `initial seq is ${JSON.stringify(initial.seq)}`)
    assert.equal(initial.waitingSeq, 0, `initial waitingSeq is ${JSON.stringify(initial.waitingSeq)}`)
    assert.equal(initial.celebrateSeq, 0, `initial celebrateSeq is ${JSON.stringify(initial.celebrateSeq)}`)
    assert.equal(initial.waiting, 0, `initial waiting is ${JSON.stringify(initial.waiting)}`)
    assert.equal(initial.running, 0, `initial running is ${JSON.stringify(initial.running)}`)
    assert.equal(initial.revision, 2, `initial revision is ${JSON.stringify(initial.revision)}, expected 2 (current v2+ art)`)
    assert.equal(initial.pageVisible, true, `initial pageVisible is ${JSON.stringify(initial.pageVisible)}, expected true (default)`)
    assert.equal(initial.pageVisibleAt, 0, `initial pageVisibleAt is ${JSON.stringify(initial.pageVisibleAt)}, expected 0 (default)`)
    assert.equal(initial.overlayTopmost, true, `initial overlayTopmost is ${JSON.stringify(initial.overlayTopmost)}, expected true (default)`)
    assert.equal(initial.overlayAlwaysShow, false, `initial overlayAlwaysShow is ${JSON.stringify(initial.overlayAlwaysShow)}, expected false (default)`)
    if (sheetBytes) {
      const parsed = parseSpriteUrl(initial.spriteUrl)
      assert.ok(parsed, `spriteUrl is ${JSON.stringify(initial.spriteUrl)} (expected /duo-pet/spritesheet.png?rev=N[&h=mtimeMs-size])`)
      assert.equal(parsed.rev, initial.revision,
        `spriteUrl rev ${parsed.rev} != state revision ${initial.revision}`)
      if (parsed.stamp !== null) {
        const diskStamp = currentSheetStamp()
        assert.equal(parsed.stamp, diskStamp,
          `spriteUrl content stamp h=${parsed.stamp} does not match the current spritesheet.png (mtimeMs-size=${diskStamp})`)
      } else {
        assert.equal(initial.spriteUrl, '/duo-pet/spritesheet.png?rev=2',
          `spriteUrl is ${JSON.stringify(initial.spriteUrl)}, expected "/duo-pet/spritesheet.png?rev=2" when no content stamp is present`)
      }
    } else {
      assert.equal(initial.spriteUrl, null, `spriteUrl is ${JSON.stringify(initial.spriteUrl)} with spritesheet.png missing`)
    }
    assert.equal(initial.sallyUrl, sallyBytes ? ROUTES.sally : null, `sallyUrl is ${JSON.stringify(initial.sallyUrl)}`)
    assert.equal(initial.doneUrl, doneBytes ? ROUTES.done : null, `doneUrl is ${JSON.stringify(initial.doneUrl)}`)
    return `mode=idle seq=0 waitingSeq=0 celebrateSeq=0 revision=2 spriteUrl=${JSON.stringify(initial.spriteUrl)} ` +
      `sallyUrl=${JSON.stringify(initial.sallyUrl)} doneUrl=${JSON.stringify(initial.doneUrl)}`
  })
  informational('B5b', 'state cache-bust extension & hits counters (current SPEC section 6 example)', (() => {
    const parsed = state ? parseSpriteUrl(state.spriteUrl) : null
    const diskStamp = currentSheetStamp()
    const expectedKeys = ['mode', 'seq', 'waitingSeq', 'celebrateSeq', 'waiting', 'running', 'revision', 'spriteUrl', 'sallyUrl', 'doneUrl', 'pageVisible', 'pageVisibleAt', 'overlayTopmost', 'overlayAlwaysShow']
    const extraKeys = state ? Object.keys(state).filter((key) => !expectedKeys.includes(key)) : []
    return `spriteUrl h=${JSON.stringify(parsed && parsed.stamp)} vs disk stamp ${JSON.stringify(diskStamp)}; ` +
      `extra state keys=${JSON.stringify(extraKeys)}; ` +
      'index.js assetUrl() appends "&h=<round(mtimeMs)>-<size>" (hot art reload) and state adds "hits" counters — ' +
      'both are documented by the current SPEC section 6 example, and B5 verifies the stamp against the real file'
  })())

  // -- approval/request: waterfall waiting + waitingSeq + settle -----------
  let seqBefore = state ? state.seq : 0
  let waitingSeqBefore = state ? state.waitingSeq : 0
  await checkAsync('B6', 'approval/request: waiting/waitingSeq rise before next(), fall after settle, promise preserved', async () => {
    const handler = harness.listeners.get('approval/request')
    assert.equal(typeof handler, 'function', 'approval/request listener missing')
    let releaseGate
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate })
    const sentinel = { approved: true, qa: 'approval-sentinel' }
    let nextCalls = 0
    const invocation = handler({ id: 'qa-approval', kind: 'approval' }, () => {
      nextCalls += 1
      return gate
    })
    assert.ok(invocation && typeof invocation.then === 'function',
      'approval/request handler did not return a Promise (next() promise must not be swallowed)')
    const during = (await readState(harness)).state
    assert.equal(during.waiting, 1, `waiting during approval is ${JSON.stringify(during.waiting)}, expected 1`)
    assert.equal(during.waitingSeq, waitingSeqBefore + 1,
      `waitingSeq during approval is ${during.waitingSeq}, expected ${waitingSeqBefore + 1}`)
    assert.equal(during.mode, 'waiting', `mode during approval is ${JSON.stringify(during.mode)}, expected "waiting"`)
    assert.ok(during.seq > seqBefore, `seq did not grow during approval (before ${seqBefore}, during ${during.seq})`)
    assert.equal(nextCalls, 1, `next() called ${nextCalls} time(s) before settle, expected 1`)
    releaseGate(sentinel)
    const settledValue = await invocation
    assert.deepEqual(settledValue, sentinel, 'the approval Promise resolution value was changed/swallowed by the handler')
    const after = (await readState(harness)).state
    assert.equal(after.waiting, 0, `waiting after approval settle is ${JSON.stringify(after.waiting)}, expected 0`)
    assert.equal(after.waitingSeq, waitingSeqBefore + 1,
      `waitingSeq after settle is ${after.waitingSeq}, expected ${waitingSeqBefore + 1} (must not fall back)`)
    return `waiting 0->1->0, waitingSeq ${waitingSeqBefore}->${waitingSeqBefore + 1}, next() calls=${nextCalls}, promise value preserved`
  })

  waitingSeqBefore += 1
  seqBefore = (await readState(harness)).state.seq
  await checkAsync('B7', 'user-questions/request: waiting/waitingSeq rise before next(), fall after settle', async () => {
    const handler = harness.listeners.get('user-questions/request')
    assert.equal(typeof handler, 'function', 'user-questions/request listener missing')
    let releaseGate
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate })
    const invocation = handler({ id: 'qa-question', questions: [{ id: 'q1', prompt: 'proceed?' }] }, () => gate)
    assert.ok(invocation && typeof invocation.then === 'function',
      'user-questions/request handler did not return a Promise')
    const during = (await readState(harness)).state
    assert.equal(during.waiting, 1, `waiting during question is ${JSON.stringify(during.waiting)}, expected 1`)
    assert.equal(during.waitingSeq, waitingSeqBefore + 1,
      `waitingSeq during question is ${during.waitingSeq}, expected ${waitingSeqBefore + 1}`)
    assert.equal(during.mode, 'waiting', `mode during question is ${JSON.stringify(during.mode)}, expected "waiting"`)
    assert.ok(during.seq > seqBefore, `seq did not grow during question (before ${seqBefore}, during ${during.seq})`)
    releaseGate([{ id: 'q1', answer: 'yes' }])
    await invocation
    const after = (await readState(harness)).state
    assert.equal(after.waiting, 0, `waiting after question settle is ${JSON.stringify(after.waiting)}, expected 0`)
    assert.equal(after.waitingSeq, waitingSeqBefore + 1, `waitingSeq after settle is ${after.waitingSeq}`)
    return `waiting 0->1->0, waitingSeq ${waitingSeqBefore}->${waitingSeqBefore + 1}`
  })

  // -- agent/status running -> idle: celebration ---------------------------
  const agentA = { id: 'qa-agent-a' }
  const agentB = { id: 'qa-agent-b' }
  seqBefore = (await readState(harness)).state.seq
  const celebrateBefore = (await readState(harness)).state.celebrateSeq
  await checkAsync('B8', 'agent/status running: running=1, mode=working, seq grows', async () => {
    harness.listeners.get('agent/status')({ agent: agentA, status: 'running' })
    const current = (await readState(harness)).state
    assert.equal(current.running, 1, `running is ${current.running}, expected 1`)
    assert.equal(current.mode, 'working', `mode is ${JSON.stringify(current.mode)}, expected "working"`)
    assert.ok(current.seq > seqBefore, `seq did not grow on running (before ${seqBefore}, after ${current.seq})`)
    return `running=1, mode=working, seq ${seqBefore}->${current.seq}`
  })
  await checkAsync('B9', 'agent/status running->idle: celebrateSeq +1 and mode returns to idle', async () => {
    harness.listeners.get('agent/status')({ agent: agentA, status: 'idle' })
    const current = (await readState(harness)).state
    assert.equal(current.celebrateSeq, celebrateBefore + 1,
      `celebrateSeq is ${current.celebrateSeq}, expected ${celebrateBefore + 1}`)
    assert.equal(current.running, 0, `running is ${current.running}, expected 0`)
    assert.equal(current.mode, 'idle', `mode is ${JSON.stringify(current.mode)}, expected "idle"`)
    return `celebrateSeq ${celebrateBefore}->${current.celebrateSeq}, running=0, mode=idle`
  })
  await checkAsync('B10', 'agent/error then idle: no celebration (celebrateSeq unchanged)', async () => {
    const before = (await readState(harness)).state.celebrateSeq
    harness.listeners.get('agent/status')({ agent: agentB, status: 'running' })
    harness.listeners.get('agent/error')({ agent: agentB, error: 'qa simulated failure' })
    harness.listeners.get('agent/status')({ agent: agentB, status: 'idle' })
    const current = (await readState(harness)).state
    assert.equal(current.celebrateSeq, before,
      `celebrateSeq moved ${before}->${current.celebrateSeq} after an errored agent settled; it must not celebrate`)
    assert.equal(current.mode, 'idle', `mode is ${JSON.stringify(current.mode)}, expected "idle"`)
    const beforeRunningSeq = current.seq
    const agentA2 = { id: 'qa-agent-a2' }
    harness.listeners.get('agent/status')({ agent: agentA2, status: 'running' })
    const afterRecovery = (await readState(harness)).state
    assert.equal(afterRecovery.mode, 'working', 'state machine stuck after an errored turn (mode is not working)')
    harness.listeners.get('agent/status')({ agent: agentA2, status: 'idle' })
    const recoveryDone = (await readState(harness)).state
    assert.equal(recoveryDone.celebrateSeq, before + 1,
      `a clean turn after an error must celebrate again (celebrateSeq ${recoveryDone.celebrateSeq}, expected ${before + 1})`)
    return `errored turn did not celebrate; a later clean turn did (celebrateSeq ${before}->${recoveryDone.celebrateSeq}, seq ${beforeRunningSeq}->${recoveryDone.seq})`
  })

  // -- 500ms agents calibration -------------------------------------------
  const intervalRecord = harness.timerTrap.intervals.find((entry) => entry.ms === 500)
    || harness.ctxIntervals.find((entry) => entry.ms === 500)
  await checkAsync('B11', '500ms agents.list() calibration keeps running/mode in sync', async () => {
    assert.ok(intervalRecord, 'no 500ms interval registered (SPEC section 6 compatibility fallback)')
    const tick = intervalRecord.fn
    assert.equal(typeof tick, 'function', '500ms interval has no callback')
    const calAgent = { id: 'qa-cal-agent', status: 'running' }
    harness.agentsState.list = () => [calAgent]
    tick()
    const runningState = (await readState(harness)).state
    assert.equal(runningState.running, 1, `calibration did not pick up a running agent (running=${runningState.running})`)
    assert.equal(runningState.mode, 'working', `mode after calibration running is ${JSON.stringify(runningState.mode)}`)
    calAgent.status = 'idle'
    tick()
    const idleState = (await readState(harness)).state
    assert.equal(idleState.running, 0, `calibration did not clear the running agent (running=${idleState.running})`)
    assert.equal(idleState.mode, 'idle', `mode after calibration idle is ${JSON.stringify(idleState.mode)}`)
    harness.agentsState.list = () => []
    return '500ms calibration callback observed: running 0->1->0, mode working->idle'
  })

  // -- asset routes: bytes/content-type/cache/length -----------------------
  async function checkAssetRoute(name, path, bytes, contentType, opts = {}) {
    const marker = `B12.${name}`
    if (!bytes) {
      notReady(marker, `GET ${path} -> ${contentType}, byte-identical`, `asset file missing — cannot verify ${path} yet`)
      return
    }
    await checkAsync(marker, `GET ${path} -> ${contentType}, cache header, Content-Length, exact bytes`, async () => {
      const entry = harness.routes.get(path)
      assert.ok(entry, `route ${path} is not registered`)
      const response = await invokeRoute(entry.route)
      assert.equal(response.status, 200, `status is ${response.status}, expected 200`)
      const type = headerValue(response.headers, 'content-type')
      assert.equal(String(type).toLowerCase(), contentType.toLowerCase(),
        `content-type is ${JSON.stringify(type)}, expected ${contentType}`)
      const cache = headerValue(response.headers, 'cache-control')
      assert.match(String(cache), /public/i, `cache-control is ${JSON.stringify(cache)}`)
      assert.match(String(cache), /max-age=86400/, `cache-control is ${JSON.stringify(cache)} (expected max-age=86400)`)
      const contentLength = headerValue(response.headers, 'content-length')
      assert.ok(contentLength !== undefined, 'Content-Length header is missing (SPEC section 6 requires it)')
      assert.equal(Number(contentLength), bytes.length,
        `Content-Length ${contentLength} != file size ${bytes.length}`)
      assert.equal(response.body.length, bytes.length,
        `served body is ${response.body.length} bytes, file is ${bytes.length} bytes`)
      assert.ok(response.body.equals(bytes), `served bytes differ from ${relToPkg(join(PKG, opts.file || ''))}`)
      return `200 ${type}; cache-control="${cache}"; Content-Length=${contentLength}; ${bytes.length} bytes byte-identical`
    })
  }
  await checkAssetRoute('spritesheet', ROUTES.sprite, sheetBytes, 'image/png', { file: 'assets/spritesheet.png' })
  await checkAssetRoute('sally', ROUTES.sally, sallyBytes, 'audio/mpeg', { file: 'assets/sally.mp3' })
  await checkAssetRoute('done', ROUTES.done, doneBytes, 'audio/mpeg', { file: 'assets/done.mp3' })

  // -- page visibility coordination (2026-10-28 feature) -------------------
  const visibilityEntry = harness.routes.get(ROUTES.visibility)
  await checkAsync('BV1', 'POST /duo-pet/page-visibility: visible=false/true round-trip + state fields', async () => {
    assert.ok(visibilityEntry, `route ${ROUTES.visibility} is not registered`)
    const hide = await invokeRoute(visibilityEntry.route, { method: 'POST', body: { visible: false } })
    assert.equal(hide.status, 200, `POST visible=false status is ${hide.status}`)
    assert.match(String(headerValue(hide.headers, 'content-type')), /^application\/json/i,
      `content-type is ${JSON.stringify(headerValue(hide.headers, 'content-type'))}`)
    assert.match(String(headerValue(hide.headers, 'cache-control')), /no-store/i,
      `cache-control is ${JSON.stringify(headerValue(hide.headers, 'cache-control'))}`)
    const hideBody = JSON.parse(hide.body.toString('utf8'))
    assert.equal(hideBody.ok, true, `POST response ok is ${JSON.stringify(hideBody.ok)}`)
    assert.equal(hideBody.pageVisible, false, `POST response pageVisible is ${JSON.stringify(hideBody.pageVisible)}`)
    assert.ok(Number.isInteger(hideBody.pageVisibleAt) && hideBody.pageVisibleAt > 0,
      `POST response pageVisibleAt is ${JSON.stringify(hideBody.pageVisibleAt)}`)
    const hiddenState = (await readState(harness)).state
    assert.equal(hiddenState.pageVisible, false, `state pageVisible is ${JSON.stringify(hiddenState.pageVisible)} after visible=false`)
    assert.equal(hiddenState.pageVisibleAt, hideBody.pageVisibleAt,
      `state pageVisibleAt ${hiddenState.pageVisibleAt} != POST response ${hideBody.pageVisibleAt}`)
    const show = await invokeRoute(visibilityEntry.route, { method: 'POST', body: { visible: true } })
    assert.equal(show.status, 200, `POST visible=true status is ${show.status}`)
    const showBody = JSON.parse(show.body.toString('utf8'))
    assert.equal(showBody.ok, true, `POST visible=true ok is ${JSON.stringify(showBody.ok)}`)
    assert.equal(showBody.pageVisible, true, `POST visible=true pageVisible is ${JSON.stringify(showBody.pageVisible)}`)
    assert.ok(Number.isInteger(showBody.pageVisibleAt) && showBody.pageVisibleAt >= hideBody.pageVisibleAt,
      `POST visible=true pageVisibleAt ${showBody.pageVisibleAt} is not >= ${hideBody.pageVisibleAt}`)
    const shownState = (await readState(harness)).state
    assert.equal(shownState.pageVisible, true, `state pageVisible is ${JSON.stringify(shownState.pageVisible)} after visible=true`)
    assert.equal(shownState.pageVisibleAt, showBody.pageVisibleAt,
      `state pageVisibleAt ${shownState.pageVisibleAt} != POST response ${showBody.pageVisibleAt}`)
    return `POST visible=false -> pageVisible=false (at ${hideBody.pageVisibleAt}); POST visible=true -> true (at ${showBody.pageVisibleAt}); state follows`
  })
  await checkAsync('BV2', 'page-visibility validation: invalid body/oversize -> 400, non-POST -> 405 + Allow: POST', async () => {
    assert.ok(visibilityEntry, `route ${ROUTES.visibility} is not registered`)
    const invalidBodies = ['not-json', '{}', '{"visible":"yes"}', '{"visible":1}']
    for (const rawBody of invalidBodies) {
      const response = await invokeRoute(visibilityEntry.route, { method: 'POST', rawBody })
      assert.equal(response.status, 400, `invalid body ${JSON.stringify(rawBody)} returned ${response.status}, expected 400`)
      assert.match(String(headerValue(response.headers, 'content-type')), /^application\/json/i, '400 content-type is not JSON')
    }
    const oversize = `{"visible":false,"pad":"${'x'.repeat(5000)}"}`
    const oversizeResponse = await invokeRoute(visibilityEntry.route, { method: 'POST', rawBody: oversize })
    assert.equal(oversizeResponse.status, 400, `oversized body returned ${oversizeResponse.status}, expected 400`)
    const getResponse = await invokeRoute(visibilityEntry.route, { method: 'GET' })
    assert.equal(getResponse.status, 405, `GET returned ${getResponse.status}, expected 405`)
    assert.match(String(headerValue(getResponse.headers, 'allow')), /POST/i,
      `405 Allow header is ${JSON.stringify(headerValue(getResponse.headers, 'allow'))}, expected POST`)
    assert.match(String(headerValue(getResponse.headers, 'cache-control')), /no-store/i, '405 cache-control is not no-store')
    return 'invalid JSON/shape x4 -> 400; >4KB body -> 400; GET -> 405 with Allow: POST; all JSON + no-store'
  })
  check('BV3', 'index.js page-visibility static contract (route/state fields/log/token)', () => {
    const source = readText(join(PKG, 'index.js'))
    const required = [
      ['/page-visibility', 'page-visibility route path'],
      ['pageVisible', 'pageVisible state field'],
      ['pageVisibleAt', 'pageVisibleAt state field'],
      ['page visibility:', 'page visibility log line'],
      ['405', '405 status for non-POST'],
      ['Allow', 'Allow: POST header'],
      ['4096', '4KB body limit'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `index.js is missing: ${missingTokens.join(', ')}`)
    return 'index.js: route path + pageVisible/pageVisibleAt + log + 405/Allow + 4096 body limit'
  })
  // 2026-10-28 round 2: page-menu overlay options + minimize routes.
  const overlayOptionEntry = harness.routes.get(ROUTES.overlayOption)
  const overlayOptionRoute = overlayOptionEntry === undefined ? undefined : overlayOptionEntry.route
  await checkAsync('BV4', 'POST /duo-pet/overlay-option: topmost/alwaysShow update state; invalid -> 400; non-POST -> 405', async () => {
    assert.ok(overlayOptionRoute, `route ${ROUTES.overlayOption} is not registered`)
    const get = await invokeRoute(overlayOptionRoute, { method: 'GET' })
    assert.equal(get.status, 405, `GET overlay-option returned ${get.status}, expected 405`)
    assert.match(String(headerValue(get.headers, 'allow')), /POST/i, 'overlay-option 405 Allow is not POST')
    const topmostOff = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { topmost: false } })
    assert.equal(topmostOff.status, 200, `POST {"topmost":false} returned ${topmostOff.status}`)
    const offBody = JSON.parse(topmostOff.body.toString('utf8'))
    assert.equal(offBody.ok, true, `overlay-option ok is ${JSON.stringify(offBody.ok)}`)
    assert.equal(offBody.overlayTopmost, false, `overlayTopmost is ${JSON.stringify(offBody.overlayTopmost)} after {"topmost":false}`)
    assert.equal(offBody.overlayAlwaysShow, false, `overlayAlwaysShow is ${JSON.stringify(offBody.overlayAlwaysShow)} initially`)
    const stateAfterTopmost = (await readState(harness)).state
    assert.equal(stateAfterTopmost.overlayTopmost, false, 'state.overlayTopmost did not follow POST')
    const alwaysOn = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { alwaysShow: true } })
    assert.equal(alwaysOn.status, 200, `POST {"alwaysShow":true} returned ${alwaysOn.status}`)
    const onBody = JSON.parse(alwaysOn.body.toString('utf8'))
    assert.equal(onBody.ok, true, `overlay-option alwaysShow ok is ${JSON.stringify(onBody.ok)}`)
    assert.equal(onBody.overlayAlwaysShow, true, `overlayAlwaysShow is ${JSON.stringify(onBody.overlayAlwaysShow)}`)
    const stateAfterAlways = (await readState(harness)).state
    assert.equal(stateAfterAlways.overlayAlwaysShow, true, 'state.overlayAlwaysShow did not follow POST')
    for (const rawBody of ['{}', '{"topmost":"yes"}', '{"alwaysShow":1}', '[]']) {
      const bad = await invokeRoute(overlayOptionRoute, { method: 'POST', rawBody })
      assert.equal(bad.status, 400, `invalid overlay-option body ${JSON.stringify(rawBody)} returned ${bad.status}, expected 400`)
    }
    const oversize = `{"topmost":false,"pad":"${'x'.repeat(5000)}"}`
    const over = await invokeRoute(overlayOptionRoute, { method: 'POST', rawBody: oversize })
    assert.equal(over.status, 400, `oversized overlay-option body returned ${over.status}, expected 400`)
    return 'GET 405 + Allow: POST; {"topmost":false} & {"alwaysShow":true} -> 200 + state follows; invalid/shape/oversize -> 400'
  })
  await checkAsync('BV5', 'client page-menu 置顶/总是显示 payloads match Host contract (absolute values + toggle compat)', async () => {
    assert.ok(overlayOptionRoute, `route ${ROUTES.overlayOption} is not registered`)
    const clientSource = readText(join(PKG, 'client.js'))
    const bodies = [...clientSource.matchAll(/postJson\(OVERLAY_OPTION_URL,\s*\{([^}]*)\}/g)]
      .map((match) => match[1].replace(/\s+/g, ' ').trim())
    assert.ok(bodies.length >= 2, `client.js has ${bodies.length} postJson(OVERLAY_OPTION_URL) calls, expected 2 (topmost/alwaysShow)`)
    const unsupported = bodies.filter((body) => !/\btopmost\b|\balwaysShow\b/.test(body) || /toggle/i.test(body))
    assert.equal(unsupported.length, 0,
      `client.js sends unsupported overlay-option payloads ${JSON.stringify(unsupported)}; ` +
      'expected absolute {"topmost":boolean} / {"alwaysShow":boolean} from the current Host state')
    assert.match(clientSource, /postJson\(OVERLAY_OPTION_URL,\s*\{\s*topmost:\s*host\.overlayTopmost/,
      'client.js does not send { topmost: !host.overlayTopmost }')
    assert.match(clientSource, /postJson\(OVERLAY_OPTION_URL,\s*\{\s*alwaysShow:\s*host\.overlayAlwaysShow/,
      'client.js does not send { alwaysShow: !host.overlayAlwaysShow }')
    // Absolute values: accepted and reflected in state.
    const absTopmost = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { topmost: false } })
    assert.equal(absTopmost.status, 200, `POST {"topmost":false} returned ${absTopmost.status}`)
    const absTopmostBody = JSON.parse(absTopmost.body.toString('utf8'))
    assert.equal(absTopmostBody.overlayTopmost, false, `absolute topmost did not apply: ${JSON.stringify(absTopmostBody)}`)
    const absAlways = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { alwaysShow: true } })
    assert.equal(absAlways.status, 200, `POST {"alwaysShow":true} returned ${absAlways.status}`)
    const absAlwaysBody = JSON.parse(absAlways.body.toString('utf8'))
    assert.equal(absAlwaysBody.overlayAlwaysShow, true, `absolute alwaysShow did not apply: ${JSON.stringify(absAlwaysBody)}`)
    // Backward compatibility for the old client toggle payloads (index.js fix).
    const toggleTopmost = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { toggleTopmost: true } })
    assert.equal(toggleTopmost.status, 200, `toggleTopmost returned ${toggleTopmost.status}`)
    const toggleTopmostBody = JSON.parse(toggleTopmost.body.toString('utf8'))
    assert.equal(toggleTopmostBody.overlayTopmost, true, `toggleTopmost did not flip: ${JSON.stringify(toggleTopmostBody)}`)
    const toggleAlways = await invokeRoute(overlayOptionRoute, { method: 'POST', body: { toggleAlwaysShow: true } })
    assert.equal(toggleAlways.status, 200, `toggleAlwaysShow returned ${toggleAlways.status}`)
    const toggleAlwaysBody = JSON.parse(toggleAlways.body.toString('utf8'))
    assert.equal(toggleAlwaysBody.overlayAlwaysShow, false, `toggleAlwaysShow did not flip: ${JSON.stringify(toggleAlwaysBody)}`)
    return 'client sends absolute {topmost:!host.overlayTopmost}/{alwaysShow:!host.overlayAlwaysShow}; ' +
      'Host accepts them AND legacy toggle payloads (flip + 200)'
  })
  const minimizeEntry = harness.routes.get(ROUTES.minimize)
  const minimizeRoute = minimizeEntry === undefined ? undefined : minimizeEntry.route
  await checkAsync('BV6', 'POST /duo-pet/minimize: 200 JSON result (QA forces degraded non-win32 path); non-POST -> 405 + Allow', async () => {
    assert.ok(minimizeRoute, `route ${ROUTES.minimize} is not registered`)
    const get = await invokeRoute(minimizeRoute, { method: 'GET' })
    assert.equal(get.status, 405, `GET minimize returned ${get.status}, expected 405`)
    assert.match(String(headerValue(get.headers, 'allow')), /POST/i, 'minimize 405 Allow is not POST')
    // Never spawn powershell.exe / window-probe against the real DSH window during QA:
    // temporarily force the non-win32 early return inside runWindowProbeAction.
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    let post
    try {
      post = await invokeRoute(minimizeRoute, { method: 'POST' })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    assert.equal(post.status, 200, `POST minimize returned ${post.status}, expected 200`)
    const body = JSON.parse(post.body.toString('utf8'))
    assert.equal(body.ok, false, `minimize degraded ok is ${JSON.stringify(body.ok)}`)
    assert.equal(body.found, false, `minimize degraded found is ${JSON.stringify(body.found)}`)
    assert.equal(body.minimized, false, `minimize degraded minimized is ${JSON.stringify(body.minimized)}`)
    return 'GET 405 + Allow: POST; POST (degraded path, no real spawn) -> 200 {ok:false,found:false,minimized:false}'
  })
  check('BV7', 'index.js minimize/overlay-option static contract (routes, window-probe args, state fields)', () => {
    const source = readText(join(PKG, 'index.js'))
    const required = [
      ['/minimize', 'minimize route path'],
      ['/overlay-option', 'overlay-option route path'],
      ['overlayTopmost', 'overlayTopmost state field'],
      ['overlayAlwaysShow', 'overlayAlwaysShow state field'],
      ['window-probe', 'window-probe script reference'],
      ['-Action', 'window-probe -Action argument'],
      ['-ResultPath', 'window-probe -ResultPath argument'],
      ['DshPid', 'window-probe -DshPid argument'],
      ['powershell.exe', 'powershell spawn executable'],
      ['toggleTopmost', 'legacy toggleTopmost compatibility'],
      ['toggleAlwaysShow', 'legacy toggleAlwaysShow compatibility'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `index.js is missing: ${missingTokens.join(', ')}`)
    return 'index.js: /minimize + /overlay-option routes, overlayTopmost/overlayAlwaysShow state, window-probe -Action/-ResultPath/-DshPid spawn'
  })

  // -- cleanup -------------------------------------------------------------
  await checkAsync('B13', 'ctx.effect cleanup: every route disposed, 500ms interval cleared', async () => {
    const routeEntries = [...harness.routes.values()]
    const routeCount = routeEntries.length
    assert.ok(routeCount >= 1, 'no routes registered before cleanup')
    const intervalBefore = harness.timerTrap.intervals.length + harness.ctxIntervals.length
    assert.ok(intervalBefore >= 1, 'no interval/timer was registered at all; cleanup cannot be verified')
    await harness.dispose()
    assert.equal(harness.routes.size, 0, `routes still registered after cleanup: ${[...harness.routes.keys()].join(', ')}`)
    const notDisposed = routeEntries.filter((entry) => !entry.disposed || entry.disposeCalls < 1)
    assert.equal(notDisposed.length, 0,
      `${notDisposed.length}/${routeCount} route disposer(s) were not called by the effect cleanup: ` +
      `${notDisposed.map((entry) => entry.route.path).join(', ')}`)
    const unclearedIntervals = harness.timerTrap.intervals.filter((entry) => !entry.cleared)
    assert.equal(unclearedIntervals.length, 0,
      `${unclearedIntervals.length}/${harness.timerTrap.intervals.length} global interval(s) not cleared after cleanup`)
    const undisposedCtxIntervals = harness.ctxIntervals.filter((entry) => !entry.disposed)
    assert.equal(undisposedCtxIntervals.length, 0,
      `${undisposedCtxIntervals.length}/${harness.ctxIntervals.length} ctx.interval disposer(s) not called`)
    return `routes ${routeCount}->0 (all ${routeCount} disposer(s) called), intervals cleared ` +
      `${harness.timerTrap.intervals.length}/${harness.timerTrap.intervals.length}, ` +
      `ctx intervals disposed ${harness.ctxIntervals.length}/${harness.ctxIntervals.length}`
  })
  harness.timerTrap.restore()

  // -- missing assets (empty assets dir, temp copy) ------------------------
  const missingTmp = join(TMP, `host-missing-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(missingTmp, { recursive: true })
    copyFileSync(indexAbs, join(missingTmp, 'index.js'))
    const captured = []
    const originalError = console.error
    console.error = (...args) => { captured.push(args.map((value) => String(value)).join(' ')) }
    let copyModule = null
    let harnessMissing = null
    let missingError = null
    try {
      copyModule = await freshImport(join(missingTmp, 'index.js'))
      harnessMissing = makeHostHarness()
      harnessMissing.timerTrap.install()
      await copyModule.apply(harnessMissing.ctx)
      await sleep(20)
    } catch (error) {
      missingError = error
    } finally {
      console.error = originalError
    }
    if (missingError) {
      harnessMissing && (await harnessMissing.dispose())
      record('B14', 'missing assets: no throw, null URLs, asset routes not registered', STATUS.FAIL, missingError.message)
    } else {
      await checkAsync('B14', 'missing assets: no throw, null URLs, asset routes not registered', async () => {
        const stateRoute = harnessMissing.routes.get(ROUTES.state)
        assert.ok(stateRoute, 'state route must stay available when assets are missing')
        const { state } = await readState(harnessMissing)
        assertStateShape(state, 'missing-assets')
        assert.equal(state.spriteUrl, null, `spriteUrl is ${JSON.stringify(state.spriteUrl)}, expected null`)
        assert.equal(state.sallyUrl, null, `sallyUrl is ${JSON.stringify(state.sallyUrl)}, expected null`)
        assert.equal(state.doneUrl, null, `doneUrl is ${JSON.stringify(state.doneUrl)}, expected null`)
        for (const path of [ROUTES.sprite, ROUTES.sally, ROUTES.done]) {
          assert.equal(harnessMissing.routes.has(path), false,
            `route ${path} must not be registered when the asset is missing`)
        }
        assert.ok(captured.some((line) => line.includes('[duo-pet]')),
          `no console.error starting with "[duo-pet]" was emitted; captured=${JSON.stringify(captured)}`)
        await harnessMissing.dispose()
        return `console.error calls=${captured.length} (all prefixed [duo-pet]=${captured.every((line) => line.includes('[duo-pet]'))}); state URLs null; only ${ROUTES.state} registered`
      })
    }
  } finally {
    rmSync(missingTmp, { recursive: true, force: true })
  }

  // -- partial assets: only the missing one degrades ----------------------
  if (sheetBytes && sallyBytes && doneBytes) {
    const partialTmp = join(TMP, `host-partial-${process.pid}-${Date.now()}`)
    try {
      mkdirSync(join(partialTmp, 'assets'), { recursive: true })
      copyFileSync(indexAbs, join(partialTmp, 'index.js'))
      copyFileSync(join(PKG, 'assets/spritesheet.png'), join(partialTmp, 'assets', 'spritesheet.png'))
      copyFileSync(join(PKG, 'assets/done.mp3'), join(partialTmp, 'assets', 'done.mp3'))
      const captured = []
      const originalError = console.error
      console.error = (...args) => { captured.push(args.map((value) => String(value)).join(' ')) }
      let partialModule = null
      let partialHarness = null
      let partialError = null
      try {
        partialModule = await freshImport(join(partialTmp, 'index.js'))
        partialHarness = makeHostHarness()
        partialHarness.timerTrap.install()
        await partialModule.apply(partialHarness.ctx)
        await sleep(20)
      } catch (error) {
        partialError = error
      } finally {
        console.error = originalError
      }
      if (partialError) {
        partialHarness && (await partialHarness.dispose())
        record('B15', 'partial assets: only the missing URL/route degrades', STATUS.FAIL, partialError.message)
      } else {
        await checkAsync('B15', 'partial assets: only the missing URL/route degrades', async () => {
          const { state } = await readState(partialHarness)
          assertStateShape(state, 'partial-assets')
          assert.equal(state.sallyUrl, null, `sallyUrl is ${JSON.stringify(state.sallyUrl)}, expected null (only sally.mp3 is missing)`)
          const parsedSprite = parseSpriteUrl(state.spriteUrl)
          assert.ok(parsedSprite,
            `spriteUrl is ${JSON.stringify(state.spriteUrl)}, expected a non-null sprite URL (rev=N[&h=mtimeMs-size])`)
          assert.equal(parsedSprite.rev, 2, `spriteUrl rev is ${parsedSprite.rev}, expected 2`)
          if (parsedSprite.stamp !== null) {
            const copyInfo = statSync(join(partialTmp, 'assets', 'spritesheet.png'))
            assert.equal(parsedSprite.stamp, `${Math.round(copyInfo.mtimeMs)}-${copyInfo.size}`,
              `spriteUrl content stamp h=${parsedSprite.stamp} does not match the partial-copy spritesheet.png`)
          }
          assert.equal(state.doneUrl, ROUTES.done, `doneUrl is ${JSON.stringify(state.doneUrl)}, expected ${ROUTES.done}`)
          assert.equal(partialHarness.routes.has(ROUTES.sally), false, 'sally route must not be registered')
          assert.equal(partialHarness.routes.has(ROUTES.sprite), true, 'sprite route must stay registered')
          assert.equal(partialHarness.routes.has(ROUTES.done), true, 'done route must stay registered')
          await partialHarness.dispose()
          return `sallyUrl=null + route absent; spriteUrl/doneUrl intact; console.error calls=${captured.length}`
        })
      }
    } finally {
      rmSync(partialTmp, { recursive: true, force: true })
    }
  } else {
    notReady('B15', 'partial assets: only the missing URL/route degrades', 'assets missing — cannot build the partial-asset fixture yet')
  }

  // extra: no forbidden meta route even with assets present (already in B4)
  informational('B16', 'state snapshot fields observed', JSON.stringify({ lastState: await readState(harness).catch(() => null) }))
}

/** Synchronous state read for event handlers (route handler may be sync). */
function readStateSync(harness) {
  const entry = harness.routes.get(ROUTES.state)
  if (!entry) throw new Error(`GET ${ROUTES.state} route is not registered`)
  const response = makeResponse()
  const result = entry.route.handler({ method: 'GET', url: ROUTES.state, headers: { host: '127.0.0.1:41810' }, socket: {} }, response)
  if (result && typeof result.then === 'function') {
    throw new Error('state route handler is async; synchronous read is not possible')
  }
  return JSON.parse(Buffer.concat(response.chunks).toString('utf8'))
}

// ---------------------------------------------------------------------------
// Section C: Client half over fake window / react / slots / locale / timer
// ---------------------------------------------------------------------------
function createElementImpl(type, props, ...children) {
  const merged = props === null || props === undefined ? {} : { ...props }
  if (children.length > 0) {
    const existing = merged.children
    const nextChildren = children.length === 1 ? children[0] : children
    if (existing === undefined) merged.children = nextChildren
    else if (Array.isArray(existing)) merged.children = [...existing, ...children]
    else merged.children = [existing, ...children]
  }
  return { $$qaElement: true, type, props: merged }
}
const fakeReact = {
  createElement: createElementImpl,
  Fragment: Symbol.for('react.fragment'),
  StrictMode: Symbol.for('react.strict_mode'),
  useState: () => { throw new Error('QA fake React has no hook runtime; the client component is not rendered by this harness') },
  useRef: () => { throw new Error('QA fake React has no hook runtime') },
  useEffect: () => { throw new Error('QA fake React has no hook runtime') },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
fakeReact.default = fakeReact

function makeStorage(rec) {
  const data = new Map()
  return {
    getItem(key) { rec.storage.push(['get', String(key)]); return data.has(String(key)) ? data.get(String(key)) : null },
    setItem(key, value) { rec.storage.push(['set', String(key), String(value)]); data.set(String(key), String(value)) },
    removeItem(key) { rec.storage.push(['remove', String(key)]); data.delete(String(key)) },
    clear() { rec.storage.push(['clear']); data.clear() },
    key(index) { return Array.from(data.keys())[index] ?? null },
    get length() { return data.size },
  }
}
class FakeAudio {
  constructor(source) {
    this.source = source === undefined ? '' : String(source)
    this.currentTime = 0
    this.volume = 1
    this.loop = false
    this.paused = true
    this.preload = 'auto'
    this.listeners = []
  }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  load() {}
  addEventListener(type, handler) { this.listeners.push([String(type), handler]) }
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

function createClientRuntime(source) {
  const rec = {
    load: [], requires: [], fetch: [], timers: [], listeners: [], storage: [],
    audio: 0, speech: 0, documentAccess: [], compileError: null, factoryError: null,
  }
  const fakeStorage = makeStorage(rec)
  const fakeNavigator = { language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], userAgent: 'qa-harness' }
  const fakeLocation = { href: 'http://127.0.0.1:41810/', origin: 'http://127.0.0.1:41810/', pathname: '/', search: '', hash: '' }
  const fakeWindow = {
    __ModuleLoader__: { load(definition) { rec.load.push(definition) } },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    navigator: fakeNavigator,
    location: fakeLocation,
    localStorage: fakeStorage,
    sessionStorage: fakeStorage,
    matchMedia: (query) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
    addEventListener(type) { rec.listeners.push(['window', String(type)]); return () => {} },
    removeEventListener() {},
    getComputedStyle() { return { getPropertyValue: () => '' } },
    requestAnimationFrame() { rec.timers.push(['window.requestAnimationFrame']); return 0 },
    cancelAnimationFrame() {},
    scrollX: 0,
    scrollY: 0,
  }
  fakeWindow.window = fakeWindow
  const fakeDocument = {
    addEventListener(type) { rec.listeners.push(['document', String(type)]); return () => {} },
    removeEventListener() {},
    createElement(tag) {
      rec.documentAccess.push(['createElement', String(tag)])
      return {
        tagName: String(tag).toUpperCase(), style: {}, dataset: {}, listeners: [],
        setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {},
        addEventListener() {}, removeEventListener() {}, play() { return Promise.resolve() },
        pause() {}, load() {}, classList: { add() {}, remove() {}, toggle() {} },
      }
    },
    querySelector() { rec.documentAccess.push(['querySelector']); return null },
    getElementById() { rec.documentAccess.push(['getElementById']); return null },
    get body() { rec.documentAccess.push(['body']); return null },
    get head() { rec.documentAccess.push(['head']); return null },
    get documentElement() { rec.documentAccess.push(['documentElement']); return null },
  }
  const fakeFetch = (url, init) => {
    rec.fetch.push([String(url), init ?? null])
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'idle', seq: 0, waitingSeq: 0, celebrateSeq: 0, waiting: 0, running: 0, revision: 2, spriteUrl: '/duo-pet/spritesheet.png?rev=2', sallyUrl: '/duo-pet/sally.mp3', doneUrl: '/duo-pet/done.mp3' }),
      text: async () => '{}',
    })
  }
  const fakeSpeech = {
    speak(utterance) { rec.speech += 1; return utterance },
    cancel() {},
    getVoices() { return [] },
  }
  const fakeSetTimeout = (fn, ms) => { rec.timers.push(['setTimeout', ms]); return 0 }
  const fakeSetInterval = (fn, ms) => { rec.timers.push(['setInterval', ms]); return 0 }
  const fakeClear = () => {}
  const fakeRaf = () => { rec.timers.push(['requestAnimationFrame']); return 0 }
  const parameterNames = [
    'window', 'document', 'localStorage', 'sessionStorage', 'fetch',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'navigator', 'location',
    'Audio', 'Image', 'speechSynthesis', 'SpeechSynthesisUtterance',
  ]
  const parameterValues = [
    fakeWindow, fakeDocument, fakeStorage, fakeStorage, fakeFetch,
    fakeSetTimeout, fakeSetInterval, fakeClear, fakeClear,
    fakeRaf, fakeClear, fakeNavigator, fakeLocation,
    FakeAudio, FakeAudio, fakeSpeech, function FakeUtterance(text) { this.text = text },
  ]
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function(...parameterNames, source)
    run(...parameterValues)
  } catch (error) {
    rec.compileError = error
  }
  return { rec, fakeWindow, fakeDocument, fakeStorage, fakeFetch }
}

function makeRequireStub(rec) {
  return (name) => {
    rec.requires.push(String(name))
    if (name === 'react') return fakeReact
    throw new Error(`client.js factory required an unexpected module "${name}" (only "react" is allowed)`)
  }
}

function makeClientApplyHarness(activeLocale = 'zh-CN') {
  const state = {
    injectCalls: [], registrations: [], localeRegisters: [], effectFns: [], effectDisposers: [],
    timeoutCalls: [], intervalCalls: [], getCalls: [], onCalls: [],
  }
  const dicts = new Map()
  const locale = {
    register(namespace, language, dictionary) {
      state.localeRegisters.push({ namespace, language, dictionary })
      dicts.set(`${namespace}/${language}`, dictionary)
      return () => { dicts.delete(`${namespace}/${language}`) }
    },
    unregister(namespace, language) { dicts.delete(`${namespace}/${language}`) },
    bind(namespace) {
      return (key) => {
        const language = String(activeLocale).toLowerCase().startsWith('zh') ? 'zh' : 'en'
        const dictionary = dicts.get(`${namespace}/${language}`) || dicts.get(`${namespace}/en`) || {}
        return dictionary[key] === undefined ? key : dictionary[key]
      }
    },
    getLocale() { return { active: activeLocale, locales: ['zh-CN', 'en-US'] } },
    t(namespace, key) { return this.bind(namespace)(key) },
  }
  const timer = {
    timeout(fn, ms) { state.timeoutCalls.push(ms === undefined ? null : ms); return () => {} },
    interval(fn, ms) { state.intervalCalls.push(ms === undefined ? null : ms); return () => {} },
    clear() {}, clearTimeout() {}, clearInterval() {},
  }
  const slots = {
    inject(name, callback) {
      state.injectCalls.push(String(name))
      return callback()
    },
    register(options, component) {
      state.registrations.push({ options, component })
      return () => {}
    },
    unregister() {},
  }
  const ctx = {
    slots,
    locale,
    timer,
    get(key) {
      state.getCalls.push(String(key))
      if (key === 'slots') return slots
      if (key === 'locale') return locale
      if (key === 'timer') return timer
      if (key === 'logger') return console
      return undefined
    },
    effect(fn) {
      state.effectFns.push(fn)
      const disposer = fn()
      state.effectDisposers.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    timeout(fn, ms) { return timer.timeout(fn, ms) },
    interval(fn, ms) { return timer.interval(fn, ms) },
    on(name, handler) { state.onCalls.push(String(name)); return () => {} },
    console,
  }
  return { ctx, state, dicts }
}

/** Extract { count, durations, perFrameMs, row } from an ANIMATIONS[action] value. */
function animationFacts(value) {
  if (Array.isArray(value)) {
    return { count: value.length, durations: value.filter((item) => typeof item === 'number'), perFrameMs: null, row: null }
  }
  if (!value || typeof value !== 'object') return { count: null, durations: null, perFrameMs: null, row: null }
  const durations = Array.isArray(value.durations)
    ? value.durations.filter((item) => typeof item === 'number')
    : (Array.isArray(value.frames) && value.frames.every((item) => typeof item === 'number')
      ? value.frames.slice() : null)
  let count = null
  if (Array.isArray(value.frames)) count = value.frames.length
  else if (typeof value.frames === 'number') count = value.frames
  else if (typeof value.frameCount === 'number') count = value.frameCount
  else if (typeof value.count === 'number') count = value.count
  else if (durations) count = durations.length
  const perFrameMs = typeof value.ms === 'number' ? value.ms
    : (typeof value.duration === 'number' ? value.duration
      : (typeof value.perFrameMs === 'number' ? value.perFrameMs : null))
  const row = typeof value.row === 'number' ? value.row : null
  return { count, durations, perFrameMs, row }
}

function frameOf(value) {
  if (Array.isArray(value) && value.length >= 2) return { row: value[0], col: value[1] }
  if (value && typeof value === 'object') return { row: value.row, col: value.col }
  return null
}

async function runSectionC(localeJson) {
  const clientAbs = join(PKG, 'client.js')
  if (!exists(clientAbs)) {
    notReady('C0', 'Client half checks (fake loader)', 'client.js missing — cannot exercise the client plugin yet')
    return
  }
  const source = readText(clientAbs)
  const indexSource = exists(join(PKG, 'index.js')) ? readText(join(PKG, 'index.js')) : ''
  const runtime = createClientRuntime(source)
  const rec = runtime.rec

  const c1 = check('C1', 'client.js registers @local/dsh-duo-pet through window.__ModuleLoader__', () => {
    assert.equal(rec.compileError, null,
      `client.js could not be evaluated as a ModuleLoader script: ${rec.compileError && rec.compileError.message}`)
    assert.equal(rec.load.length, 1, `window.__ModuleLoader__.load must be called exactly once, got ${rec.load.length}`)
    const definition = rec.load[0]
    assert.equal(definition.id, PACKAGE_NAME, `module id is ${JSON.stringify(definition.id)}`)
    assert.equal(typeof definition.factory, 'function', 'definition.factory must be a function')
    return `id=${definition.id}; load calls=1; factory=function`
  })
  if (c1 !== STATUS.PASS) return

  let plugin = null
  try {
    plugin = rec.load[0].factory(makeRequireStub(rec))
  } catch (error) {
    rec.factoryError = error
  }
  const sideAfterLoad = { fetch: rec.fetch.length, timers: rec.timers.length, listeners: rec.listeners.length, storage: rec.storage.length, audio: rec.audio }
  if (!plugin) {
    record('C2', 'factory(require) returns { inject, apply, _internals }', STATUS.FAIL,
      `factory threw: ${rec.factoryError && rec.factoryError.message}`)
    return
  }
  check('C2', 'factory(require) returns { inject, apply, _internals }', () => {
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'timer'], `inject is ${JSON.stringify(plugin.inject)}`)
    assert.equal(typeof plugin.apply, 'function', 'apply must be a function')
    assert.ok(plugin._internals && typeof plugin._internals === 'object', '_internals object is missing')
    for (const key of ['ANIMATIONS', 'frameFor', 'durationsOf']) {
      assert.ok(key in plugin._internals, `_internals.${key} is missing`)
    }
    assert.equal(typeof plugin._internals.frameFor, 'function', '_internals.frameFor must be a function')
    assert.equal(typeof plugin._internals.durationsOf, 'function', '_internals.durationsOf must be a function')
    assert.deepEqual([...new Set(rec.requires)], ['react'], `factory required modules ${JSON.stringify(rec.requires)}; only "react" is expected`)
    return `inject=[slots, locale, timer]; apply=function; _internals={ANIMATIONS, frameFor, durationsOf}; requires=[react]`
  })
  check('C3', 'module load + factory evaluation has NO fetch/timer/listener side effects', () => {
    assert.equal(sideAfterLoad.fetch, 0, `fetch called ${sideAfterLoad.fetch} time(s) during load/factory`)
    assert.equal(sideAfterLoad.timers, 0, `global timers called ${sideAfterLoad.timers} time(s) during load/factory`)
    assert.equal(sideAfterLoad.listeners, 0, `window/document listeners added during load/factory: ${sideAfterLoad.listeners}`)
    assert.equal(sideAfterLoad.audio, 0, `Audio objects constructed ${sideAfterLoad.audio} time(s) during load/factory`)
    return `fetch=0, timers=0, listeners=0, Audio constructs=0${sideAfterLoad.storage ? `, storage accesses=${sideAfterLoad.storage} (informational)` : ''}`
  })

  // -- apply() registration ------------------------------------------------
  const applyHarness = makeClientApplyHarness('zh-CN')
  let applyError = null
  try {
    plugin.apply(applyHarness.ctx)
  } catch (error) {
    applyError = error
  }
  if (applyError) {
    record('C4', 'apply(ctx) registers the shell.overlay occupant', STATUS.FAIL, applyError.message)
  } else {
    check('C4', 'apply registers shell.overlay { name, id:"duo-pet", order:120, label:function, component }', () => {
      assert.deepEqual(applyHarness.state.injectCalls, [SHELL_SLOT],
        `ctx.slots.inject called with ${JSON.stringify(applyHarness.state.injectCalls)}`)
      assert.equal(applyHarness.state.registrations.length, 1,
        `expected exactly 1 slots.register call, got ${applyHarness.state.registrations.length}`)
      const { options, component } = applyHarness.state.registrations[0]
      assert.equal(options.name, SHELL_SLOT, `options.name is ${JSON.stringify(options.name)}`)
      assert.equal(options.id, PLUGIN_ROW_ID, `options.id is ${JSON.stringify(options.id)}`)
      assert.equal(options.order, 120, `options.order is ${JSON.stringify(options.order)} (must be number 120)`)
      assert.equal(typeof options.label, 'function', 'options.label must be a thunk')
      assert.equal(typeof component, 'function', 'registered component must be a function')
      return `name=${options.name}; id=${options.id}; order=120; label=function; component=function`
    })
    const registration = applyHarness.state.registrations[0]
    if (registration) {
      check('C5', 'label() thunk resolves localized meta.title (zh + en)', () => {
        const zhLabel = registration.options.label()
        assert.equal(typeof zhLabel, 'string', 'label() must return a string')
        assert.ok(zhLabel.trim().length > 0, 'label() returned an empty string')
        assert.notEqual(zhLabel, 'meta.title', 'label() fell back to the raw key "meta.title"')
        assert.match(zhLabel, /[\u4e00-\u9fff]|Claude|DeepSeek/, `zh label ${JSON.stringify(zhLabel)} is not a plausible title`)
        const enPlugin = rec.load[0].factory(makeRequireStub({ requires: [] }))
        const enHarness = makeClientApplyHarness('en-US')
        enPlugin.apply(enHarness.ctx)
        const enLabel = enHarness.state.registrations[0].options.label()
        assert.equal(typeof enLabel, 'string', 'en label() must return a string')
        assert.ok(enLabel.trim().length > 0, 'en label() returned an empty string')
        if (localeJson.zh && localeJson.zh.meta && typeof localeJson.zh.meta.title === 'string') {
          assert.equal(zhLabel, localeJson.zh.meta.title,
            `zh label ${JSON.stringify(zhLabel)} != locale/zh.json meta.title ${JSON.stringify(localeJson.zh.meta.title)}`)
        }
        if (localeJson.en && localeJson.en.meta && typeof localeJson.en.meta.title === 'string') {
          assert.equal(enLabel, localeJson.en.meta.title,
            `en label ${JSON.stringify(enLabel)} != locale/en.json meta.title ${JSON.stringify(localeJson.en.meta.title)}`)
        }
        return `zh=${JSON.stringify(zhLabel)}; en=${JSON.stringify(enLabel)}`
      })
    }
    check('C6', 'apply registers zh + en locale dictionaries with all required keys', () => {
      const registrations = applyHarness.state.localeRegisters
      assert.ok(registrations.length >= 2, `expected 2 locale.register calls, got ${registrations.length}`)
      const languages = [...new Set(registrations.map((entry) => entry.language))].sort()
      assert.deepEqual(languages, ['en', 'zh'], `registered languages: ${JSON.stringify(languages)}`)
      for (const entry of registrations) {
        assert.equal(entry.namespace, PLUGIN_ROW_ID, `locale namespace is ${JSON.stringify(entry.namespace)}`)
        const flat = flattenLocaleDictionary(entry.dictionary)
        for (const key of REQUIRED_LOCALE_FLAT) {
          const value = flat[key]
          assert.equal(typeof value, 'string', `${entry.language} dictionary key "${key}" is missing or not a string`)
          assert.ok(value.trim().length > 0, `${entry.language} dictionary key "${key}" is empty`)
        }
        if (entry.language === 'zh') {
          assert.equal(flat['bubble.sally'], '盐津虾嘛', `zh bubble.sally is ${JSON.stringify(flat['bubble.sally'])}, expected "盐津虾嘛"`)
          assert.equal(flat['bubble.done'], '任务完成了', `zh bubble.done is ${JSON.stringify(flat['bubble.done'])}, expected "任务完成了"`)
        }
      }
      return `namespace=${PLUGIN_ROW_ID}; languages=[en,zh]; ${REQUIRED_LOCALE_FLAT.length} keys each; zh sally/done exact`
    })
    check('C6b', 'client dictionaries match locale/zh.json + locale/en.json content (SPEC section 8)', () => {
      const mismatches = []
      for (const entry of applyHarness.state.localeRegisters) {
        const json = localeJson[entry.language]
        if (!json) continue
        const clientFlat = flattenLocaleDictionary(entry.dictionary)
        const jsonFlat = flattenLocaleDictionary(json)
        for (const key of REQUIRED_LOCALE_FLAT) {
          if (clientFlat[key] !== jsonFlat[key]) {
            mismatches.push(`${entry.language}.${key}: client=${JSON.stringify(clientFlat[key])} json=${JSON.stringify(jsonFlat[key])}`)
          }
        }
      }
      assert.equal(mismatches.length, 0,
        `${mismatches.length} client-vs-JSON mismatch(es): ${mismatches.slice(0, 6).join(' | ')}`)
      return `zh + en client dictionaries byte-identical to locale/*.json for all ${REQUIRED_LOCALE_FLAT.length} keys`
    })
    check('C7', 'apply(ctx) only registers; no fetch/timers/listeners during apply', () => {
      assert.equal(rec.fetch.length, 0, `fetch called ${rec.fetch.length} time(s) during apply (polling must start on mount)`)
      assert.equal(rec.timers.length, 0, `global timers called ${rec.timers.length} time(s) during apply`)
      assert.equal(rec.listeners.length, 0, `window/document listeners added during apply: ${rec.listeners.length}`)
      assert.equal(applyHarness.state.timeoutCalls.length, 0,
        `ctx.timeout called ${applyHarness.state.timeoutCalls.length} time(s) during apply`)
      assert.equal(applyHarness.state.intervalCalls.length, 0,
        `ctx.interval called ${applyHarness.state.intervalCalls.length} time(s) during apply`)
      return 'fetch=0, timers=0, listeners=0, ctx.timeout/interval=0'
    })
  }

  // -- _internals frame tables --------------------------------------------
  if (plugin._internals) {
    const internals = plugin._internals
    check('C8', '_internals.durationsOf matches SPEC 4.2 exactly (idle 8x250 / snuggle 36x83 / done 12x100)', () => {
      assert.equal(typeof internals.durationsOf, 'function', '_internals.durationsOf is not a function')
      const report = []
      for (const [action, spec] of Object.entries(FRAME_SPEC)) {
        const durations = internals.durationsOf(action)
        assert.ok(Array.isArray(durations), `durationsOf(${action}) did not return an array (got ${typeof durations})`)
        assert.equal(durations.length, spec.count,
          `durationsOf(${action}).length is ${durations.length}, expected ${spec.count}`)
        const bad = durations.filter((ms) => ms !== spec.ms)
        assert.equal(bad.length, 0,
          `durationsOf(${action}) has non-${spec.ms}ms frame durations: ${JSON.stringify(durations)}`)
        const total = durations.reduce((sum, ms) => sum + ms, 0)
        assert.equal(total, spec.total, `durationsOf(${action}) sums to ${total}ms, expected ${spec.total}ms`)
        report.push(`${action}: ${durations.length} frames x ${spec.ms}ms = ${total}ms`)
      }
      return report.join('; ')
    })
    check('C9', '_internals.frameFor maps idle/snuggle rows+cols per SPEC 4.1', () => {
      assert.equal(typeof internals.frameFor, 'function', '_internals.frameFor is not a function')
      const expected = []
      for (let index = 0; index < FRAME_SPEC.idle.count; index += 1) expected.push(['idle', index, 0, index])
      for (let index = 0; index < FRAME_SPEC.snuggle.count; index += 1) expected.push(['snuggle', index, 1 + Math.floor(index / 12), index % 12])
      for (let index = 0; index < FRAME_SPEC.done.count; index += 1) expected.push(['done', index, 4, index])
      const failures = []
      for (const [action, index, row, col] of expected) {
        const actual = frameOf(internals.frameFor(action, index))
        if (!actual || actual.row !== row || actual.col !== col) {
          failures.push(`${action}[${index}] -> ${JSON.stringify(internals.frameFor(action, index))}, expected {row:${row}, col:${col}}`)
        }
      }
      assert.equal(failures.length, 0, `${failures.length} frameFor mismatch(es): ${failures.slice(0, 8).join(' | ')}`)
      return `all ${expected.length} frame indices map correctly (idle 0-7 row0; snuggle i -> row 1+floor(i/12), col i%12; done row4)`
    })
    check('C10', '_internals.ANIMATIONS carries per-action frame count + durations', () => {
      const animations = internals.ANIMATIONS
      assert.ok(animations && typeof animations === 'object', '_internals.ANIMATIONS is missing/not an object')
      const report = []
      const problems = []
      for (const [action, spec] of Object.entries(FRAME_SPEC)) {
        const facts = animationFacts(animations[action])
        if (facts.count !== spec.count) problems.push(`${action}.count=${JSON.stringify(facts.count)}, expected ${spec.count}`)
        if (Array.isArray(facts.durations)) {
          if (facts.durations.length !== spec.count || facts.durations.some((ms) => ms !== spec.ms)) {
            problems.push(`${action}.durations=${JSON.stringify(facts.durations)}`)
          }
        } else if (facts.perFrameMs !== null) {
          if (facts.perFrameMs !== spec.ms) problems.push(`${action}.ms=${facts.perFrameMs}, expected ${spec.ms}`)
        } else {
          problems.push(`${action} exposes no frame durations in ANIMATIONS`)
        }
        report.push(`${action}: count=${facts.count}, duration source=${Array.isArray(facts.durations) ? `durations[${facts.durations.length}]` : `${facts.perFrameMs}ms/frame`}`)
      }
      assert.equal(problems.length, 0, `ANIMATIONS mismatch: ${problems.join('; ')}`)
      return report.join('; ')
    })
  }

  // -- safe exit when services are missing ---------------------------------
  await checkAsync('C11', 'apply() exits safely with console.error when slots/locale are missing', async () => {
    const captured = []
    const originalError = console.error
    console.error = (...args) => { captured.push(args.map((value) => String(value)).join(' ')) }
    try {
      const safePlugin = rec.load[0].factory(makeRequireStub({ requires: [] }))
      assert.doesNotThrow(() => {
        safePlugin.apply({
          get() { return undefined },
          effect(fn) { return fn() },
          on() { return () => {} },
        })
      }, 'apply(ctx) threw when ctx.slots/ctx.locale were missing (SPEC 7.1: console.error and exit safely)')
    } finally {
      console.error = originalError
    }
    assert.ok(captured.length > 0, 'no console.error was emitted when slots/locale were missing')
    assert.ok(captured.some((line) => line.includes('[duo-pet]')),
      `console.error messages are not prefixed with "[duo-pet]": ${JSON.stringify(captured)}`)
    return `${captured.length} console.error call(s), prefixed: ${captured.every((line) => line.includes('[duo-pet]'))}`
  })

  // -- static contract tokens ---------------------------------------------
  check('C12', 'client.js static contract tokens (state URL, snuggle action, ?av=2, in-page menu, visibility guard, retry, fallback)', () => {
    const tokens = [
      [ROUTES.state, 'state poll URL /duo-pet/state'],
      ['/duo-pet/spritesheet.png', 'sprite URL'],
      [POSITION_KEY, 'localStorage position key'],
      [SHELL_SLOT, 'slot name shell.overlay'],
      ['.duopet-', 'scoped .duopet- CSS prefix'],
      ['no-store', 'cache:"no-store" poll fetch'],
      ["startPlayback('snuggle')", "snuggle playback action (2026-10-28 final requirement)"],
      ['av=2', 'authorization voice cache-bust ?av=2'],
      ['dv=2', 'done voice cache-bust ?dv=2'],
      ['setTimer(load, 600)', 'sprite load retry timer 600ms'],
      ['🧡💙', 'emoji sprite fallback 🧡💙'],
      ['onContextMenu', 'in-page right-click menu handler'],
      ['duopet-menu', 'in-page right-click menu CSS class'],
      ['menu.snuggle', 'localized menu key menu.snuggle'],
      // 2026-10-28 final fix: do not play in-page audio while the page is hidden
      // (the desktop overlay owns the sound when the window is minimized).
      ['pageHidden', 'page visibility guard pageHidden()'],
      ['visibilityState', 'document.visibilityState check'],
      // 2026-10-28 page-visibility coordination with the desktop overlay.
      ['VISIBILITY_URL', 'page-visibility report URL constant'],
      ['/duo-pet/page-visibility', 'page-visibility endpoint path'],
      ['visibilitychange', 'visibilitychange listener'],
      ['lastReportedVisibleRef', 'dedupe ref for visibility reports'],
      ['keepalive', 'keepalive POST flag'],
      // 2026-10-28 round 2: unified page menu (minimize DSH + overlay options).
      ['MINIMIZE_URL', 'minimize route constant'],
      ['OVERLAY_OPTION_URL', 'overlay-option route constant'],
      ['postJson', 'best-effort JSON POST helper'],
      ['menu.minimizeDsh', 'menu label key menu.minimizeDsh'],
      ['menu.action', 'menu label key menu.action'],
      ['menu.topmost', 'menu label key menu.topmost'],
      ['menu.alwaysShow', 'menu label key menu.alwaysShow'],
      ['menu.closePet', 'menu label key menu.closePet'],
      ['bubble.closed', 'closed-pet bubble text key'],
    ]
    const missing = tokens.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missing.length, 0, `client.js is missing: ${missing.join(', ')}`)
    assert.equal(source.includes("startPlayback('lick')"), false,
      "client.js still has the removed lick action (contract is now 'snuggle')")
    assert.equal(source.includes("startPlayback('pat')"), false,
      "client.js still has the superseded pat action (final requirement is 'snuggle')")
    const has500 = /\b500\b/.test(source)
    const external = (source.match(/https?:\/\//g) || []).length
    return `${tokens.length}/${tokens.length} contract tokens present; snuggle action + in-page context menu + pageHidden visibility guard + no lick/pat action; ` +
      `poll 500ms literal=${has500}; external URL occurrences=${external}`
  })
  check('C13b', 'geometry 286x312 / top offset 170 / final compact bubble (left:25px, bottom calc(100% - 91px), tail 45px)', () => {
    const numberConst = (name) => {
      const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\d.]+)`))
      assert.ok(match, `client.js has no numeric constant ${name}`)
      return Number(match[1])
    }
    const CELL = numberConst('CELL')
    const CELL_H = numberConst('CELL_H')
    const COLS = numberConst('COLS')
    const ROWS = numberConst('ROWS')
    const SCALE = numberConst('SCALE')
    assert.equal(CELL, 440, 'CELL must be 440')
    assert.equal(CELL_H, 480, 'CELL_H must be 480')
    assert.equal(COLS, 12, 'COLS must be 12')
    assert.equal(ROWS, 5, 'ROWS must be 5')
    assert.equal(SCALE, 0.65, 'SCALE must be 0.65 (v2)')
    const W = CELL * SCALE
    const H = CELL_H * SCALE
    assert.equal(W, 286, `CELL*SCALE must be 286, got ${W}`)
    assert.equal(H, 312, `CELL_H*SCALE must be 312, got ${H}`)
    assert.equal(W * COLS, 3432, `COLS*W must be 3432, got ${W * COLS}`)
    assert.equal(H * ROWS, 1560, `ROWS*H must be 1560, got ${H * ROWS}`)
    assert.equal(numberConst('DEFAULT_BOTTOM_OFFSET'), 170,
      'SPEC 7.2 v2: default top = max(0, innerHeight-312-170) -> DEFAULT_BOTTOM_OFFSET must be 170')
    assert.match(source, /const\s+W\s*=\s*CELL\s*\*\s*SCALE/, 'W is not defined as CELL * SCALE')
    assert.match(source, /const\s+H\s*=\s*CELL_H\s*\*\s*SCALE/, 'H is not defined as CELL_H * SCALE')
    assert.match(source, /const\s+SPRITE_WIDTH\s*=\s*COLS\s*\*\s*W/, 'SPRITE_WIDTH is not COLS * W')
    assert.match(source, /const\s+SPRITE_HEIGHT\s*=\s*ROWS\s*\*\s*H/, 'SPRITE_HEIGHT is not ROWS * H')
    assert.match(source, /viewport\.height\s*-\s*H\s*-\s*DEFAULT_BOTTOM_OFFSET/,
      'default top does not use innerHeight - H - 170')
    assert.match(source, /Math\.max\(0,\s*\(viewport\.width\s*-\s*W\)\s*\/\s*2\)/,
      'default left does not use max(0, (innerWidth-286)/2)')
    assert.match(source, /backgroundSize:\s*`\$\{SPRITE_WIDTH\}px \$\{SPRITE_HEIGHT\}px`/,
      'sprite background-size is not COLS*W x ROWS*H (3432x1560)')
    assert.match(source, /backgroundPosition:\s*`\$\{-\(frameInfo\.col \* W\)\}px \$\{-\(frameInfo\.row \* H\)\}px`/,
      'sprite background-position is not -(col*286)px -(row*312)px')
    const bubbleStart = source.indexOf('.duopet-bubble {')
    assert.ok(bubbleStart > -1, '.duopet-bubble CSS block is missing')
    const bubbleBlock = source.slice(bubbleStart, source.indexOf('}', bubbleStart))
    for (const token of ['position: absolute;', 'left: 25px;', 'bottom: calc(100% - 91px);', 'margin-bottom: 0;', 'max-width: 150px;', 'padding: 4px 10px;', 'font: 12px/1.35', 'pointer-events: none;']) {
      assert.ok(bubbleBlock.includes(token), `.duopet-bubble is missing "${token}" (2026-10-28 compact bubble v2)`)
    }
    const tailStart = source.indexOf('.duopet-bubble::after')
    assert.ok(tailStart > -1, 'bubble tail (.duopet-bubble::after) is missing')
    const tailBlock = source.slice(tailStart, source.indexOf('}', tailStart))
    assert.ok(tailBlock.includes('left: 45px;'), 'bubble tail is not anchored at left: 45px (2026-10-28 compact bubble v2)')
    assert.ok(tailBlock.includes('border: 6px solid transparent;'), 'bubble tail border is not 6px (2026-10-28 compact bubble v2)')
    return 'CELL=440/CELL_H=480/COLS=12/ROWS=5/SCALE=0.65 -> 286x312; background-size 3432x1560; ' +
      'default left=max(0,(innerWidth-286)/2), top=max(0,innerHeight-312-170); ' +
      'compact bubble v2 left:25px / bottom:calc(100% - 91px) / margin:0 / max-width:150px / font:12px; tail left:45px border:6px'
  })
  check('C13c', 'asset revision: index.js REVISION=2 and `?rev=2` consistent in state + client DEFAULT_SPRITE_URL', () => {
    assert.match(indexSource, /const\s+REVISION\s*=\s*2\b/,
      'index.js REVISION is not 2 (v2 art requires a cache-busting revision bump)')
    assert.match(indexSource, /\/spritesheet\.png\?rev=\$\{REVISION\}/,
      'index.js sprite URL does not interpolate REVISION')
    assert.match(source, /DEFAULT_SPRITE_URL\s*=\s*'\/duo-pet\/spritesheet\.png\?rev=2'/,
      "client.js DEFAULT_SPRITE_URL is not '/duo-pet/spritesheet.png?rev=2'")
    assert.match(source, /INITIAL_HOST_STATE[\s\S]*?spriteUrl:\s*DEFAULT_SPRITE_URL/,
      'client.js INITIAL_HOST_STATE does not use DEFAULT_SPRITE_URL')
    // The live /duo-pet/state revision + spriteUrl are asserted at runtime in B5.
    return 'index.js REVISION=2 + `?rev=${REVISION}`; client.js DEFAULT_SPRITE_URL=/duo-pet/spritesheet.png?rev=2; ' +
      'live state revision=2 & spriteUrl rev=2 verified in B5'
  })
  check('C13d', 'sprite hit-testing: drag/click only on opaque character pixels (alpha > 16)', () => {
    const required = [
      ['spriteImageRef', 'sprite image ref'],
      ['hitCanvasRef', 'offscreen hit canvas ref'],
      ['spriteHit', 'spriteHit() pixel probe'],
      ['getImageData', 'canvas pixel read'],
      ['data[3]', 'alpha channel read'],
      ['alpha > 16', 'solid-pixel threshold'],
      ['if (!spriteHit(event)) return', 'transparent pixels do not start a drag'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `client.js is missing: ${missingTokens.join(', ')}`)
    return 'client hit-test: spriteImageRef + hitCanvasRef + spriteHit(getImageData .data[3], alpha > 16) gates pointerdown'
  })
  check('C13e', 'interaction hit region = current-frame character bbox (+bubble); transparent root passes clicks through', () => {
    const required = [
      ['duopet-hit', '.duopet-hit interaction layer'],
      ['PET_BOX', 'PET_BOX fallback bbox constant'],
      ['pointer-events: none', 'transparent root does not intercept pointer events'],
      ['pointer-events: auto', 'hit layer intercepts pointer events'],
      ['hitBox', 'hitBox computed from the current frame bbox (+bubble)'],
      ['rootRef', 'rootRef used for drag coordinates'],
      ['computeCellBox', 'per-frame alpha bbox helper'],
      ['cellBoxRef', 'per-frame bbox cache ref'],
      ['frameFor(playback.action, frame)', 'current action frame used for the bbox'],
      ['fallback', 'fallback to PET_BOX when the frame bbox is unavailable'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `client.js is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /const PET_BOX = \{[\s\S]{0,200}?left:/, 'PET_BOX bbox constant is not defined')
    assert.match(source, /const frameBox = computeCellBox\(currentPos\.row, currentPos\.col\)/,
      'hitBox does not use computeCellBox(currentPos.row, currentPos.col)')
    assert.match(source, /className: 'duopet-hit'/, 'render tree does not create the .duopet-hit layer')
    return 'client hit region: .duopet-hit + per-frame computeCellBox/cellBoxRef (fallback PET_BOX) + hitBox (+bubble merge) + ' +
      'root pointer-events:none + rootRef'
  })
  check('C14', 'client page menu: 5 first-level entries, Action submenu, dynamic topmost/alwaysShow labels', () => {
    const required = [
      ['MINIMIZE_URL', 'minimize endpoint constant'],
      ['OVERLAY_OPTION_URL', 'overlay-option endpoint constant'],
      ['postJson(MINIMIZE_URL', 'minimize POST call'],
      ['postJson(OVERLAY_OPTION_URL', 'overlay-option POST call'],
      ["translate('menu.minimizeDsh')", 'minimize DSH menu label'],
      ["translate('menu.action')", 'action submenu label'],
      ["translate('menu.topmost')", 'topmost (on) label'],
      ["translate('menu.untopmost')", 'untopmost (off) label'],
      ["translate('menu.alwaysShow')", 'always show (on) label'],
      ["translate('menu.cancelAlwaysShow')", 'cancel always-show (off) label'],
      ["translate('menu.closePet')", 'close pet menu label'],
      ['setPetClosed(true)', 'close-pet session state'],
      ['bubble.closed', 'closed-pet bubble text'],
      ['normalizeHostState', 'normalizeHostState()'],
      ['overlayTopmost', 'overlayTopmost state field'],
      ['overlayAlwaysShow', 'overlayAlwaysShow state field'],
      // Submenu (hover/click expands to the right).
      ['duopet-menu-parent', 'Action parent menu item class'],
      ['duopet-menu-arrow', 'submenu arrow class'],
      ['duopet-submenu', 'floating submenu class'],
      ['subOpen', 'subOpen state'],
      ['setSubOpen(true)', 'submenu opens on hover/click'],
      ['setSubOpen(false)', 'submenu closes on leave/selection'],
      ['onPointerLeave', 'menu container closes the submenu on leave'],
      ["translate('menu.snuggle')", 'submenu snuggle item'],
      ["translate('menu.celebrate')", 'submenu celebrate item'],
      ["translate('menu.idle')", 'submenu idle item'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `client.js is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /host\.overlayTopmost === true \? translate\('menu\.untopmost'\) : translate\('menu\.topmost'\)/,
      'topmost label is not dynamic (untopmost when on, topmost when off)')
    assert.match(source, /host\.overlayAlwaysShow === true \? translate\('menu\.cancelAlwaysShow'\) : translate\('menu\.alwaysShow'\)/,
      'alwaysShow label is not dynamic (cancelAlwaysShow when on, alwaysShow when off)')
    const order = ['menu.minimizeDsh', 'menu.action', 'menu.untopmost', 'menu.cancelAlwaysShow', 'menu.closePet']
      .map((key) => source.indexOf(`translate('${key}')`))
    assert.ok(order.every((idx) => idx >= 0), 'menu label order probe failed (missing translate calls)')
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] > order[i - 1], `first-level menu item order is wrong: ${JSON.stringify(order)}`)
    }
    return 'page menu: 最小化 DSH / 动作▸(贴贴·庆祝·待机 floating submenu) / 置顶↔取消置顶 / 总是显示↔取消总是显示 / 关闭桌宠; ' +
      'Action parent + arrow + duopet-submenu + subOpen + onPointerLeave; dynamic labels from host.overlayTopmost/overlayAlwaysShow'
  })
  informational('C13', 'static geometry constants (informational)', (() => {
    const grab = (name) => {
      const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\d.]+)`))
        || source.match(new RegExp(`\\b${name}\\s*=\\s*([\\d.]+)`))
      return match ? Number(match[1]) : null
    }
    const facts = {
      CELL: grab('CELL'), CELL_H: grab('CELL_H'), COLS: grab('COLS'), ROWS: grab('ROWS'), SCALE: grab('SCALE'),
      DRAG_THRESHOLD: grab('DRAG_THRESHOLD'),
      backgroundSize3432: source.includes('3432'), backgroundSize1560: source.includes('1560'),
    }
    const expected = { CELL: 440, CELL_H: 480, COLS: 12, ROWS: 5, SCALE: 0.65 }
    const mismatches = Object.entries(expected).filter(([key, value]) => facts[key] !== value)
    return `expected ${JSON.stringify(expected)}; found ${JSON.stringify(facts)}` +
      (mismatches.length ? ` — MISMATCH: ${mismatches.map(([key]) => key).join(', ')}` : '') +
      `; display=286x312 background-size 3432x1560 tokens=${facts.backgroundSize3432 && facts.backgroundSize1560}`
  })())
}

// ---------------------------------------------------------------------------
// Section D: art/audio assets (Python + Pillow + ffmpeg)
// ---------------------------------------------------------------------------
function runSectionD() {
  if (!exists(ASSET_SCRIPT)) {
    notReady('D0', 'asset suite (dev/verify-assets.py)', `missing ${ASSET_SCRIPT}`)
    return
  }
  if (!exists(PYTHON)) {
    record('D0', 'asset suite (dev/verify-assets.py)', STATUS.FAIL,
      `python not found at ${PYTHON} (set DUO_PET_PYTHON/--python); Pillow is required`)
    return
  }
  mkdirSync(TMP, { recursive: true })
  rmSync(ASSET_REPORT, { force: true })
  const result = spawnSync(PYTHON, [ASSET_SCRIPT, '--json', ASSET_REPORT, '--pkg', PKG], {
    cwd: HERE,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 300_000,
  })
  if (result.error) {
    record('D0', 'asset suite (dev/verify-assets.py)', STATUS.FAIL,
      `failed to run python: ${result.error.code || result.error.message}`)
    return
  }
  if (!exists(ASSET_REPORT)) {
    record('D0', 'asset suite (dev/verify-assets.py)', STATUS.FAIL,
      `asset suite produced no report (exit ${result.status}); stderr shown above`)
    return
  }
  let report = null
  try {
    report = JSON.parse(readFileSync(ASSET_REPORT, 'utf8'))
  } catch (error) {
    record('D0', 'asset suite (dev/verify-assets.py)', STATUS.FAIL, `asset report is not JSON: ${error.message}`)
    return
  }
  for (const row of report.rows || []) {
    rows.push({
      id: row.id,
      title: row.title,
      pass: row.status === STATUS.PASS,
      status: row.status,
      evidence: String(row.evidence ?? ''),
    })
    severityOf.set(row.id, 'required')
    console.log(`[${row.status}] ${row.id} ${row.title} :: ${String(row.evidence ?? '')}`)
  }
  assetEvidence = report.evidence || {}
}

// ---------------------------------------------------------------------------
// Section E: locale completeness + package coverage (SPEC 10 item 5)
// ---------------------------------------------------------------------------
function runSectionE(localeJson) {
  const zh = localeJson.zh
  const en = localeJson.en
  if (!zh || !en) {
    notReady('E1', 'locale zh/en key completeness', 'locale/zh.json and/or locale/en.json missing or unparsable')
    return
  }
  check('E1', 'locale zh/en carry meta.title/description + 4 bubble keys, non-empty', () => {
    const problems = []
    for (const [language, dictionary] of [['zh', zh], ['en', en]]) {
      const flat = flattenLocaleDictionary(dictionary)
      for (const key of REQUIRED_LOCALE_FLAT) {
        const value = flat[key]
        if (typeof value !== 'string' || value.trim() === '') problems.push(`${language}.${key} missing/empty`)
      }
    }
    assert.equal(problems.length, 0, problems.join('; '))
    assert.equal(flattenLocaleDictionary(zh)['bubble.sally'], '盐津虾嘛',
      `zh bubble.sally is ${JSON.stringify(flattenLocaleDictionary(zh)['bubble.sally'])}`)
    assert.equal(flattenLocaleDictionary(zh)['bubble.done'], '任务完成了',
      `zh bubble.done is ${JSON.stringify(flattenLocaleDictionary(zh)['bubble.done'])}`)
    assert.match(String(zh.meta.title), /[\u4e00-\u9fff]/,
      `zh meta.title ${JSON.stringify(zh.meta.title)} has no CJK characters`)
    assert.notEqual(zh.meta.title, zh.meta.description, 'zh title equals description')
    assert.notEqual(en.meta.title, en.meta.description, 'en title equals description')
    // 2026-10-28 final requirement: the description must describe Claude and
    // DeepSeek snuggling for 3 seconds (not the removed lick/pat wording).
    const zhDescription = String(zh.meta.description)
    const enDescription = String(en.meta.description)
    assert.match(zhDescription, /贴贴|贴住|依偎/, `zh meta.description is stale (no snuggling wording): ${JSON.stringify(zhDescription)}`)
    assert.match(zhDescription, /5\s*秒|五秒/, `zh meta.description does not mention the 5-second loop: ${JSON.stringify(zhDescription)}`)
    assert.match(enDescription, /snuggle/i, `en meta.description is stale (no "snuggle"): ${JSON.stringify(enDescription)}`)
    assert.match(enDescription, /5\s*seconds|five seconds/i, `en meta.description does not mention the 5-second loop: ${JSON.stringify(enDescription)}`)
    return `zh title=${JSON.stringify(zh.meta.title)}; en title=${JSON.stringify(en.meta.title)}; sally/done zh exact; ` +
      'descriptions describe the 5s snuggle (no lick/pat wording)'
  })
  informational('E2', 'README.md documentation coverage', (() => {
    const readmePath = join(PKG, 'README.md')
    if (!exists(readmePath)) return 'README.md missing'
    const readme = readText(readmePath)
    const groups = {
      purpose: ['用途', '桌宠', 'desk pet', 'purpose'],
      loop: ['5', '3'],
      approval: ['授权', 'approval', '等待'],
      done: ['完成', 'celebrate', 'done'],
      assets: ['spritesheet', '素材'],
      install: ['安装', 'install', 'plugin_manager'],
      uninstall: ['卸载', 'uninstall', 'remove'],
      limits: ['限制', '自动播放', 'autoplay'],
    }
    const missing = Object.entries(groups)
      .filter(([, tokens]) => !tokens.some((token) => readme.toLowerCase().includes(token.toLowerCase())))
      .map(([label]) => label)
    return `bytes=${readme.length}; missing topics: ${missing.length ? missing.join(', ') : 'none'}`
  })())
}

// ---------------------------------------------------------------------------
// Section F: desktop floating overlay (2026-10-28 addition)
// ---------------------------------------------------------------------------
function runSectionF(pkg) {
  const missing = DESKTOP_FILES.filter((rel) => !exists(join(PKG, rel)))
  if (missing.length > 0) {
    notReady('F1', 'desktop overlay files present', `missing: ${missing.join(', ')}`)
    return
  }
  check('F1', 'desktop overlay files present', () => DESKTOP_FILES
    .map((rel) => `${rel}=${statSync(join(PKG, rel)).size}B`).join('; '))

  check('F2', 'desktop/*.ps1 are ASCII-only (no byte > 127)', () => {
    const report = []
    for (const rel of DESKTOP_FILES.filter((file) => file.endsWith('.ps1'))) {
      const buf = readFileSync(join(PKG, rel))
      let badOffset = -1
      for (let index = 0; index < buf.length; index += 1) {
        if (buf[index] > 127) { badOffset = index; break }
      }
      assert.equal(badOffset, -1,
        `${rel} contains a non-ASCII byte 0x${badOffset >= 0 ? buf[badOffset].toString(16) : '??'} at offset ${badOffset}`)
      report.push(`${rel}: ${buf.length}B all bytes <128`)
    }
    return report.join('; ')
  })

  check('F3', 'desktop/messages.json is UTF-8 JSON with the sally/done bubbles', () => {
    const abs = join(PKG, 'desktop/messages.json')
    const buf = readFileSync(abs)
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
      'messages.json starts with a UTF-8 BOM (expected plain UTF-8)')
    const parsed = JSON.parse(buf.toString('utf8'))
    assert.equal(parsed.bubble && parsed.bubble.sally, '盐津虾嘛',
      `messages.json bubble.sally is ${JSON.stringify(parsed.bubble && parsed.bubble.sally)}`)
    assert.equal(parsed.bubble && parsed.bubble.done, '任务完成了',
      `messages.json bubble.done is ${JSON.stringify(parsed.bubble && parsed.bubble.done)}`)
    const requiredMenuKeys = ['openDsh', 'action', 'actionSnuggle', 'actionCelebrate', 'actionIdle',
      'topmostOn', 'topmostOff', 'alwaysShowOn', 'alwaysShowOff', 'closePet']
    const missingMenuKeys = requiredMenuKeys.filter((key) => !(parsed.menu
      && typeof parsed.menu[key] === 'string' && parsed.menu[key].trim() !== ''))
    assert.equal(missingMenuKeys.length, 0,
      `messages.json menu is missing/empty for: ${missingMenuKeys.join(', ')} (have ${JSON.stringify(Object.keys(parsed.menu || {}))})`)
    return `bubble.sally=${JSON.stringify(parsed.bubble.sally)}; bubble.done=${JSON.stringify(parsed.bubble.done)}; ` +
      `menu keys=${Object.keys(parsed.menu).length} (required ${requiredMenuKeys.length} present)`
  })

  if (pkg) {
    check('F4', 'package.json files[] covers desktop/*.ps1 + desktop/messages.json', () => {
      const patterns = (Array.isArray(pkg.files) ? pkg.files.map(String) : []).map(globToRegExp)
      const uncovered = DESKTOP_FILES.filter((rel) => !patterns.some((re) => re.test(rel)))
      assert.equal(uncovered.length, 0, `files[] does not cover: ${uncovered.join(', ')}`)
      return `files[] covers ${DESKTOP_FILES.join(', ')}`
    })
  } else {
    notReady('F4', 'package.json files[] covers desktop files', 'package.json missing or unparsable')
  }

  const indexAbs = join(PKG, 'index.js')
  if (!exists(indexAbs)) {
    notReady('F5', 'index.js desktop overlay integration tokens', 'index.js missing')
    return
  }
  check('F5', 'index.js integrates the desktop overlay (spawn / disable env / cleanup)', () => {
    const source = readText(indexAbs)
    const required = [
      ['startDesktopOverlay', 'startDesktopOverlay()'],
      ['spawn(', 'child_process spawn'],
      ['DSH_DUO_PET_DESKTOP_DISABLE', 'DSH_DUO_PET_DESKTOP_DISABLE env flag'],
      ['pet-overlay.ps1', 'overlay script path'],
      ['stopOverlay', 'overlay stopper'],
      ['child.kill()', 'process kill on cleanup'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `index.js is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /ctx\.effect\(\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]*?stopOverlay\(\)/,
      'ctx.effect cleanup does not call stopOverlay()')
    return 'startDesktopOverlay + spawn + DSH_DUO_PET_DESKTOP_DISABLE + pet-overlay.ps1 + stopOverlay()/child.kill() in cleanup'
  })

  // Desktop overlay v3: right-click menu + DSH window restore helpers.
  check('F6', 'window-probe.ps1 v3 has Find-DshWindowHandle + Restore-DshWindow + -Action minimize/restore CLI', () => {
    const probeAbs = join(PKG, 'desktop/window-probe.ps1')
    assert.ok(exists(probeAbs), 'desktop/window-probe.ps1 is missing')
    const source = readText(probeAbs)
    const required = [
      ['Find-DshWindowHandle', 'Find-DshWindowHandle'],
      ['Restore-DshWindow', 'Restore-DshWindow'],
      ['SW_RESTORE', 'SW_RESTORE'],
      ['SW_MINIMIZE', 'SW_MINIMIZE'],
      ['BringWindowToTop', 'BringWindowToTop'],
      ['SetForegroundWindow', 'SetForegroundWindow'],
      ['IsIconic', 'IsIconic verification'],
      ['-Action', '-Action CLI argument'],
      ['minimize', 'minimize action'],
      ['restore', 'restore action'],
      ['ResultPath', '-ResultPath output file'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `window-probe.ps1 is missing: ${missingTokens.join(', ')}`)
    return 'window-probe v3: Find-DshWindowHandle + Restore-DshWindow + SW_MINIMIZE/SW_RESTORE + IsIconic + ' +
      '-Action minimize|restore + -ResultPath'
  })
  check('F7', 'pet-overlay.ps1 v3.4 menu/geometry/hit-test + page-visible sound coordination + hidden guard + -DebugBubble/-DebugEventHidden/-DebugPageVisible', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['requiredMenuKeys', 'requiredMenuKeys validation'],
      ['actionSnuggle', 'actionSnuggle menu item'],
      ['actionCelebrate', 'actionCelebrate menu item'],
      ['actionIdle', 'actionIdle menu item'],
      ['topmostOn', 'topmostOn menu item'],
      ['closePet', 'closePet menu item'],
      ['Get-MenuLabel', 'menu label localization'],
      ['BubbleRoot', 'bubble root element'],
      ['Collapsed', 'bubble collapsed by default'],
      ['BubbleHeadGap', 'bubble tail gap above Claude head'],
      ['-DebugBubble', '-DebugBubble test hook'],
      ['bubble geometry', 'bubble geometry log'],
      ['headTop', 'bubble geometry head top'],
      ['bottomMargin', 'bubble geometry bottom margin'],
      ['context menu ready', 'context menu ready log'],
      // 2026-10-28 final fix: layered-window hit brush + explicit right-button menu opening.
      ['HitTestBrush', 'transparent hit-test brush'],
      ['FromArgb(1, 255, 255, 255)', 'alpha=1 white hit brush color (#01FFFFFF)'],
      ['PreviewMouseRightButtonUp', 'right-button preview handler'],
      ['MouseRightButtonUp', 'right-button handler'],
      ['Open-ContextMenuAtMouse', 'explicit context menu opener'],
      ['PlacementMode', 'menu placement mode'],
      ['::MousePoint', 'menu placement at mouse point'],
      ['context-menu-open', 'context menu open log'],
      ['context menu opened', 'context menu opened log'],
      // 2026-10-28 final fix: hidden overlay must skip sound/bubble without queuing.
      ['Test-OverlayVisible', 'overlay visibility guard'],
      ['sound skipped (hidden)', 'hidden sound skip log'],
      ['bubble skipped (hidden)', 'hidden bubble skip log'],
      ['Stop-OverlaySound', 'stop audio when hiding'],
      ['DebugEventHidden', '-DebugEventHidden test hook'],
      ['no queued sound replay', 'hidden skip is not queued/replayed'],
      // 2026-10-28 page-visibility coordination: overlay owns audio when the page is hidden.
      ['Get-StateBool', 'tri-state pageVisible parser'],
      ['Get-SoundDecision', 'sound ownership decision helper'],
      ['sound decision', 'sound decision log'],
      ['DebugPageVisible', '-DebugPageVisible test hook'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    // The automatic WPF ContextMenu binding was removed; the menu is opened explicitly.
    assert.equal(/\$script:Window\.ContextMenu\s*=/.test(source), false,
      'pet-overlay.ps1 still assigns $script:Window.ContextMenu (automatic binding must stay removed)')
    return 'pet-overlay v3.4: menu keys/actions + BubbleRoot Collapsed + BubbleHeadGap + -DebugBubble + geometry log + ' +
      'HitTestBrush #01FFFFFF + PreviewMouseRightButtonUp/Open-ContextMenuAtMouse + PlacementMode.MousePoint + ' +
      'context-menu-open logs + Test-OverlayVisible hidden sound/bubble guard (no queued replay) + -DebugEventHidden + ' +
      'Get-StateBool/Get-SoundDecision pageVisible coordination (-DebugPageVisible, sound decision log); ' +
      'no Window.ContextMenu auto-binding'
  })
  check('F8', 'overlay drag hit-testing: alpha>16 gating via Get-FrameAlpha/Test-PetAlphaAtPoint (+-DebugIdleMs)', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['Get-FrameAlpha', 'cached per-cell alpha plane'],
      ['Test-PetAlphaAtPoint', 'pointer alpha probe'],
      ['MouseLeftButtonDown', 'left-button drag handler'],
      ['DragAlphaThreshold', 'alpha threshold constant'],
      ['drag skipped (transparent pixel)', 'transparent drag skip log'],
      ['left click skipped (transparent pixel)', 'transparent click skip log'],
      ['DebugIdleMs', '-DebugIdleMs test hook'],
      ['FrameAlphaKey', 'alpha plane cache key'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /DragAlphaThreshold\s*=\s*16/, 'DragAlphaThreshold is not 16')
    assert.match(source, /Test-PetAlphaAtPoint[\s\S]{0,300}?MouseLeftButtonDown|MouseLeftButtonDown[\s\S]{0,300}?Test-PetAlphaAtPoint/,
      'MouseLeftButtonDown handler does not reference Test-PetAlphaAtPoint')
    return 'overlay drag hit-test: Get-FrameAlpha (cached FrameAlphaKey) + Test-PetAlphaAtPoint + MouseLeftButtonDown + ' +
      'DragAlphaThreshold=16 + transparent drag/click skip logs + -DebugIdleMs'
  })
  check('F9', 'overlay hit region: per-frame AlphaBounds + CellBoundsCache + WM_NCHITTEST HTCLIENT/HTTRANSPARENT + HitSurface (+bubble merge)', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['AlphaBounds', 'per-cell alpha bbox scanner'],
      ['CellBoundsCache', 'per-frame bbox cache'],
      ['hit-region (', 'hit-region log'],
      ['WM_NCHITTEST', 'WM_NCHITTEST hook'],
      ['HTTRANSPARENT', 'transparent outside-region hit result'],
      ['HTCLIENT', 'HTCLIENT inside-region hit result'],
      ['HitSurface', 'HitSurface hit rectangle'],
      ['Update-HitSurface', 'HitSurface update helper'],
      ['nchittest', 'nchittest log'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /AlphaBounds\([^)]*,\s*16\)/,
      'AlphaBounds is not called with the alpha>16 threshold')
    assert.match(source, /AddHook\(/, 'WM_NCHITTEST HwndSource hook is not installed')
    return 'overlay hit region: AlphaBounds(per-frame alpha>16) + CellBoundsCache + WM_NCHITTEST hook -> HTCLIENT/HTTRANSPARENT + ' +
      'HitSurface/Update-HitSurface + hit-region/nchittest logs'
  })
  check('F10', 'overlay window tight to current-frame person bbox; bubble temporarily expands upward', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['window-size (frame', 'per-frame window-size log'],
      ['ImageLeft', 'image horizontal margin to align the bbox'],
      ['ImageTop', 'image vertical margin to align the bbox'],
      ['BubbleExtra', 'temporary extra height while a bubble is shown'],
      ['bubble expand', 'bubble expand log'],
      ['bubble collapse', 'bubble collapse log'],
      ['DebugFreeze', '-DebugFreeze test hook'],
      ['PersonW', 'window width from the person bbox'],
      ['PersonH', 'window height from the person bbox'],
      ['FrameImage.Margin', 'image margin shift to the bbox top-left'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /window-size \(frame \{0\},\{1\}\)/,
      'window-size log does not report the current frame row/col')
    assert.match(source, /bubble expand: bubbleH=/, 'bubble expand log is missing the expanded height')
    assert.match(source, /bubble collapse: window=/, 'bubble collapse log is missing the restored window')
    assert.match(source, /\$script:BubbleExtra\s*=\s*/, 'BubbleExtra is never assigned')
    return 'overlay window: PersonW/PersonH from per-frame bbox + ImageLeft/ImageTop margin + window-size (frame r,c) log + ' +
      'BubbleExtra & bubble expand/collapse for temporary upward expansion + -DebugFreeze'
  })
  check('F11', 'overlay absolute screen anchor: AnchorX/AnchorY + clamped target, no incremental Left/Top drift', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['AnchorX', 'absolute anchor X'],
      ['AnchorY', 'absolute anchor Y'],
      ['Get-ClampedWindowPosition', 'clamp-to-virtual-screen helper'],
      ['Update-AnchorFromWindow', 'anchor refresh helper'],
      ['drift-check', 'periodic drift-check log'],
      ['VirtualScreenLeft', 'virtual screen left bound'],
      ['VirtualScreenWidth', 'virtual screen width'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /\$targetLeft = \[double\]\$script:AnchorX - \(\$newW \/ 2\)/,
      'window Left is not computed absolutely as AnchorX - W/2')
    assert.match(source, /\$targetTop = \[double\]\$script:AnchorY - \$newH/,
      'window Top is not computed absolutely as AnchorY - H')
    assert.match(source, /Get-ClampedWindowPosition \$targetLeft \$targetTop \$newW \$newH/,
      'target position is not clamped via Get-ClampedWindowPosition')
    assert.equal(/\.Left\s*-=/.test(source), false,
      'incremental `.Left -=` drifting operation is still present')
    assert.equal(/\.Top\s*-=/.test(source), false,
      'incremental `.Top -=` drifting operation is still present')
    return 'overlay absolute anchor: AnchorX/AnchorY + targetLeft=AnchorX-W/2 & targetTop=AnchorY-H + ' +
      'Get-ClampedWindowPosition (VirtualScreen bounds) + Update-AnchorFromWindow + drift-check; no incremental Left/Top -='
  })
  check('F12', 'overlay pageVisible visibility ownership + Host overlay options sync (topmost/alwaysShow)', () => {
    const overlayAbs = join(PKG, 'desktop/pet-overlay.ps1')
    assert.ok(exists(overlayAbs), 'desktop/pet-overlay.ps1 is missing')
    const source = readText(overlayAbs)
    const required = [
      ['Update-Visibility', 'visibility updater'],
      ['page visible', 'reason: pageVisible=true -> hidden'],
      ['page hidden', 'reason: pageVisible=false -> shown'],
      ['always show', 'AlwaysShow override'],
      ['OverlayTopmost', 'OverlayTopmost state'],
      ['AlwaysShow', 'AlwaysShow state'],
      ['overlay-option', 'overlay-option endpoint'],
      ['Send-OverlayOption', 'option POST helper'],
      ['overlayTopmost', 'Host state field overlayTopmost'],
      ['overlayAlwaysShow', 'Host state field overlayAlwaysShow'],
      ['window-probe', 'window-probe fallback'],
      ['shown ({0})', 'shown log with reason'],
      ['hidden ({0})', 'hidden log with reason'],
    ]
    const missingTokens = required.filter(([token]) => !source.includes(token)).map(([, label]) => label)
    assert.equal(missingTokens.length, 0, `pet-overlay.ps1 is missing: ${missingTokens.join(', ')}`)
    assert.match(source, /pageVisible -eq \$true[\s\S]{0,200}?shouldShow = \$false/,
      'pageVisible=true does not hide the overlay')
    assert.match(source, /pageVisible -eq \$false[\s\S]{0,200}?shouldShow = \$true/,
      'pageVisible=false does not show the overlay')
    assert.match(source, /Apply-State\(/, 'Apply-State is missing (Host option sync)')
    return 'overlay: pageVisible=true -> hidden / false -> shown / null -> window-probe fallback; AlwaysShow override; ' +
      'overlayTopmost/overlayAlwaysShow applied from Host; menu options POST back to /duo-pet/overlay-option'
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Never spawn the real desktop overlay window during QA runs.
  process.env.DSH_DUO_PET_DESKTOP_DISABLE = '1'
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  const evidence = {
    generatedBy: 'qa-verifier',
    harness: 'D:\\plugging\\.dsh-duo-pet\\dev\\verify-bundle.mjs',
    spec: 'D:\\plugging\\.dsh-duo-pet\\SPEC.md',
    packageDir: PKG,
    nodeBinary: NODE_BIN,
    nodeVersion: process.version,
    python: PYTHON,
    files: {},
    assets: {},
  }
  const missingAny = RUNTIME_FILES.filter((rel) => !exists(join(PKG, rel)))
  evidence.missing = missingAny
  if (missingAny.length) console.log(`[INFO] package under test is incomplete; missing: ${missingAny.join(', ')}`)

  if (exists(PKG)) {
    for (const rel of listFilesRecursive(PKG).sort()) {
      try { evidence.files[rel] = { bytes: statSync(join(PKG, rel)).size, sha256: sha256(join(PKG, rel)) } } catch { /* noop */ }
    }
  }

  let localeJson = {}
  let pkgJson = null
  try {
    const sectionA = runSectionA()
    localeJson = sectionA.locale || {}
    pkgJson = sectionA.pkg || null
  } catch (error) {
    record('A0', 'Section A (files/syntax/manifest)', STATUS.FAIL, `harness error: ${error.message}`)
  }
  try {
    await runSectionB()
  } catch (error) {
    record('B0', 'Section B (Host half)', STATUS.FAIL, `harness error: ${error.message}`)
  }
  try {
    await runSectionC(localeJson)
  } catch (error) {
    record('C0', 'Section C (Client half)', STATUS.FAIL, `harness error: ${error.message}`)
  }
  try {
    runSectionD()
  } catch (error) {
    record('D0', 'Section D (assets)', STATUS.FAIL, `harness error: ${error.message}`)
  }
  try {
    runSectionE(localeJson)
  } catch (error) {
    record('E0', 'Section E (locale/package coverage)', STATUS.FAIL, `harness error: ${error.message}`)
  }
  try {
    runSectionF(pkgJson)
  } catch (error) {
    record('F0', 'Section F (desktop overlay)', STATUS.FAIL, `harness error: ${error.message}`)
  }

  // -----------------------------------------------------------------------
  // Verdict + report
  // -----------------------------------------------------------------------
  evidence.assets = assetEvidence
  const counts = {}
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1
  const requiredFails = rows.filter((row) => row.status === STATUS.FAIL && severityOf.get(row.id) !== 'informational')
  const notReadyRows = rows.filter((row) => row.status === STATUS.NOTREADY)
  let exitCode = 0
  let verdict = 'PASS'
  if (notReadyRows.length > 0) { exitCode = 2; verdict = 'NOT-READY' }
  else if (requiredFails.length > 0) { exitCode = 1; verdict = 'FAIL' }

  console.log('\n================ DUO-PET QA SUMMARY ================')
  for (const row of rows) {
    if (row.status === STATUS.PASS || row.status === STATUS.INFO) continue
    console.log(`${row.status.padEnd(10)} ${row.id.padEnd(8)} ${row.title}`)
    console.log(`${''.padEnd(10)} -> ${row.evidence}`)
  }
  console.log('----------------------------------------------------')
  console.log(`checks: ${rows.length}; counts: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ')}`)
  console.log(`verdict: ${verdict}`)
  console.log('====================================================')

  const report = {
    generatedAt: new Date().toISOString(),
    packageDir: PKG,
    nodeBinary: NODE_BIN,
    nodeVersion: process.version,
    verdict,
    exitCode,
    counts,
    evidence,
    rows,
  }
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true })
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`report: ${REPORT_PATH}`)
  } catch (error) {
    console.log(`could not write JSON report: ${error.message}`)
  }
  return exitCode
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error('HARNESS INTERNAL ERROR:', error && error.stack ? error.stack : error)
    process.exitCode = 3
  })
