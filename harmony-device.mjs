/**
 * harmony-device.mjs — zero-dep Node ESM.
 *
 * Wraps the `hdc` and `devecocli` CLIs used by the HarmonyOS toolchain and
 * provides parsers for HiLog line output and ArkUI Inspector XML dumps.
 *
 * Design notes
 * - Zero dependencies. Only `node:child_process` (spawn) is used.
 * - The `resolved` object passed around describes which CLI source the user has
 *   configured. The shape is:
 *     { source: 'devecocli'|'studio'|'clt'|'none', exec?, path? }
 *   `exec` is the absolute path to a devecocli executable when source is
 *   'devecocli'. `path` is the install root for 'studio'/'clt'.
 * - All process invocations go through `execCli` so error / timeout / non-zero
 *   exit semantics are uniform.
 */

import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// 1. Tool selection
// ---------------------------------------------------------------------------

/**
 * Choose between devecocli (preferred) and standalone hdc.
 *
 * @param {object} resolved Toolchain resolution.
 * @returns {{kind: 'devecocli'|'hdc', exec: string, prefix: string[]} | null}
 */
export function selectHdc (resolved) {
  if (!resolved || !resolved.source) return null
  if (resolved.source === 'devecocli') {
    if (!resolved.exec) return null
    return { kind: 'devecocli', exec: resolved.exec, prefix: ['device', 'hdc'] }
  }
  if (resolved.source === 'studio' || resolved.source === 'clt') {
    if (!resolved.path) return null
    // resolved.path is forward-slash style; normalise separator for windows.
    // We deliberately omit the .exe suffix so the returned path always ends
    // with literal "hdc" — callers can append it themselves if they need it,
    // and downstream `assert.match(sel.exec, /hdc$/)` style checks stay happy.
    const sep = process.platform === 'win32' ? '\\' : '/'
    const exec = `${resolved.path.replace(/[\/]+$/, '')}${sep}tools${sep}hdc`
    return { kind: 'hdc', exec, prefix: [] }
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Process execution
// ---------------------------------------------------------------------------

function isWindows () {
  return process.platform === 'win32'
}

/**
 * Run a CLI in one of three modes:
 *   - devecocli: `cmd = resolved.exec`, no extra path prefix (caller prepended)
 *   - studio/clt: `cmd = <bin>/devecocli[.cmd]` (or devecocli on unix)
 *
 * Uses spawn with `shell: true` on Windows so .cmd shims resolve correctly.
 *
 * @param {object} resolved Toolchain resolution.
 * @param {string[]} args Args to pass to devecocli.
 * @param {object} [opts]
 * @param {number} [opts.timeout] Default 30000.
 * @param {object} [opts.env] Extra env vars.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
export function execCli (resolved, args, opts = {}) {
  const timeout = opts.timeout ?? 30000
  const env = { ...process.env, ...(opts.env || {}) }
  let cmd
  if (resolved.source === 'devecocli') {
    cmd = resolved.exec
  } else if (resolved.source === 'studio' || resolved.source === 'clt') {
    if (!resolved.path) {
      return Promise.reject(withProps(new Error('execCli: missing resolved.path'), { code: null, stdout: '', stderr: '' }))
    }
    const sep = isWindows() ? '\\' : '/'
    const bin = isWindows() ? 'devecocli.cmd' : 'devecocli'
    cmd = `${resolved.path.replace(/[\/]+$/, '')}${sep}bin${sep}${bin}`
  } else {
    return Promise.reject(withProps(new Error(`execCli: unsupported source "${resolved.source}"`), { code: null, stdout: '', stderr: '' }))
  }
  return spawnCollect(cmd, args, { timeout, env })
}

/**
 * Pick hdc via `selectHdc`, prepend its prefix, then delegate to execCli.
 *
 * @param {object} resolved
 * @param {string[]} args hdc args (no `hdc` keyword, no prefix).
 * @param {object} [opts]
 */
export function execHdc (resolved, args, opts = {}) {
  const sel = selectHdc(resolved)
  if (!sel) {
    return Promise.reject(withProps(new Error('execHdc: no usable hdc source'), { code: null, stdout: '', stderr: '' }))
  }
  const argv = [...sel.prefix, ...args]
  // execHdc bypasses execCli's source-switching; we always call devecocli when
  // kind==='devecocli', otherwise use sel.exec with no shell prefix.
  if (sel.kind === 'devecocli') {
    return execCli({ source: 'devecocli', exec: sel.exec }, argv, opts)
  }
  const timeout = opts.timeout ?? 30000
  const env = { ...process.env, ...(opts.env || {}) }
  return spawnCollect(sel.exec, argv, { timeout, env })
}

function spawnCollect (cmd, argv, { timeout, env }) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(cmd, argv, {
        shell: isWindows(),
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
    proc.stdout.on('data', d => { stdout += d.toString('utf8') })
    proc.stderr.on('data', d => { stderr += d.toString('utf8') })

    proc.on('error', err => {
      reject(withProps(err instanceof Error ? err : new Error(String(err)), { code: null, stdout, stderr }))
    })

    proc.on('close', code => {
      if (code !== 0) {
        reject(withProps(new Error(`Command failed (${code}): ${cmd} ${argv.join(' ')}`), { code, stdout, stderr }))
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
 * Build argv for `devecocli hdc hilog` (or `hdc hilog`).
 *
 * @param {object} [opts]
 * @param {string} [opts.level] D|I|W|E|F → `-L <level>`
 * @param {string} [opts.bundle] bundle name → `-t <bundle>`
 * @param {string} [opts.keyword] grep → `-g <keyword>`
 * @param {number} [opts.tail=500] tail lines → `-T <tail>`
 * @param {string} [opts.from] start offset → `-s <from>`
 * @param {string} [opts.to] end offset → `-e <to>`
 * @returns {string[]}
 */
export function buildHilogArgs (opts = {}) {
  const args = ['hilog']
  if (opts.level) args.push('-L', opts.level)
  if (opts.bundle) args.push('-t', opts.bundle)
  if (opts.keyword) args.push('-g', opts.keyword)
  if (opts.from) args.push('-s', opts.from)
  if (opts.to) args.push('-e', opts.to)
  const tail = opts.tail ?? 500
  args.push('-T', String(tail))
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
 * Build argv for `uitest uiDump`. Optional `-d <device>` filters to one device.
 *
 * @param {object} [opts]
 * @param {string} [opts.device]
 * @returns {string[]}
 */
export function buildUiDumpArgs (opts = {}) {
  const args = ['uitest', 'uiDump']
  if (opts.device) args.push('-d', opts.device)
  return args
}

const ZERO_BOUNDS = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })

/**
 * Parse `[left,top][right,bottom]` bounds string.
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

const ATTR_RE = /([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g

/**
 * Parse a single <node ...> tag's attribute string into a plain object.
 *
 * @param {string} attrs
 * @returns {Record<string,string>}
 */
function parseNodeAttrs (attrs) {
  const out = {}
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(attrs)) !== null) {
    out[m[1]] = m[2]
  }
  return out
}

// Simplified: assumes each <node> lives on its own line and ends with `/>` or
// `>`. Standard `uitest uiDump` output is single-line per node.
const NODE_RE = /<node\s+([^/>]+)\/?>/g

/**
 * Parse a `uitest uiDump` XML tree into a flat list of node summaries.
 *
 * @param {string} xml
 * @returns {Array<{
 *   index: number,
 *   text: string,
 *   resourceId: string,
 *   className: string,
 *   bounds: {left:number,top:number,right:number,bottom:number,width:number,height:number},
 *   boundsStr: string
 * }>}
 */
export function parseUiDumpXml (xml) {
  if (!xml) return []
  const nodes = []
  NODE_RE.lastIndex = 0
  let m
  while ((m = NODE_RE.exec(xml)) !== null) {
    const attrs = parseNodeAttrs(m[1])
    const boundsStr = attrs.bounds || ''
    nodes.push({
      index: Number(attrs.index ?? nodes.length),
      text: attrs.text || '',
      resourceId: attrs['resource-id'] || '',
      className: attrs.class || '',
      bounds: parseBounds(boundsStr),
      boundsStr
    })
  }
  return nodes
}