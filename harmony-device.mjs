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
import { existsSync, readdirSync } from 'node:fs'
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
 * Extract the first balanced top-level JSON array from mixed CLI stdout.
 *
 * devecocli appends non-JSON chatter to stdout after the JSON payload — most
 * notably the `New docs version 1.3.6 available, run \`devecocli docs update\`
 * to upgrade` notice observed on real runs (device list / ui window list),
 * which arrives on **stdout**, not stderr. A whole-buffer `JSON.parse` dies on
 * that trailing line, and `first [` … `last ]` slicing breaks the moment the
 * chatter itself contains brackets. Bracket matching here is string- and
 * escape-aware, so `]` inside JSON string values or inside the trailing
 * chatter can no longer poison the carve-out.
 *
 * @param {string} text
 * @returns {Array|null} Parsed array, or null when no balanced array parses.
 */
export function extractJsonArray (text) {
  if (!text) return null
  const s = String(text)
  const start = s.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(s.slice(start, i + 1))
          return Array.isArray(parsed) ? parsed : null
        } catch (_) {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Parse `devecocli ui window list --format json` output.
 *
 * Real shape: `[{ id, name, pid, displayId, focused }, ...]`. Tolerates any
 * non-JSON chatter around the payload (docs-upgrade notices etc.) via
 * `extractJsonArray`.
 *
 * @param {string} stdout
 * @returns {Array<{id:number,name:string,pid:number,displayId:number,focused:boolean}>}
 */
export function parseUiWindowListJson (stdout) {
  const arr = extractJsonArray(stdout)
  if (!arr) return []
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
 * Parse `devecocli device list` output.
 *
 * Preferred input is `--format json`:
 *   [ { "name": "HUAWEI Mate 70", "serial": "55K0...", "kind": "device", "deviceType": "phone" } ]
 *
 * devecocli ≥1.3 pretty-prints that array **and** appends the docs-upgrade
 * notice (`New docs version … available`) to stdout, so the payload must be
 * carved out with `extractJsonArray` — a whole-buffer JSON.parse falls through
 * to the table fallback, which happily turns every pretty-printed JSON line
 * into a bogus device row (the "settings device list shows raw JSON" bug).
 *
 * Fallback: the human table layout (column order is Name, Serial, Kind, Type —
 * NOT serial-first), which looks like:
 *   - Querying connected devices…      ← spinner line, skipped
 *   Name            Serial            Kind    Device Type
 *   --------------  ----------------  ------  -----------
 *   HUAWEI Mate 70  55K0225509025604  device  phone
 *
 * Returns an array of `{serial, name, state, type}`; skips spinner, header and
 * separator rows. Falls back to a single-column interpretation so the UI still
 * gets a usable list on unexpected layouts.
 *
 * @param {string} stdout
 * @returns {Array<{serial:string,name:string,state:string,type:string}>}
 */
export function parseDeviceList (stdout) {
  if (!stdout) return []
  const arr = extractJsonArray(String(stdout))
  if (arr) {
    return arr
      .filter((d) => d && typeof d === 'object' && d.serial)
      .map((d) => ({
        serial: String(d.serial),
        name: typeof d.name === 'string' ? d.name : '',
        state: typeof d.kind === 'string' ? d.kind : '',
        type: typeof d.deviceType === 'string' ? d.deviceType : '',
      }))
  }
  const lines = String(stdout).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out = []
  for (const line of lines) {
    if (/^[-\\|/]\s/.test(line)) continue;          // spinner/progress rows
    if (/^[-=\s]+$/.test(line)) continue;           // separator rows (incl. spaced dashes)
    if (/^Name\s+Serial/i.test(line)) continue;     // header (new CLI)
    if (/^Device\s+ID/i.test(line)) continue;       // header (legacy CLI)
    const cols = line.split(/\s{2,}|\t+/).filter((c) => c !== '');
    if (cols.length === 0) continue;
    if (cols.length >= 2) {
      // Real table order: Name, Serial, Kind, Device Type.
      out.push({
        serial: cols[1],
        name: cols[0],
        state: cols[2] || '',
        type: cols[3] || '',
      });
    } else {
      out.push({ serial: cols[0], name: '', state: '', type: '' });
    }
  }
  return out.filter((d) => d.serial)
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
  const roots = extractJsonArray(String(stdout))
  if (!roots) return []
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
    // Explicit negatives must NOT fall through to the default — uitest dump
    // attribute values are strings, and `visible: "false"` used to be parsed
    // as `true` because only "true"/"1" were recognised (the invisible-node
    // filtering bug).
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no') return false
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
    // 不可见节点「存根」语义（用户决策）：只看节点自身、不看后代（单次 DFS，
    // 高效）。自身可见 → 正常保留并递归子树；自身不可见 → **保留该节点本身**
    // （如 Navigation 压栈后被整体标 Hidden 的 NavBar 主页——页面活着，只是
    // 被盖住，必须在树上可见、属性可查），但其**所有子节点剪掉**（内容是纯
    // 噪音）。缺失 visible 属性默认可见。树展示、属性面板与 agent 工具共用
    // 这份解析结果；截图命中（hitTest）另行跳过 visible:false 的存根。
    const selfVisible = bool(a.visible, true)
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
    // 内容区 = 所有**可见**子节点真实矩形的并集。它不是「声明的 padding」，但与
    // origBounds 的差就是**实测**的内缩（容器未填满 / 滚动溢出时会偏大或越界，
    // UI 会据实标注）。uitest 不输出声明值，这是唯一可获得的真实几何。
    // 不可见存根自身不渲染，不测算内容区。
    let contentBox = null
    if (selfVisible && kids.length > 0) {
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity
      for (const c of kids) {
        const ca = (c && c.attributes && typeof c.attributes === 'object') ? c.attributes : c
        if (!ca || typeof ca !== 'object') continue
        // 不可见子节点不参与内容区并集——它不渲染，计入会虚增实测内缩。
        if (!bool(ca.visible, true)) continue
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
    // 自身不可见：到此为止——保留存根，不递归子节点。
    if (!selfVisible) return
    for (const c of kids) {
      visit(c, depth + 1, index, win, ownerComponent || detectCustomComponentName(id, key))
    }
  }
  for (const top of roots) visit(top, 0, -1, 0, "")
  return nodes
}

/**
 * ── DevEco 开发调试源（反编译 `layout-inspector-server` / `ohos-debug-common` 还原）──
 *
 * DevEco 拿组件树**不是**走 uitest dump，而是：
 *   1. `hdc fport tcp:<本机端口> ark:<pid>@<包名>`（旧协议 `localabstract:<pid><tid><serviceName>`）
 *   2. 连 `ws://127.0.0.1:<本机端口>`（**裸 socket + 极简 6 头握手**，见下）
 *   3. 发 `{"type":"connected"}` → `{"type":"inspectorAbilities"}` → `{"type":"tree"}`
 *   4. 应用回 `{"type":"root", …}` ← **组件树**（含 `$attrs.margin/padding/border`、
 *      `viewTag`/`$attrs.label`、`type:"custom"|"build-in"`）
 *
 * 这些字段**只存在于应用侧 inspector 树**，uitest（30 属性）不含，所以走
 * dump 时盒子模型永远「未提供」、组件/Builder 名也分不出来。
 */

/** 端口转发 argv：新协议 `ark:<pid>@<pkg>`（hdclib 的 SocketPortForwardOperation）。 */
export function buildArkForwardArgs (localPort, pid, packageName) {
  return ['fport', `tcp:${localPort}`, `ark:${pid}@${packageName}`]
}

/** 端口转发 argv：旧协议 `localabstract:<pid><tid><serviceName>`（ArkTsPortForwardOperation）。 */
export function buildLocalAbstractForwardArgs (localPort, pid, tid, serviceName) {
  return ['fport', `tcp:${localPort}`, `localabstract:${pid}${tid || ''}${serviceName || ''}`]
}

/** 解除转发的 argv（`hdc fport rm`——实测 `--remove` 不是合法子命令，会静默失败泄漏规则）。 */
export function buildForwardRemoveArgs (localPort, remoteNode) {
  return ['fport', 'rm', `tcp:${localPort}`, remoteNode]
}

/** DevEco 发给应用调试 socket 的三条消息（`MessageConstant` / `ConnectServerSession`）。 */
export const DEV_ECO_WS_MESSAGES = {
  connected: '{"type":"connected"}',
  inspectorAbilities: '{"type":"inspectorAbilities","content":[]}',
  tree: '{"type":"tree"}',
}

/**
 * 在 `{"type":"root", …}` 回包里定位组件树根节点。应用侧节点形如
 * `{ $type, $ID, $attrs, $rect, $children, viewTag, type }`；根可能直接就是
 * 节点，也可能在 `root`/`data`/`content`/`tree` 下（含 JSON 字符串）。
 */
export function findDevEcoTreeRoot (message) {
  if (!message || typeof message !== 'object') return null
  const looksLikeNode = (o) => !!o && typeof o === 'object' &&
    (o.$children !== undefined || o.$type !== undefined || o.$attrs !== undefined || o.children !== undefined)
  if (looksLikeNode(message)) return message
  for (const k of ['root', 'data', 'content', 'tree', 'componentJson', 'getComponentJson']) {
    const v = message[k]
    if (looksLikeNode(v)) return v
    if (typeof v === 'string') {
      try {
        const r = findDevEcoTreeRoot(JSON.parse(v))
        if (r) return r
      } catch (_) { /* 不是 JSON */ }
    }
  }
  return null
}

/** `$rect` 归一化成 `{left,top,right,bottom,width,height}`；拿不到返回 null。真实形态（实测）：
 *  字符串 `"[0.00, 136.00],[1316.00,2734.00]"`、数组 `[l,t,r,b]`、对象 `{startX,startY,endX,endY}` 都支持。 */
function rectToBounds (rect) {
  if (!rect) return null
  const fin = (arr) => Array.isArray(arr) && arr.length >= 4 && arr.every(Number.isFinite)
  // 字符串 "[l,t],[r,b]"（应用侧 inspector 树的真实形态）
  if (typeof rect === 'string') {
    const m = rect.match(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*,?\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/)
    if (m) {
      const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      if (fin([l, t, r, b])) return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }
    }
    return null
  }
  if (Array.isArray(rect)) {
    const [l, t, r, b] = rect.map(Number)
    if (fin([l, t, r, b])) return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }
    return null
  }
  if (typeof rect === 'object') {
    const l = Number(rect.startX ?? rect.left ?? rect.x)
    const t = Number(rect.startY ?? rect.top ?? rect.y)
    const r = Number(rect.endX ?? rect.right)
    const b = Number(rect.endY ?? rect.bottom)
    if (fin([l, t, r, b])) return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }
    const w = Number(rect.width), h = Number(rect.height)
    if (fin([l, t, w, h])) return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }
  }
  return null
}

/**
 * 解析应用侧组件树（DevEco 开发调试源）为与 `parseUiRawDump` 同形的扁平节点。
 * 与 dump 的关键差别：**有**盒模型声明值（`$attrs.margin/padding/border*`）、
 * **有**组件/Builder 名（`viewTag`/`$attrs.label`/`$attrs.inspectorLabel`），
 * 并且 `$type === "JsView"` 或 `type ∈ {"custom","build-in"}` 可权威判定自定义组件。
 */
/** 声明值字符串 → 数字：剥掉 `vp`/`px`/`fp`/`%` 单位（真实数据全是 `"12.00vp"` 这类带单位字符串）。 */
function toUnitNumber (v) {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const m = String(v).trim().match(/^(-?[\d.]+)\s*(vp|px|fp|%)?$/i)
  return m ? Number(m[1]) : undefined
}

/**
 * `$attrs` 盒模型声明值 → 四边对象。真实形态（实测）：
 *  `"0.00vp"`（四边同值）、JSON 字符串 `{"top":"0.00vp","right":"16.00vp",…}`、
 *  对象 `{top,right,bottom,left}`（值可带单位）、数字、CSS 四值串。拿不到返回 undefined。
 */
function toBoxSides (v) {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) {
    return { top: v, right: v, bottom: v, left: v }
  }
  if (typeof v === 'string') {
    const s = v.trim()
    // JSON 字符串对象（margin 的真实形态）
    if (s.startsWith('{')) {
      try { return toBoxSides(JSON.parse(s)) } catch (_) { return undefined }
    }
    const n = toUnitNumber(s)
    if (n !== undefined) return { top: n, right: n, bottom: n, left: n }
    // "12 8" / "12 8 4" / "12 8 6 4"（CSS 顺序：上 右 下 左）
    const parts = s.split(/[\s,]+/).map((x) => toUnitNumber(x))
    if (parts.length >= 4 && parts.every((x) => x !== undefined)) {
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] }
    }
    return undefined
  }
  if (typeof v === 'object') {
    const top = toUnitNumber(v.top ?? v.start ?? v.y)
    const right = toUnitNumber(v.right ?? v.end ?? v.x)
    const bottom = toUnitNumber(v.bottom ?? v.end ?? v.y)
    const left = toUnitNumber(v.left ?? v.start ?? v.x)
    if ([top, right, bottom, left].every((x) => x !== undefined)) return { top, right, bottom, left }
    return undefined
  }
  return undefined
}

/**
 * 圆角声明值 → 数字。真实形态：`"28.00px"` 字符串，或
 * `{topLeft,topRight,bottomLeft,bottomRight}` 四角对象（取最大角）。拿不到返回 undefined。
 */
function toBorderRadius (v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = toUnitNumber(v)
  if (n !== undefined) return n
  if (typeof v === 'object') {
    const corners = [v.topLeft, v.topRight, v.bottomLeft, v.bottomRight].map((x) => toUnitNumber(x)).filter((x) => x !== undefined)
    return corners.length ? Math.max(...corners) : undefined
  }
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try { return toBorderRadius(JSON.parse(v)) } catch (_) { return undefined }
  }
  return undefined
}

/** 声明值 → 有限数字（borderWidth 用），带单位字符串可解析，拿不到返回 undefined。 */
function toNumOrUndefined (v) {
  return toUnitNumber(v)
}

export function parseDevEcoTree (root, windowId = 0) {
  const tree = findDevEcoTreeRoot(root)
  if (!tree) return []
  const nodes = []
  const toStr = (v) => (v === undefined || v === null) ? '' : String(v)
  const truthy = (v) => { const s = toStr(v).toLowerCase(); return s === 'true' || s === '1' || s === 'yes' }
  const visit = (node, depth, parentIndex) => {
    if (!node || typeof node !== 'object') return
    const attrs = node.$attrs && typeof node.$attrs === 'object' ? node.$attrs : {}
    // 可见性「存根」语义（与 uitest 源一致，用户决策）：只看节点自身。自身
    // 不可见（枚举串 Visibility.Hidden / Visibility.None 归一化后比较、显式
    // false、节点级 visible:false 任一命中）→ **保留该节点本身**（如
    // Navigation 压栈后被整体标 Hidden 的 NavBar 主页），但其所有子节点剪掉。
    // 缺失 visibility 默认可见。单次 DFS，无后代回溯。
    const visibilityEnum = toStr(attrs.visibility ?? '').replace(/^Visibility\./i, '').toLowerCase()
    const nodeVisible = node.visible !== false
      ? !(visibilityEnum === 'hidden' || visibilityEnum === 'none' || toStr(attrs.visible) === 'false')
      : false
    const bounds = rectToBounds(node.$rect ?? node.rect ?? attrs.rect) ||
      { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    // 组件名 / Builder 名：viewTag（JsView 的名字）→ $attrs.label → $attrs.inspectorLabel
    const name = toStr(node.viewTag ?? attrs.label ?? attrs.inspectorLabel ?? '')
    const rawType = toStr(node.$type ?? node.type ?? '')
    const typeTag = toStr(node.type)                       // "custom" | "build-in" | ""
    const isCustom = rawType === 'JsView' || typeTag === 'custom'
    const rectStr = `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`
    const rawAttrs = {}
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) rawAttrs[k] = typeof v === 'object' ? JSON.stringify(v) : toStr(v)
    // 真实数据语义（实测）：Text 文本在 $attrs.content、Button 在 $attrs.label；
    // focused/enabled 是布尔。
    const devId = toStr(attrs.id ?? '')
    nodes.push({
      index: nodes.length,
      depth,
      parentIndex,
      windowId,
      text: toStr(node.$text ?? node.text ?? attrs.text ?? attrs.content ?? attrs.label),
      originalText: toStr(attrs.accessibilityText ?? ''),
      devId,
      key: devId || name,
      resourceId: name || devId || toStr(node.$ID),
      accessibilityId: toStr(node.$ID ?? ''),
      componentName: extractComponentName(name),
      ownerComponent: '',
      className: rawType === 'JsView' ? (name || 'JsView') : rawType,
      bundleName: '',
      abilityName: '',
      pagePath: '',
      bounds,
      boundsStr: rectStr,
      origBounds: bounds,
      origBoundsStr: rectStr,
      contentBox: undefined,
      // 声明值——这条源终于能给全，不再显示「未提供」。
      padding: toBoxSides(attrs.padding),
      margin: toBoxSides(attrs.margin),
      borderWidth: toNumOrUndefined(attrs.borderWidth ?? attrs.borderTopWidth),
      borderRadius: toBorderRadius(attrs.borderRadius ?? attrs.cornerRadius),
      borderColor: toStr(attrs.borderColor ?? ''),
      opacity: toNumOrUndefined(attrs.opacity) ?? 1,
      visible: nodeVisible,
      enabled: attrs.enabled === undefined ? true : (attrs.enabled === true || truthy(attrs.enabled)),
      focused: attrs.focused === true || truthy(attrs.focused),
      selected: false,
      checked: truthy(attrs.checked),
      checkable: truthy(attrs.checkable),
      clipped: false,
      clickable: truthy(attrs.clickable),
      longClickable: truthy(attrs.longClickable ?? attrs.longclickable),
      scrollable: truthy(attrs.scrollable),
      zIndex: toNumOrUndefined(attrs.zIndex) || 0,
      hitTestBehavior: toStr(attrs.hitTestBehavior ?? ''),
      hierarchy: '',
      hashcode: '',
      displayId: '',
      backgroundColor: toStr(attrs.backgroundColor ?? ''),
      backgroundImage: toStr(attrs.backgroundImage ?? ''),
      blur: '',
      description: toStr(attrs.accessibilityDescription ?? attrs.description ?? ''),
      hint: toStr(attrs.hint ?? attrs.accessibilityTextHint ?? ''),
      rawAttrs,
      attrs: Object.assign({}, rawAttrs,
        name ? { componentOrBuilderName: name } : {},
        isCustom ? { isCustom: 'true' } : {},
        typeTag ? { type: typeTag } : {}),
    })
    const kids = Array.isArray(node.$children) ? node.$children
      : (Array.isArray(node.children) ? node.children : [])
    // 自身不可见：保留存根，不递归子节点。
    if (!nodeVisible) return
    for (const c of kids) visit(c, depth + 1, nodes.length - 1)
  }
  visit(tree, 0, -1)
  // ownerComponent：最近的命名自定义组件祖先（供属性面板显示「所属组件」）。
  const byIndex = new Map(nodes.map((n) => [n.index, n]))
  for (const n of nodes) {
    if (n.componentName) { n.ownerComponent = n.componentName; continue }
    let p = n.parentIndex
    const seen = new Set()
    while (p !== undefined && p >= 0 && !seen.has(p)) {
      seen.add(p)
      const parent = byIndex.get(p)
      if (!parent) break
      if (parent.componentName) { n.ownerComponent = parent.componentName; break }
      p = parent.parentIndex
    }
  }
  return nodes
}

// ---- DevEco 调试 socket 的裸 WebSocket 客户端（纯函数，供 Host 编排） ---------
//
// 为什么不用 Node 自带 WebSocket（实测大坑，2026-10）：应用侧 inspector 服务
// （ets_runtime 的 ConnectServer/HttpHandShake）是**手写的极简 HTTP 解析器**，
// Node WHATWG WebSocket 的握手带一堆多余头（`sec-websocket-extensions:
// permessage-deflate`、`sec-fetch-mode`、`user-agent`、`accept-encoding`、
// 小写头名……），直接被判「HTTP upgrade parameters failure」秒拒（hilog 实证）。
// DevEco 的 Java-WebSocket 客户端只发 6 个标准头，一次通过。所以这里手写
// 同款极简握手 + 最小 WS 帧编解码（客户端帧必须 MASK，RFC 6455）。

/**
 * 构造 Java-WebSocket 风格的极简 WS 升级请求（正好 6 个头，无多余参数）。
 * @param {string} host 请求行的 Host 值（如 `127.0.0.1:18100`）
 * @param {string} key Sec-WebSocket-Key（16 字节 base64）
 */
export function buildDevEcoWsHandshake (host, key) {
  return [
    'GET / HTTP/1.1',
    'Connection: Upgrade',
    `Host: ${host}`,
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'Upgrade: websocket',
    '', '',
  ].join('\r\n')
}

/** 判断握手响应是否 101（以 `\r\n\r\n` 结尾的完整响应头）。 */
export function isWsHandshakeAccepted (responseText) {
  return /^HTTP\/1\.1 101/.test(String(responseText || '').split('\r\n\r\n')[0] || '')
}

/** 客户端 → 服务端的 MASK 文本帧（RFC 6455：客户端帧必须带 4 字节掩码）。 */
export function encodeWsClientTextFrame (text, maskBytes) {
  const mask = maskBytes && maskBytes.length === 4 ? Buffer.from(maskBytes) : Buffer.from([0x11, 0x22, 0x33, 0x44])
  const payload = Buffer.from(String(text), 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** PONG 帧（服务端 PING 的应答，同样要 MASK）。 */
export function encodeWsPongFrame (payloadBytes, maskBytes) {
  const mask = maskBytes && maskBytes.length === 4 ? Buffer.from(maskBytes) : Buffer.from([0x55, 0x66, 0x77, 0x88])
  const payload = Buffer.from(payloadBytes || Buffer.alloc(0))
  const header = payload.length < 126
    ? Buffer.from([0x8a, 0x80 | payload.length])
    : (() => { const h = Buffer.alloc(4); h[0] = 0x8a; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); return h })()
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/**
 * 尽量从缓冲区解码完整的服务端帧（服务端帧不 MASK）。
 * @returns {{texts:string[], pings:Buffer[], closed:boolean, rest:Buffer}}
 *   `texts` 是按序解出的文本帧（二进制帧按 utf8 尝试解码）；不完整帧留在 `rest`。
 */
export function decodeWsServerFrames (buffer) {
  const texts = []
  const pings = []
  let closed = false
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || Buffer.alloc(0))
  while (true) {
    if (buf.length < 2) break
    const op = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (buf.length < 4) break
      len = buf.readUInt16BE(2); off = 4
    } else if (len === 127) {
      if (buf.length < 10) break
      len = Number(buf.readBigUInt64BE(2)); off = 10
    }
    let maskKey = null
    if (masked) {
      if (buf.length < off + 4) break
      maskKey = buf.subarray(off, off + 4); off += 4
    }
    if (buf.length < off + len) break
    let payload = buf.subarray(off, off + len)
    if (maskKey) {
      const un = Buffer.alloc(len)
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i % 4]
      payload = un
    }
    buf = buf.subarray(off + len)
    if (op === 0x1 || op === 0x2 || op === 0x0) texts.push(payload.toString('utf8'))
    else if (op === 0x9) pings.push(payload)
    else if (op === 0x8) closed = true
    // op 0xA（pong）忽略
  }
  return { texts, pings, closed, rest: buf }
}

// ---- Agent 工具面：DevEco 调试树的模型友好投影（纯函数，供 harmony_ui_tree 工具用） ----

/**
 * 把 `parseDevEcoTree` 节点收缩成 agent 工具的紧凑节点（canonical JSON）。
 * 展示名沿用 UI 的标签规则：组件名 → 开发者 id → 真实类型。
 * @param {object} n parseDevEcoTree 输出节点
 * @param {boolean} [includeAttrs] 附带全部原始属性（很占篇幅，默认不带）
 */
export function devEcoNodeSummary (n, includeAttrs = false) {
  if (!n || typeof n !== 'object') return null
  const toStr = (v) => (v === undefined || v === null) ? '' : String(v)
  const out = {
    index: Number(n.index) || 0,
    depth: Number(n.depth) || 0,
    parentIndex: Number.isFinite(n.parentIndex) ? n.parentIndex : -1,
    name: toStr(n.componentName || n.devId || n.className),
    componentName: toStr(n.componentName),
    className: toStr(n.className),
    kind: (n.attrs && n.attrs.isCustom === 'true') ? 'custom' : 'build-in',
    text: toStr(n.text),
    devId: toStr(n.devId),
    accessibilityId: toStr(n.accessibilityId),
    bounds: n.bounds && typeof n.bounds === 'object'
      ? {
          left: Number(n.bounds.left) || 0,
          top: Number(n.bounds.top) || 0,
          right: Number(n.bounds.right) || 0,
          bottom: Number(n.bounds.bottom) || 0,
          width: Number(n.bounds.width) || 0,
          height: Number(n.bounds.height) || 0,
        }
      : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    visible: n.visible !== false,
    enabled: n.enabled !== false,
    clickable: n.clickable === true,
    scrollable: n.scrollable === true,
  }
  // 声明值：有值才挂 key
  if (n.padding) out.padding = n.padding
  if (n.margin) out.margin = n.margin
  if (n.borderWidth !== undefined && n.borderWidth !== null) out.borderWidth = n.borderWidth
  if (n.borderRadius !== undefined && n.borderRadius !== null) out.borderRadius = n.borderRadius
  if (n.borderColor) out.borderColor = toStr(n.borderColor)
  if (includeAttrs && n.rawAttrs && typeof n.rawAttrs === 'object') out.attrs = n.rawAttrs
  return out
}

/** 摘要节点数组 → 缩进树文本行（每个节点一行，模型可读的紧凑形态）。 */
export function devEcoTreeLines (nodes) {
  const out = []
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    if (!n) continue
    const indent = '  '.repeat(Math.max(0, Number(n.depth) || 0))
    const b = n.bounds || {}
    const parts = [`${indent}${n.name || n.className || 'Node'}`]
    if (n.kind === 'custom') parts.push('[组件]')
    if (n.className && n.className !== n.name) parts.push(n.className)
    parts.push(`(${b.left ?? 0},${b.top ?? 0},${b.right ?? 0},${b.bottom ?? 0})`)
    if (n.text) parts.push(JSON.stringify(n.text))
    if (n.devId && n.devId !== n.name) parts.push(`id=${n.devId}`)
    if (n.padding) parts.push(`pad:${n.padding.top} ${n.padding.right} ${n.padding.bottom} ${n.padding.left}`)
    if (n.margin) parts.push(`margin:${n.margin.top} ${n.margin.right} ${n.margin.bottom} ${n.margin.left}`)
    if (n.borderWidth !== undefined && n.borderWidth !== null) parts.push(`bw:${n.borderWidth}`)
    if (n.borderRadius !== undefined && n.borderRadius !== null) parts.push(`br:${n.borderRadius}`)
    if (n.borderColor) parts.push(`bc:${n.borderColor}`)
    if (n.childrenOmitted) parts.push(`+${n.hiddenDirect ?? 0} children hidden`)
    out.push(parts.join(' '))
  }
  return out
}

/**
 * agent 工具面的节点裁剪：**整棵子树保留/省略，绝不发半棵**。超出 cap 的节点
 * 连同其后代整体省略；被省略节点的最近保留祖先标 `childrenOmitted: true` 与
 * `hiddenDirect`（被省略的直接子节点数）；每个保留节点带 `childCount`
 * （完整树中的直接子节点总数）——前端/agent 由此知道内部还有多少孩子。
 *
 * @param {Array<object>} nodes parseDevEcoTree 的扁平节点（DFS 序，index/parentIndex/depth）
 * @param {number} cap 节点上限（4000 封顶）
 * @param {boolean} [includeAttrs] 附带全部原始属性
 * @returns {{ nodes: object[], nodeCount: number, truncated: boolean, hiddenNodes: number }}
 */
export function devEcoToolNodes (nodes, cap = 400, includeAttrs = false) {
  const list = Array.isArray(nodes) ? nodes : []
  const childCount = new Map()
  for (const n of list) {
    const p = n && n.parentIndex
    if (typeof p === 'number' && p >= 0) childCount.set(p, (childCount.get(p) || 0) + 1)
  }
  const limit = Math.max(1, Math.min(Number(cap) || 400, 4000))
  const items = []
  const keptStack = [] // DFS 路径上已保留的祖先摘要（下标 = depth）
  let omitFromDepth = Infinity // 该深度起整体省略（整棵子树）
  let hiddenNodes = 0
  for (const n of list) {
    if (!n) continue
    const depth = Math.max(0, Number(n.depth) || 0)
    if (depth >= omitFromDepth) { hiddenNodes++; continue }
    if (items.length >= limit) {
      omitFromDepth = depth + 1
      hiddenNodes++
      const parent = keptStack[depth - 1] || null
      if (parent) {
        parent.childrenOmitted = true
        parent.hiddenDirect = (parent.hiddenDirect || 0) + 1
      }
      continue
    }
    const s = devEcoNodeSummary(n, includeAttrs)
    if (!s) continue
    s.childCount = childCount.get(n.index) || 0
    items.push(s)
    keptStack.length = depth
    keptStack.push(s)
  }
  return { nodes: items, nodeCount: list.length, truncated: items.length < list.length, hiddenNodes }
}

export function hitTest (nodes, x, y) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  let best = null
  let bestArea = Infinity
  for (const n of nodes) {
    const b = n && n.bounds
    if (!b) continue
    // 不可见存根（如 Navigation 压栈后被标 Hidden 的 NavBar 主页）矩形往往
    // 覆盖整屏，且内容并不在当前画面上——截图点击命中必须跳过它们。
    if (n.visible === false) continue
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
  // mac 主修复：DevEco Studio / Command Line Tools 常以 .app 包形态给出
  // （`/Applications/DevEco Studio.app`，Finder 复制出来的就是这个），工具链
  // 根其实在 <xxx>.app/Contents——直接拿 .app 根拼 sdk/…必然落空，先补
  // /Contents（已是 .app/Contents 或普通目录则原样）。
  const cleanRoot = (root) => {
    if (typeof root !== 'string' || !root.trim()) return null
    const cleaned = root.trim().replace(/[\\/]+$/, '')
    return /\.app$/i.test(cleaned) ? `${cleaned}/Contents` : cleaned
  }
  const fromRoot = (root) => {
    const base = cleanRoot(root)
    return base ? join(base, ...sub) : null
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
  // macOS：Studio 的 app bundle 里不必然带 sdk/（SDK 常由 SDK Manager 下载到
  // ~/Library/OpenHarmony/Sdk 或 ~/Library/Huawei/Sdk，目录带版本号、布局不
  // 固定，固定子路径枚举不到）——在已解析工具链根的 sdk/ 与 SDK 库目录里
  // 限深扫描名为 hdc 的文件。
  if (process.platform !== 'win32') {
    const home = process.env.HOME || ''
    const walkRoots = []
    if (resolved && resolved.path) {
      const base = cleanRoot(resolved.path)
      if (base) walkRoots.push(join(base, 'sdk'))
    }
    if (process.env.DEVECO_SDK_HOME) walkRoots.push(process.env.DEVECO_SDK_HOME)
    if (home) {
      walkRoots.push(join(home, 'Library', 'OpenHarmony'))
      walkRoots.push(join(home, 'Library', 'Huawei'))
    }
    for (const root of walkRoots) {
      const found = walkFindHdc(root)
      if (found) return found
    }
  }
  return findOnPath(HDC_EXE)
}

/**
 * 在 root 下限深搜索名为 hdc 的可执行文件（macOS SDK 目录带版本号、布局不
 * 固定——按目录逐层找，限深 6、限目录数 500，防大目录拖慢）。
 */
function walkFindHdc (root, maxDepth = 6) {
  if (!root || !existsSync(root)) return null
  const stack = [[root, 0]]
  let visited = 0
  while (stack.length && visited < 500) {
    const [dir, depth] = stack.pop()
    visited++
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (_) { continue }
    for (const e of entries) {
      if (!e.isDirectory() && (e.name === HDC_EXE || e.name === HDC_EXE + '.exe')) return join(dir, e.name)
    }
    if (depth < maxDepth) {
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) stack.push([join(dir, e.name), depth + 1])
      }
    }
  }
  return null
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