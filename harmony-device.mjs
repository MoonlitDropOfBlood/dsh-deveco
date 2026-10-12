/**
 * harmony-device.mjs — zero-dep Node ESM.
 *
 * Wraps the `devecocli` CLI used by the HarmonyOS toolchain and provides
 * parsers for HiLog line output and ArkUI layout JSON dumps.
 *
 * Design notes
 * - Zero dependencies. Only `node:child_process` (spawn), `node:fs`
 *   (existsSync) and `node:path` (join) are used.
 * - The `resolved` object passed around describes which CLI source the user has
 *   configured. The shape is:
 *     { source: 'devecocli'|'studio'|'clt'|'none', exec?, path? }
 *   `exec` is the absolute path to a devecocli executable when source is
 *   'devecocli'. `path` is the install root for 'studio'/'clt'.
 * - Current CLT 26 / DevEco Studio 6 bundles expose device, log and UI
 *   operations natively on devecocli (`device list|view`, `log`,
 *   `ui layout|screenshot|click|swipe|text`). There is NO
 *   `devecocli device hdc` passthrough, so every operation routes through
 *   the devecocli surface directly.
 * - One exception: devecocli has NO IP/TCP connect command (its `device`
 *   subcommands are only list/view/file/sqlite3). For IP connections we call
 *   the SDK-bundled `hdc tconn <ip>:<port>` directly; `resolveHdc` mirrors
 *   devecocli's own lookup order (DEVECO_SDK_HOME → DEVECO_HOME → Studio/CLT
 *   install root → PATH) to find the binary.
 * - All process invocations go through `execCli` / `execHdc` so error /
 *   timeout / non-zero exit semantics are uniform.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 1. Executable resolution
// ---------------------------------------------------------------------------

function isWindows () {
  return process.platform === 'win32'
}

/**
 * Resolve the devecocli executable path for a resolved toolchain.
 *
 * Every device/log/UI operation in current CLT 26 / DevEco Studio 6 bundles
 * is a native devecocli subcommand, so this single executable covers
 * everything; no standalone hdc fallback is required.
 *
 * @param {object} resolved Toolchain resolution.
 * @returns {string|null} Executable path, or null when unsupported/missing.
 */
export function devecoExec (resolved) {
  if (!resolved || !resolved.source) return null
  if (resolved.source === 'devecocli') {
    return resolved.exec || null
  }
  if (resolved.source === 'studio' || resolved.source === 'clt') {
    if (!resolved.path) return null
    const sep = isWindows() ? '\\' : '/'
    const bin = isWindows() ? 'devecocli.cmd' : 'devecocli'
    return `${resolved.path.replace(/[\/]+$/, '')}${sep}bin${sep}${bin}`
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Process execution
// ---------------------------------------------------------------------------

/**
 * Run devecocli with the given args, collecting stdout/stderr.
 *
 * Uses spawn with `shell: true` on Windows so .cmd shims resolve correctly;
 * the (possibly space-containing) executable path is pre-quoted for cmd.exe.
 *
 * @param {object} resolved Toolchain resolution.
 * @param {string[]} args devecocli args (e.g. ['device', 'list']).
 * @param {object} [opts]
 * @param {number} [opts.timeout] Default 30000.
 * @param {object} [opts.env] Extra env vars.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
export function execCli (resolved, args, opts = {}) {
  const timeout = opts.timeout ?? 30000
  const env = { ...process.env, ...(opts.env || {}) }
  const cmd = devecoExec(resolved)
  if (!cmd) {
    return Promise.reject(withProps(new Error(`execCli: unsupported or incomplete source "${resolved && resolved.source}"`), { code: null, stdout: '', stderr: '' }))
  }
  return spawnCollect(cmd, args, { timeout, env })
}

function spawnCollect (cmd, argv, { timeout, env, shell }) {
  return new Promise((resolve, reject) => {
    // Windows `shell: true` (needed for .cmd shims) hands the whole command
    // line to cmd.exe, which CANNOT resolve an unquoted executable path
    // containing spaces (e.g. "...\DevEco Studio\...") — quote it ourselves.
    // Real .exe binaries (hdc.exe) should pass shell:false and let libuv
    // quote the path instead.
    const useShell = shell !== undefined ? shell : isWindows()
    const file = useShell && isWindows() ? `"${cmd}"` : cmd
    let proc
    try {
      proc = spawn(file, argv, {
        shell: useShell,
        windowsHide: true,
        timeout,
        env
      })
    } catch (err) {
      reject(withProps(err instanceof Error ? err : new Error(String(err)), { code: null, stdout: '', stderr: '' }))
      return
    }

    let stdout = ''
    let stderr = ''
    // Track our own timeout: on Windows a timeout kill reports `code=null`,
    // which is indistinguishable from a signal-kill otherwise. Callers use
    // `timedOut` to tell "hung and we killed it" apart from a real failure.
    let timedOut = false
    const timer = timeout > 0
      ? setTimeout(() => { timedOut = true }, timeout)
      : null
    if (timer && typeof timer.unref === 'function') timer.unref()
    proc.stdout.on('data', d => { stdout += d.toString('utf8') })
    proc.stderr.on('data', d => { stderr += d.toString('utf8') })

    proc.on('error', err => {
      if (timer) clearTimeout(timer)
      reject(withProps(err instanceof Error ? err : new Error(String(err)), { code: null, stdout, stderr, timedOut }))
    })

    proc.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code !== 0) {
        const msg = timedOut
          ? `Command timed out after ${timeout}ms: ${cmd} ${argv.join(' ')}`
          : `Command failed (${code}): ${cmd} ${argv.join(' ')}`
        reject(withProps(new Error(msg), { code, stdout, stderr, timedOut }))
        return
      }
      resolve({ stdout, stderr, code })
    })
  })
}

function withProps (err, extra) {
  for (const k of Object.keys(extra)) err[k] = extra[k]
  return err
}

// ---------------------------------------------------------------------------
// 3. HiLog
// ---------------------------------------------------------------------------

export const LEVEL_SEVERITY = Object.freeze({
  D: 0,
  I: 1,
  W: 2,
  E: 3,
  F: 4
})

const LEVEL_BADGE = Object.freeze({
  D: 'DEBUG',
  I: 'INFO',
  W: 'WARN',
  E: 'ERROR',
  F: 'FATAL'
})

/**
 * Convert a HiLog single-letter level to a UI badge label.
 * Unknown letters map to '?'.
 *
 * @param {string} level
 * @returns {string}
 */
export function formatHilogLevel (level) {
  if (level == null) return '?'
  const upper = String(level).toUpperCase()
  return LEVEL_BADGE[upper] || '?'
}

/**
 * Build argv for `devecocli log` (one-shot history read).
 *
 * `--level` accepts a single letter (D/I/W/E/F); multi-letter sets from the
 * UI (e.g. "DI") are dropped here — level filtering then happens client-side.
 *
 * @param {object} [opts]
 * @param {string} [opts.device] serial or name → `--device`
 * @param {string} [opts.level] D|I|W|E|F → `--level`
 * @param {string} [opts.bundle] bundle name → `--bundle-name`
 * @param {string} [opts.keyword] grep → `--keyword`
 * @param {number} [opts.tail=500] tail lines → `--tail`
 * @param {string} [opts.from] start offset → `--from`
 * @param {string} [opts.to] end offset → `--to`
 * @returns {string[]}
 */
export function buildHilogArgs (opts = {}) {
  const args = ['log']
  if (opts.device) args.push('--device', opts.device)
  if (opts.level && /^[DIWEF]$/.test(opts.level)) args.push('--level', opts.level)
  if (opts.bundle) args.push('--bundle-name', opts.bundle)
  if (opts.keyword) args.push('--keyword', opts.keyword)
  if (opts.from) args.push('--from', opts.from)
  if (opts.to) args.push('--to', opts.to)
  const tail = opts.tail ?? 500
  args.push('--tail', String(tail))
  return args
}

/**
 * Build argv for a live `devecocli log --follow` stream. Mirrors
 * `buildHilogArgs` but never includes `--tail`/`--from`/`--to` (live
 * streaming is unbounded and starts from now).
 *
 * @param {object} [opts]
 * @returns {string[]}
 */
export function buildHilogFollowArgs (opts = {}) {
  const args = ['log', '--follow']
  if (opts.device) args.push('--device', opts.device)
  if (opts.level && /^[DIWEF]$/.test(opts.level)) args.push('--level', opts.level)
  if (opts.bundle) args.push('--bundle-name', opts.bundle)
  if (opts.keyword) args.push('--keyword', opts.keyword)
  return args
}

// Format: 01-01 12:34:56.789  1234  5678 I  0FFFF/AudioManager: msg
const HILOG_RE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([\dA-F]+)\/([^:]+):\s?(.*)$/

/**
 * Parse one HiLog line.
 *
 * @param {string} line
 * @returns {{
 *   timestamp: string,
 *   pid: number,
 *   tid: number,
 *   level: string,
 *   domain: string,
 *   tag: string,
 *   message: string
 * } | null}
 */
export function parseHilogLine (line) {
  if (!line) return null
  // Tolerate trailing whitespace / newlines.
  const trimmed = line.replace(/[\r\n]+$/, '')
  if (!trimmed) return null
  const m = HILOG_RE.exec(trimmed)
  if (!m) return null
  return {
    timestamp: m[1],
    pid: Number(m[2]),
    tid: Number(m[3]),
    level: m[4],
    domain: m[5],
    tag: m[6],
    message: m[7]
  }
}

// ---------------------------------------------------------------------------
// 4. ArkUI Inspector
// ---------------------------------------------------------------------------

/**
 * Build argv for `devecocli ui layout --format json`.
 *
 * Window targeting (real CLI surface, verified on DevEco CLI 26):
 *   `--window <id>`  only that window (mutually exclusive with --all-windows)
 *   `--all-windows`  include every window (each window appears as a WindowScene)
 *
 * @param {object} [opts]
 * @param {string} [opts.device]
 * @param {string|number} [opts.windowId] Restrict the dump to one window id.
 * @param {boolean} [opts.allWindows] Dump every window (multi-window apps).
 * @returns {string[]}
 */
export function buildUiDumpArgs (opts = {}) {
  const args = ['ui', 'layout', '--format', 'json']
  if (opts.device) args.push('--device', opts.device)
  // `--window` and `--all-windows` are mutually exclusive; an explicit windowId
  // wins so a stale allWindows flag can never break the call.
  if (opts.windowId !== undefined && opts.windowId !== null && opts.windowId !== '') {
    args.push('--window', String(opts.windowId))
  } else if (opts.allWindows) {
    args.push('--all-windows')
  }
  return args
}

/**
 * Build argv for `devecocli ui window list --format json [--all]`.
 *
 * @param {object} [opts]
 * @param {string} [opts.device]
 * @param {boolean} [opts.all] Include system windows (status bar, gesture nav).
 * @returns {string[]}
 */
export function buildUiWindowListArgs (opts = {}) {
  const args = ['ui', 'window', 'list', '--format', 'json']
  if (opts.device) args.push('--device', opts.device)
  if (opts.all) args.push('--all')
  return args
}

/**
 * Parse `devecocli ui window list --format json` output.
 *
 * Real shape: `[{ id, name, pid, displayId, focused }, ...]`. Tolerates a stray
 * non-JSON prefix (progress lines go to stderr but be safe) the same way the
 * layout parser does.
 *
 * @param {string} stdout
 * @returns {Array<{id:number,name:string,pid:number,displayId:number,focused:boolean}>}
 */
export function parseUiWindowListJson (stdout) {
  if (!stdout) return []
  const text = String(stdout)
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(text.slice(start, end + 1))
  } catch (_) {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((w) => w && typeof w === 'object' && w.id !== undefined && w.id !== null)
    .map((w) => ({
      id: Number(w.id),
      name: typeof w.name === 'string' ? w.name : '',
      pid: Number(w.pid) || 0,
      displayId: Number(w.displayId) || 0,
      focused: w.focused === true,
    }))
}

/**
 * Build argv for `devecocli ui screenshot`.
 *
 * @param {object} [opts]
 * @param {string} [opts.device]
 * @param {string} [opts.path] Host-side destination file (required by the CLI).
 * @returns {string[]}
 */
export function buildUiScreenshotArgs (opts = {}) {
  const args = ['ui', 'screenshot']
  if (opts.device) args.push('--device', opts.device)
  if (opts.path) args.push('--path', opts.path)
  return args
}

/**
 * Build argv for `devecocli ui click <x> <y>`.
 *
 * @param {object} opts
 * @param {string} [opts.device]
 * @param {number|string} opts.x
 * @param {number|string} opts.y
 * @returns {string[]}
 */
export function buildUiTapArgs (opts = {}) {
  const args = ['ui', 'click']
  if (opts.device) args.push('--device', opts.device)
  args.push(String(opts.x), String(opts.y))
  return args
}

/**
 * Build argv for `devecocli ui swipe <x1> <y1> <x2> <y2>`.
 *
 * @param {object} opts
 * @param {string} [opts.device]
 * @param {number|string} [opts.speed] pixels per second → `--speed`
 * @returns {string[]}
 */
export function buildUiSwipeArgs (opts = {}) {
  const args = ['ui', 'swipe']
  if (opts.device) args.push('--device', opts.device)
  args.push(String(opts.x1), String(opts.y1), String(opts.x2), String(opts.y2))
  if (opts.speed !== undefined && opts.speed !== null && opts.speed !== '') {
    args.push('--speed', String(opts.speed))
  }
  return args
}

/**
 * Build argv for `devecocli ui text <text>`.
 *
 * @param {object} opts
 * @param {string} [opts.device]
 * @param {string} opts.text
 * @returns {string[]}
 */
export function buildUiTextArgs (opts = {}) {
  const args = ['ui', 'text']
  if (opts.device) args.push('--device', opts.device)
  args.push(String(opts.text))
  return args
}

/**
 * Parse `[left,top][right,bottom]` bounds string (kept for the boundsStr
 * format emitted alongside parsed layout nodes).
 *
 * @param {string} b
 * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}}
 */
export function parseBounds (b) {
  if (!b) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b)
  if (!m) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  const left = Number(m[1])
  const top = Number(m[2])
  const right = Number(m[3])
  const bottom = Number(m[4])
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  }
}

/**
 * Parse `devecocli ui layout --format json` output into a flat list of node
 * summaries (depth-first, matching the old uitest uiDump wire shape so the
 * client needs no changes).
 *
 * Layout JSON shape: `[{ id?, type?, bounds: [l, t, r, b], children: [...] }]`.
 * Progress lines go to stderr, but any stray non-JSON prefix is tolerated by
 * slicing from the first `[` to the last `]`.
 *
 * Every node carries the id of the window it belongs to: the dump marks window
 * roots with a `WindowScene` node whose `id` is `session<NN>`, matching the ids
 * reported by `devecocli ui window list` (verified: `session11` ↔ id 11).
 *
 * @param {string} stdout
 * @returns {Array<{
 *   index: number,
 *   depth: number,
 *   parentIndex: number,
 *   windowId: number,
 *   text: string,
 *   resourceId: string,
 *   className: string,
 *   bounds: {left:number,top:number,right:number,bottom:number,width:number,height:number},
 *   boundsStr: string
 * }>}
 */
/**
 * Extract the numeric window id from a `WindowScene` node.
 *
 * The layout dump names window roots `session<NN>` (e.g. `session31`), while
 * `devecocli ui window list` reports the same window as `{ id: 31 }`. Returns 0
 * when the node is not a window root or the id has no numeric suffix.
 *
 * @param {{id?: unknown, type?: unknown}} n
 * @returns {number}
 */
function windowIdFromNode (n) {
  if (!n || typeof n !== 'object') return 0
  const m = /^session(\d+)$/.exec(String(n.id || ''))
  return m ? Number(m[1]) : 0
}

export function parseUiLayoutJson (stdout) {  if (!stdout) return []
  const text = String(stdout)
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let roots
  try {
    roots = JSON.parse(text.slice(start, end + 1))
  } catch (_) {
    return []
  }
  if (!Array.isArray(roots)) return []
  const nodes = []
  // Read a box-model side (padding/margin) that may be a number or a
  // [t, r, b, l] / [v, h] / scalar triple in the layout JSON. Returns
  // { top, right, bottom, left } with 0 defaults.
  const side = (v) => {
    const z = { top: 0, right: 0, bottom: 0, left: 0 }
    if (typeof v === 'number' && Number.isFinite(v)) {
      return { top: v, right: v, bottom: v, left: v }
    }
    if (Array.isArray(v)) {
      const n = v.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0))
      if (n.length === 1) return { top: n[0], right: n[0], bottom: n[0], left: n[0] }
      if (n.length === 2) return { top: n[0], right: n[1], bottom: n[0], left: n[1] }
      if (n.length === 3) return { top: n[0], right: n[1], bottom: n[2], left: n[1] }
      if (n.length >= 4) return { top: n[0], right: n[1], bottom: n[2], left: n[3] }
    }
    return z
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const visit = (n, depth, parentIndex, windowId) => {
    if (!n || typeof n !== 'object') return
    const b = Array.isArray(n.bounds) ? n.bounds : []
    const left = Number(b[0]) || 0
    const top = Number(b[1]) || 0
    const right = Number(b[2]) || 0
    const bottom = Number(b[3]) || 0
    const myIndex = nodes.length
    // A window starts at its `WindowScene` node, whose id is `session<NN>`
    // (verified: session11/session31 ↔ `ui window list` ids 11/31). Every
    // descendant inherits that window id so the client can group/filter.
    const isScene = n.type === 'WindowScene'
    const ownWindow = isScene ? windowIdFromNode(n) : windowId
    // Preserve any extra scalar attributes the layout JSON carries so the
    // properties pane can show them without a schema change per field.
    const attrs = {}
    for (const [k, v] of Object.entries(n)) {
      if (k === 'children' || k === 'bounds' || k === 'text' || k === 'id' || k === 'type') continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[k] = v
      else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) attrs[k] = v.join(',')
    }
    nodes.push({
      index: myIndex,
      depth,
      parentIndex,
      windowId: ownWindow,
      text: typeof n.text === 'string' ? n.text : '',
      resourceId: typeof n.id === 'string' ? n.id : '',
      className: typeof n.type === 'string' ? n.type : '',
      bounds: { left, top, right, bottom, width: right - left, height: bottom - top },
      boundsStr: `[${left},${top}][${right},${bottom}]`,
      padding: side(n.padding),
      margin: side(n.margin),
      borderWidth: num(n.borderWidth),
      borderRadius: num(n.borderRadius),
      borderColor: typeof n.borderColor === 'string' ? n.borderColor : '',
      opacity: Number.isFinite(Number(n.opacity)) ? Number(n.opacity) : 1,
      visible: n.visible !== false,
      enabled: n.enabled !== false,
      clickable: n.clickable === true,
      attrs
    })
    if (Array.isArray(n.children)) {
      for (const c of n.children) visit(c, depth + 1, myIndex, ownWindow)
    }
  }
  for (const r of roots) visit(r, 0, -1, 0)
  return nodes
}

/**
 * Build argv for `hdc shell uitest dumpLayout -p <devicePath>`.
 *
 * Why hdc and not `devecocli ui layout`: the CLI filters the device dump down to
 * `id/type/text/bounds/children/clickable/longClickable/scrollable/
 * hitTestBehavior` and **drops `origBounds` entirely** — but `bounds` is only the
 * *visible* rect (clipped by scrolling parents and occluded by other windows), so
 * it under-reports List items and anything partly off-screen. The device-side
 * dump carries the true layout rect in `origBounds` plus far more attributes.
 *
 * @param {string} devicePath Absolute path on the device, e.g. /data/local/tmp/x.json
 * @param {object} [opts]
 * @param {boolean} [opts.all] `-i` = do not merge windows (keep them separate)
 * @returns {string[]}
 */
export function buildUiRawDumpArgs (devicePath, opts = {}) {
  const args = ['shell', 'uitest', 'dumpLayout', '-p', devicePath]
  if (opts.all) args.push('-i')
  return args
}

/**
 * Build argv for `hdc file recv <devicePath> <localPath>`.
 *
 * @param {string} devicePath
 * @param {string} localPath
 * @returns {string[]}
 */
export function buildUiRawRecvArgs (devicePath, localPath) {
  return ['file', 'recv', devicePath, localPath]
}

/**
 * Build argv for `hdc shell rm -f <devicePath>` (best-effort cleanup).
 *
 * @param {string} devicePath
 * @returns {string[]}
 */
export function buildUiRawCleanArgs (devicePath) {
  return ['shell', 'rm', '-f', devicePath]
}

/**
 * Parse a raw `uitest dumpLayout` document into the same flat node shape the
 * client already consumes.
 *
 * Real shape (captured from a Mate 70):
 *   `{ attributes: { bounds:"[0,0][1216,2688]", origBounds:"[0,0][1216,2688]",
 *                    type:"Text", id:"", accessibilityId:"2701", text:"…",
 *                    clickable:"false", scrollable:"false", opacity:"1.000000",
 *                    hostWindowId:"826", hierarchy:"ROOT826,0,0,…", … },
 *     children: [ … ] }`
 * Every attribute is a **string**; both rects are `"[l,t][r,b]"`.
 *
 * `bounds` is the *visible* rect — clipped by scrolling parents and occluded by
 * other windows — so it under-reports scrolled List items. `origBounds` is the
 * true layout rect and is what the Inspector highlights with. Both are kept:
 * `bounds` feeds tap coordinates (what the user can actually see/tap),
 * `origBounds` feeds the annotation and the box model.
 *
 * @param {string|object} input JSON text or the already-parsed document.
 * @returns {Array<object>} flat nodes, depth-first.
 */
/**
 * Detect a custom `@Component` struct instance from a node id.
 *
 * The ArkUI tree gives component instances a generated id while their `type`
 * stays the rendered node type, so custom components are easy to miss:
 *   `MyRow` (struct name)                  → componentName "MyRow"
 *   `SCBDesktop_Flex_Desktop` (auto)       → componentName "SCBDesktop_Flex_Desktop"
 * while ids in snake_case are developer-assigned `.id('…')` values
 * (`tv_stock_name`, `mainNavigationId`) and are NOT component names.
 *
 * @param {string} id
 * @param {string} [key]
 * @returns {string} The component name, or "" when the id is not one.
 */
export function detectCustomComponentName (id, key) {
  return extractComponentName(id, key)
}

/**
 * 从 id 提取**自定义组件名**。
 *
 * ArkUI 工具链生成的 id 形如 `组件名-实例_类型_字段` / `组件名_序号`（实测：
 * `SignalComponent-SignalOperatorInfo_Text_operator`、`ImageKnifePro_1447`、
 * `StatusBarBackground_Row_0`、`BatteryComponent-batteryIcon_Image_batteryIcon`），
 * **第一段就是组件名**。snake_case / lowerCamel 开头的（`tv_stock_name`、
 * `left`、`mainNavigationId`）是开发者 `.id('…')` 或 @Builder 插槽名，不含组件名。
 *
 * @param {string} id
 * @returns {string} 组件名，提取不到返回 ""。
 */
export function extractComponentName (id, key) {
  const s = String(id || key || '')
  if (!s) return ''
  const first = s.split(/[-_]/)[0]
  return /^[A-Z]/.test(first) ? first : ''
}

export function parseUiRawDump (input) {
  let root = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return []
    // Documents come either as one merged object or (with `-i`) as an array of
    // per-window roots. Try the whole text, then the outermost bracket/brace span.
    root = null
    try {
      root = JSON.parse(text)
    } catch (_) {
      for (const [open, close] of [['[', ']'], ['{', '}']]) {
        const start = text.indexOf(open)
        const end = text.lastIndexOf(close)
        if (start < 0 || end <= start) continue
        try {
          root = JSON.parse(text.slice(start, end + 1))
          break
        } catch (_) { /* try the next span */ }
      }
    }
    if (root === null || root === undefined) return []
  }
  if (!root || typeof root !== 'object') return []

  const nodes = []
  const str = (v) => (typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v)))
  const bool = (v, dflt = false) => {
    const s = str(v).toLowerCase()
    if (s === 'true' || s === '1') return true
    return dflt
  }
  const num = (v, dflt = 0) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  // With `-i` the document is an array holding one root per window; without it
  // the windows are merged into a single root. Walk every root in both cases.
  const roots = Array.isArray(root) ? root : [root]

  const SKIP = new Set([
    'bounds', 'origBounds', 'text', 'originalText', 'id', 'type', 'key', 'hostWindowId',
    'clickable', 'longClickable', 'scrollable', 'checkable', 'checked', 'enabled',
    'focused', 'selected', 'visible', 'clip', 'opacity', 'accessibilityId', 'hierarchy',
    'zIndex', 'hitTestBehavior',
  ])

  const visit = (node, depth, parentIndex, windowId, ownerComponent) => {
    if (!node || typeof node !== 'object') return
    const a = (node.attributes && typeof node.attributes === 'object') ? node.attributes : node
    const bounds = parseBounds(str(a.bounds))
    const origRaw = str(a.origBounds)
    const origBounds = origRaw ? parseBounds(origRaw) : bounds
    const type = str(a.type)
    const id = str(a.id)
    const key = str(a.key)
    // Window ownership: `hostWindowId` is present on every node (verified) and
    // matches `ui window list` ids; fall back to the WindowScene `session<NN>`
    // or the `ROOT<NN>` hierarchy prefix when a document omits it.
    let win = windowId
    const host = num(a.hostWindowId, 0)
    if (host > 0) {
      win = host
    } else {
      const scene = /^session(\d+)$/.exec(id || key)
      if (scene) win = Number(scene[1])
      else {
        const hier = /^ROOT(\d+)/.exec(str(a.hierarchy))
        if (hier) win = Number(hier[1])
      }
    }
    const index = nodes.length
    const kids = Array.isArray(node.children) ? node.children : []
    // 内容区 = 所有子节点真实矩形的并集。它不是「声明的 padding」，但与
    // origBounds 的差就是**实测**的内缩（容器未填满 / 滚动溢出时会偏大或越界，
    // UI 会据实标注）。uitest 不输出声明值，这是唯一可获得的真实几何。
    let contentBox = null
    if (kids.length > 0) {
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity
      for (const c of kids) {
        const ca = (c && c.attributes && typeof c.attributes === 'object') ? c.attributes : c
        if (!ca || typeof ca !== 'object') continue
        const cr = str(ca.origBounds) ? parseBounds(str(ca.origBounds)) : parseBounds(str(ca.bounds))
        if (!Number.isFinite(cr.left) || !Number.isFinite(cr.top)) continue
        minL = Math.min(minL, cr.left); minT = Math.min(minT, cr.top)
        maxR = Math.max(maxR, cr.right); maxB = Math.max(maxB, cr.bottom)
      }
      if (minL <= maxR && minT <= maxB) {
        contentBox = { left: minL, top: minT, right: maxR, bottom: maxB, width: maxR - minL, height: maxB - minT }
      }
    }
    // Every attribute the device reports, verbatim — the properties pane renders
    // this list as-is so nothing from the dump is silently dropped.
    const rawAttrs = {}
    if (a && typeof a === 'object') {
      for (const [k, v] of Object.entries(a)) {
        if (v === undefined || v === null) continue
        rawAttrs[k] = str(v)
      }
    }
    // `dumpLayout -a` adds font metrics in a sibling `extraAttrs` container
    // ({ extra: { Content, FontSize, FontColor, BackgroundColor } }); fold them
    // in so the properties pane shows them too.
    const ex = node.extraAttrs
    if (ex && typeof ex === 'object') {
      for (const [k, v] of Object.entries(ex)) {
        if (v === undefined || v === null) continue
        if (v && typeof v === 'object') {
          for (const [ek, ev] of Object.entries(v)) {
            if (ev === undefined || ev === null) continue
            rawAttrs[ek] = str(ev)
          }
        } else {
          rawAttrs[k] = str(v)
        }
      }
    }
    // Attributes we do not model explicitly (kept for forward compat).
    const attrs = {}
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (SKIP.has(k)) continue
      if (v === '' || v === 'empty source') continue
      attrs[k] = v
    }
    nodes.push({
      index,
      depth,
      parentIndex,
      windowId: win,
      text: str(a.text),
      originalText: str(a.originalText),
      resourceId: id || key || str(a.accessibilityId),
      // The developer-assigned `.id('…')` value — `id` and `key` are identical
      // in every dump captured (214/214). Empty for the ~half of nodes that
      // never set one; deliberately NOT falling back to `accessibilityId`,
      // otherwise a plain number would masquerade as an id in the UI.
      devId: id || key,
      key,
      accessibilityId: str(a.accessibilityId),
      // A @Component struct instance (`MyRow`, `StatusBarBox`, or the
      // auto-generated `SCBDesktop_Flex_Desktop`). Its `type` is merely the
      // rendered node type (Row/Stack/…), which is why they are easy to miss.
      componentName: detectCustomComponentName(id, key),
      // Nearest ancestor that IS a custom component. The toolchain emits
      // `__Common__` placeholders for a component's internal nodes (per Huawei
      // docs: "开发工具链会额外生成节点 __Common__"), and those carry no id at
      // all — this lets the tree label them with their owning component instead
      // of a bare, meaningless `__Common__`.
      ownerComponent: detectCustomComponentName(id, key) || ownerComponent || "",
      className: type,
      bundleName: str(a.bundleName),
      abilityName: str(a.abilityName),
      pagePath: str(a.pagePath),
      bounds,
      boundsStr: `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`,
      // True layout rect — drives the highlight overlay and the box model.
      origBounds,
      origBoundsStr: `[${origBounds.left},${origBounds.top}][${origBounds.right},${origBounds.bottom}]`,
      // 真实测得的内容区（子节点并集）；无子节点或无有效矩形时为 undefined
      // （可选字段有值才挂 key，不能用 null）。
      contentBox: contentBox || undefined,
      // NOTE: the HarmonyOS uitest dump exposes NO padding/margin/border data
      // (`dumpLayout -e` only accepts `uniqueId`), so these stay undefined on
      // purpose — the UI shows "未提供" instead of fabricating zeros.
      padding: undefined,
      margin: undefined,
      borderWidth: undefined,
      borderRadius: undefined,
      borderColor: str(a.backgroundColor),
      opacity: (a.opacity === undefined || str(a.opacity) === '') ? 1 : num(a.opacity, 1),
      visible: bool(a.visible, true),
      enabled: bool(a.enabled, true),
      focused: bool(a.focused, false),
      selected: bool(a.selected, false),
      checked: bool(a.checked, false),
      checkable: bool(a.checkable, false),
      clipped: bool(a.clip, false),
      clickable: bool(a.clickable, false),
      longClickable: bool(a.longClickable, false),
      scrollable: bool(a.scrollable, false),
      zIndex: num(a.zIndex, 0),
      hitTestBehavior: str(a.hitTestBehavior),
      hierarchy: str(a.hierarchy),
      hashcode: str(a.hashcode),
      displayId: str(a.displayId),
      backgroundColor: str(a.backgroundColor),
      backgroundImage: str(a.backgroundImage),
      blur: str(a.blur),
      description: str(a.description),
      hint: str(a.hint),
      rawAttrs,
      attrs
    })
    for (const c of kids) {
      visit(c, depth + 1, index, win, ownerComponent || detectCustomComponentName(id, key))
    }
  }
  for (const top of roots) visit(top, 0, -1, 0, "")
  return nodes
}

export function hitTest (nodes, x, y) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  let best = null
  let bestArea = Infinity
  for (const n of nodes) {
    const b = n && n.bounds
    if (!b) continue
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue
    const area = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top)
    if (area < bestArea) {
      best = n
      bestArea = area
    }
  }
  return best
}

/**
 * Read a PNG's pixel dimensions straight from the IHDR chunk (bytes 16..24).
 * Lets the client scale the screenshot preview and map click coordinates into
 * device pixels without any image library on the Host.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {{width:number,height:number}|null} null when not a valid PNG.
 */
export function readPngSize (buf) {
  if (!buf || buf.length < 24) return null
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const width = buf.readUInt32BE ? buf.readUInt32BE(16) : (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]
  const height = buf.readUInt32BE ? buf.readUInt32BE(20) : (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

// ---------------------------------------------------------------------------
// 5. IP 网络连接（hdc tconn）
// ---------------------------------------------------------------------------

const HDC_EXE = isWindows() ? 'hdc.exe' : 'hdc'

/**
 * Scan PATH for an executable by name. Returns the first existing absolute
 * candidate, or null. (Same strategy as harmony-studio.findDevecoCli.)
 *
 * @param {string} name Executable file name (e.g. 'hdc.exe').
 * @returns {string|null}
 */
export function findOnPath (name) {
  const pathEnv = process.env.PATH || ''
  if (!pathEnv) return null
  const sepChar = isWindows() ? ';' : ':'
  for (const dir of pathEnv.split(sepChar)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch (_) { /* keep scanning */ }
  }
  return null
}

/**
 * Resolve the hdc executable bundled with the HarmonyOS SDK.
 *
 * devecocli has no IP/TCP connect command, so IP connections go through
 * `hdc tconn <ip>:<port>` directly. The lookup order mirrors devecocli's own
 * tool-provider resolution (observed on DevEco CLI 26 / Studio 6):
 *   1. $DEVECO_SDK_HOME        → <sdk>/default/openharmony/toolchains/hdc
 *   2. $DEVECO_HOME            → <home>/sdk/default/openharmony/toolchains/hdc
 *   3. resolved Studio/CLT root → <path>/sdk/default/openharmony/toolchains/hdc
 *   4. opts.extraRoots (discovery candidates) → same sub-path
 *   5. PATH
 *
 * @param {object} [resolved] Toolchain resolution ({ source, exec?, path? }).
 * @param {object} [opts]
 * @param {string[]} [opts.extraRoots] Additional install roots (discovery).
 * @returns {string|null} Absolute hdc path, or null when not found.
 */
export function resolveHdc (resolved, opts = {}) {
  const sub = ['sdk', 'default', 'openharmony', 'toolchains', HDC_EXE]
  const fromRoot = (root) => {
    if (typeof root !== 'string' || !root.trim()) return null
    const cleaned = root.trim().replace(/[\\/]+$/, '')
    return join(cleaned, ...sub)
  }
  const candidates = []
  const sdkHome = fromRoot(process.env.DEVECO_SDK_HOME)
  if (sdkHome) candidates.push(sdkHome)
  const devecoHome = fromRoot(process.env.DEVECO_HOME)
  if (devecoHome) candidates.push(devecoHome)
  if (resolved && (resolved.source === 'studio' || resolved.source === 'clt')) {
    const p = fromRoot(resolved.path)
    if (p) candidates.push(p)
  }
  const extras = Array.isArray(opts.extraRoots) ? opts.extraRoots : []
  for (const root of extras) {
    const p = fromRoot(root)
    if (p) candidates.push(p)
  }
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch (_) { /* keep scanning */ }
  }
  return findOnPath(HDC_EXE)
}

/**
 * Run hdc with the given args, collecting stdout/stderr.
 *
 * @param {string} hdcPath Absolute hdc executable path.
 * @param {string[]} args hdc args (e.g. ['tconn', '192.168.0.100:5555']).
 * @param {object} [opts]
 * @param {number} [opts.timeout] Default 15000.
 * @param {object} [opts.env] Extra env vars.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
export function execHdc (hdcPath, args, opts = {}) {
  if (!hdcPath) {
    return Promise.reject(withProps(new Error('execHdc: hdcPath required'), { code: null, stdout: '', stderr: '' }))
  }
  const timeout = opts.timeout ?? 15000
  const env = { ...process.env, ...(opts.env || {}) }
  // hdc.exe is a real binary (no .cmd shim): spawn WITHOUT a shell so a path
  // containing spaces (e.g. "D:\...\DevEco Studio\...\hdc.exe") is quoted by
  // libuv — cmd.exe would split it at the first space and fail to launch.
  return spawnCollect(hdcPath, args, { timeout, env, shell: false })
}

function formatTconnAddress (ip, port) {
  const p = Number(port)
  // HarmonyOS hdc has no default TCP port — the port is mandatory and must
  // match the debug port the device exposes after enabling debugging.
  if (!Number.isFinite(p) || p <= 0 || p > 65535) {
    throw new Error('hdc tconn: port required (integer in 1..65535)')
  }
  return `${String(ip || '').trim()}:${Math.floor(p)}`
}

/**
 * Args for `hdc tconn <ip>:<port>` (TCP connect; the device must already have
 * debugging enabled via 设置 → 开发者选项). `port` is required — hdc has no
 * default port.
 */
export function buildHdcConnectArgs ({ ip, port } = {}) {
  return ['tconn', formatTconnAddress(ip, port)]
}

/** Args for `hdc tconn <ip>:<port> -remove` (disconnect a TCP target). `port` is required. */
export function buildHdcDisconnectArgs ({ ip, port } = {}) {
  return ['tconn', formatTconnAddress(ip, port), '-remove']
}

/**
 * Parse `hdc tconn` output. hdc quirks: failures print `[Fail]...` yet still
 * exit 0; a successful (or already-connected) target prints `[Info]Target is
 * connected, repeat operation` or `Connect OK`; `-remove` prints a
 * Remove-target message. Exit code alone cannot detect failure.
 *
 * @param {string} text Combined stdout+stderr.
 * @returns {{ ok: boolean, message: string }}
 */
export function parseTconnResult (text) {
  const raw = (typeof text === 'string' ? text : '').trim()
  const fail = /\[Fail\]\s*([^\r\n]*)/m.exec(raw)
  if (fail) {
    return { ok: false, message: (fail[1] || '').trim() || 'hdc 操作失败' }
  }
  if (/Connect failed/i.test(raw)) return { ok: false, message: raw }
  // "Target is connected, repeat operation" = the connect succeeded (the target
  // was already connected, or this call established it). Treat as success.
  if (/Target is connected/i.test(raw)) return { ok: true, message: '已连接' }
  if (/Connect OK/i.test(raw)) return { ok: true, message: '已连接' }
  if (/remove/i.test(raw)) return { ok: true, message: raw }
  // Generic [Info] with no failure marker → hdc considered it a success.
  if (/\[Info\]/i.test(raw)) return { ok: true, message: raw }
  // Unknown output — treat as failure so the caller surfaces the raw text.
  return { ok: false, message: raw || 'hdc 无输出（连接超时：设备不可达或端口不正确）' }
}