/**
 * dsh-deveco — ArkTS (ArkVM / Panda) remote debugger client (Host half).
 *
 * The channel is the one DevEco Studio uses, independently re-derived and
 * verified against a HarmonyOS 6.0 emulator (see docs/arkts-debug-recon.md):
 *
 *   1. `hdc fport tcp:<local> ark:<pid>@Debugger` forwards local TCP to the
 *      app-side ArkTS debugger. (`ark:<pid>@<bundle>` is the ArkUI *Inspector*
 *      channel — a different protocol; never mix them.)
 *   2. The app-side HTTP parser is a hand-written minimal one, so the upgrade
 *      request must be exactly the six Java-WebSocket headers (no
 *      `sec-websocket-extensions`, no `user-agent`): reuse
 *      `buildDevEcoWsHandshake` from harmony-device.mjs.
 *   3. Messages are WebSocket **text** frames carrying CDP-shaped JSON-RPC:
 *      `{id, method, params}` → `{id, result}`; events have no `id`.
 *      **Errors are reported inside `result` as `{code, message}`**, not in a
 *      JSON-RPC `error` member — `isDebuggerError()` is the only correct test.
 *
 * One debugger session exists per pid (single client): reattaching to a pid
 * that already has a session reuses it, and the hdc forward rule is removed
 * when the session closes.
 */

import net from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  buildDevEcoWsHandshake,
  isWsHandshakeAccepted,
  encodeWsClientTextFrame,
  encodeWsPongFrame,
  decodeWsServerFrames,
} from './harmony-device.mjs'

/** @param {number} port @param {number} pid @returns {string} */
export function debuggerForwardTarget (pid) {
  return `ark:${pid}@Debugger`
}

/**
 * `hdc fport` argv for the ArkTS debugger (two-segment form, verified).
 * @param {number} port @param {number} pid @returns {string[]}
 */
export function buildDebuggerForwardArgs (port, pid) {
  return ['fport', `tcp:${port}`, debuggerForwardTarget(pid)]
}

/** `hdc fport rm` argv that removes exactly the rule above. */
export function buildDebuggerForwardRemoveArgs (port, pid) {
  return ['fport', 'rm', `tcp:${port}`, debuggerForwardTarget(pid)]
}

/**
 * True when a debugger reply carries an application-level error.
 *
 * The ArkVM protocol reports failures as `result.code` / `result.message`
 * inside a *successful* JSON-RPC envelope (e.g. `{"result":{"code":1,
 * "message":"Can only perform operation while paused"}}`), so a generic CDP
 * client would treat that as a value. Every reply must pass through here.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function isDebuggerError (result) {
  return !!result && typeof result === 'object' && (result.code !== undefined || result.message !== undefined)
}

/**
 * Compact projection of `Debugger.paused` call frames.
 *
 * @param {Array<object>} callFrames
 * @param {number} [max]
 * @returns {Array<{ index: number, callFrameId: string, functionName: string, url: string, lineNumber: number, columnNumber: number, scriptId: string }>}
 */
export function summarizeCallFrames (callFrames, max = 20) {
  const frames = Array.isArray(callFrames) ? callFrames.slice(0, Math.max(1, max)) : []
  return frames.map((frame, index) => {
    const location = frame && frame.location ? frame.location : {}
    return {
      index,
      callFrameId: frame && frame.callFrameId !== undefined ? String(frame.callFrameId) : '',
      functionName: frame && typeof frame.functionName === 'string' ? frame.functionName : '',
      url: frame && typeof frame.url === 'string' ? frame.url : '',
      lineNumber: Number.isFinite(Number(location.lineNumber)) ? Number(location.lineNumber) : -1,
      columnNumber: Number.isFinite(Number(location.columnNumber)) ? Number(location.columnNumber) : 0,
      scriptId: location.scriptId !== undefined ? String(location.scriptId) : '',
    }
  })
}

/**
 * Human-readable one-line-per-frame stack. ArkTS URLs look like
 * `entry|hrouter|2.0.0|src/main/ets/...`; keep them verbatim — a breakpoint
 * only resolves when its `url` equals the `scriptParsed.url` exactly.
 *
 * @param {Array<object>} frames summarizeCallFrames output
 * @returns {string[]}
 */
export function formatCallFrameLines (frames) {
  if (!Array.isArray(frames) || frames.length === 0) return []
  return frames.map((f) => {
    const at = f.url ? `${f.url}:${f.lineNumber + 1}` : `<script ${f.scriptId}>:${f.lineNumber + 1}`
    return `#${f.index} ${f.functionName || '<anonymous>'} @ ${at}`
  })
}

/**
 * Ask the OS for an unused loopback port (the debugger forward needs a local
 * TCP port; hdc cannot choose one for us).
 *
 * @returns {Promise<number>}
 */
export function pickFreePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

const DEFAULT_TIMEOUT_MS = 8000
const PAUSE_TIMEOUT_MS = 12000

/**
 * One live ArkTS debugger session (one pid, one forwarded port, one socket).
 */
export class ArktsDebuggerSession {
  /**
   * @param {object} opts
   * @param {number} opts.pid
   * @param {number} opts.port Local port already forwarded to `ark:<pid>@Debugger`.
   * @param {string} [opts.bundleName]
   * @param {string} [opts.device]
   */
  constructor (opts) {
    this.pid = Number(opts.pid)
    this.port = Number(opts.port)
    this.bundleName = opts.bundleName || ''
    this.device = opts.device || ''
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.handshakeDone = false
    this.closed = false
    this.nextId = 1
    /** @type {Map<number, { resolve: Function, timer: any }>} */
    this.pending = new Map()
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map()
    /** @type {Array<{ method: string, params: object, at: number }>} */
    this.events = []
    /** @type {Map<string, string>} url → scriptId */
    this.scripts = new Map()
    /** @type {object|null} last Debugger.paused params */
    this.paused = null
    /** @type {string[]} */
    this.protocols = []
    /** @type {Array<object>} client-side breakpoint table */
    this.breakpoints = []
    /** @type {string[]} */
    this.consoleMessages = []
    this.lastError = ''
  }

  /** @returns {Promise<void>} resolves once the 101 handshake completes. */
  connect (timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: this.port })
      this.socket = socket
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch (_) { /* */ }
        reject(new Error(`WebSocket 握手超时（${timeoutMs}ms）：应用未监听调试端口，或不是 debug 签名应用`))
      }, timeoutMs)
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      socket.on('connect', () => {
        const key = randomBytes(16).toString('base64')
        socket.write(buildDevEcoWsHandshake(`127.0.0.1:${this.port}`, key))
      })
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (!this.handshakeDone) {
          const end = this.buffer.indexOf('\r\n\r\n')
          if (end < 0) {
            if (this.buffer.length > 16384) finish(new Error('WebSocket 握手响应异常（响应头过长）'))
            return
          }
          const head = this.buffer.subarray(0, end + 4).toString('utf8')
          this.buffer = this.buffer.subarray(end + 4)
          if (!isWsHandshakeAccepted(head)) {
            finish(new Error(`WebSocket 握手被拒：${head.split('\r\n')[0] || '无响应'}（应用可能不是 debug 签名、调试端口被 DevEco 占用，或 fport 目标错误）`))
            try { socket.destroy() } catch (_) { /* */ }
            return
          }
          this.handshakeDone = true
          finish()
        }
        this._drain()
      })
      socket.on('error', (error) => {
        this.closed = true
        if (!this.handshakeDone) finish(error)
        this._rejectAll(new Error('调试器连接错误：' + (error && error.message ? error.message : String(error))))
      })
      socket.on('close', () => {
        this.closed = true
        if (!this.handshakeDone) finish(new Error('调试器连接被关闭（应用未运行、非 debug 签名或端口被占用）'))
        this._rejectAll(new Error('调试器连接已关闭'))
      })
    })
  }

  _drain () {
    const decoded = decodeWsServerFrames(this.buffer)
    this.buffer = decoded.rest
    for (const ping of decoded.pings) {
      try { this.socket.write(encodeWsPongFrame(ping)) } catch (_) { /* */ }
    }
    for (const text of decoded.texts) this._handleMessage(text)
    if (decoded.closed) {
      this.closed = true
      this._rejectAll(new Error('调试器会话已结束'))
    }
  }

  _handleMessage (text) {
    let message
    try { message = JSON.parse(text) } catch (_) { return }
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (isDebuggerError(message.result)) {
        entry.resolve({ ok: false, error: { code: message.result.code, message: message.result.message || 'debugger error' } })
      } else if (message.error) {
        entry.resolve({ ok: false, error: { code: message.error.code, message: message.error.message || 'debugger error' } })
      } else {
        entry.resolve({ ok: true, value: message.result })
      }
      return
    }
    if (typeof message.method === 'string') this._handleEvent(message.method, message.params || {})
  }

  _handleEvent (method, params) {
    this.events.push({ method, params, at: Date.now() })
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400)
    if (method === 'Debugger.scriptParsed' && params && typeof params.url === 'string') {
      this.scripts.set(params.url, String(params.scriptId))
    }
    if (method === 'Debugger.paused') {
      this.paused = {
        reason: typeof params.reason === 'string' ? params.reason : '',
        hitBreakpoints: Array.isArray(params.hitBreakpoints) ? params.hitBreakpoints : [],
        frames: summarizeCallFrames(params.callFrames, 40),
      }
    }
    if (method === 'Debugger.resumed') this.paused = null
    if (method === 'Runtime.consoleAPICalled' || method === 'Console.messageAdded') {
      const text = JSON.stringify(params)
      this.consoleMessages.push(text)
      if (this.consoleMessages.length > 200) this.consoleMessages.splice(0, this.consoleMessages.length - 200)
    }
    const set = this.listeners.get(method)
    if (set) for (const fn of set) { try { fn(params) } catch (_) { /* */ } }
  }

  /**
   * Register an event listener.
   * @param {string} method @param {Function} fn @returns {Function} unsubscribe
   */
  on (method, fn) {
    let set = this.listeners.get(method)
    if (!set) { set = new Set(); this.listeners.set(method, set) }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  /**
   * Await one event (optionally matching a predicate).
   * @param {string} method @param {Function} [predicate] @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  waitEvent (method, predicate, timeoutMs = PAUSE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        if (predicate && !predicate(params)) return
        off()
        clearTimeout(timer)
        resolve(params)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`等待 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })
  }

  /**
   * Send one JSON-RPC request and await its reply.
   * @param {string} method @param {object} [params] @param {number} [timeoutMs]
   * @returns {Promise<{ ok: boolean, value?: object, error?: object }>}
   */
  request (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.resolve({ ok: false, error: { code: 'closed', message: '调试器会话已关闭' } })
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ ok: false, error: { code: 'timeout', message: `${method} 无回包（${timeoutMs}ms）` } })
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.socket.write(encodeWsClientTextFrame(JSON.stringify({ id, method, params })))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: { code: 'write-failed', message: error && error.message ? error.message : String(error) } })
      }
    })
  }

  /**
   * Runtime.enable → Debugger.enable → setBreakpointsActive → runIfWaiting.
   *
   * `Runtime.runIfWaitingForDebugger` is what *releases* an app that was
   * started with `aa appdebug` and is blocked at entry waiting for a debugger;
   * the runtime only registers its scripts and emits the entry
   * `Debugger.paused` ("Break on start") **after** that message. Without it an
   * attach to a wait-for-debugger app yields an empty session (verified).
   *
   * @param {object} [opts]
   * @param {boolean} [opts.runIfWaiting] Release a waiting app (default true).
   * @returns {Promise<{ ok: boolean, value?: object, error?: object }>}
   */
  async init (opts = {}) {
    const runtime = await this.request('Runtime.enable', {})
    if (!runtime.ok) return runtime
    const debuggerEnable = await this.request('Debugger.enable', { maxScriptsCacheSize: 100000000 })
    if (!debuggerEnable.ok) return debuggerEnable
    const capabilities = debuggerEnable.value && Array.isArray(debuggerEnable.value.protocols)
      ? debuggerEnable.value.protocols
      : []
    this.protocols = capabilities
    await this.request('Debugger.setBreakpointsActive', { active: true })
    if (opts.runIfWaiting !== false) {
      await this.request('Runtime.runIfWaitingForDebugger', {})
    }
    // Give the runtime a moment to emit scriptParsed / the entry pause.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { ok: true, value: { protocols: capabilities } }
  }

  /**
   * Wait until the runtime has reported loaded scripts or a pause.
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>} true when anything arrived.
   */
  async waitForEntry (timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.paused || this.scripts.size > 0 || this.closed) break
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return !!(this.paused || this.scripts.size > 0)
  }

  /** @param {number} [timeoutMs] */
  async resume (timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.request('Debugger.resume', {}, timeoutMs)
  }

  async pause (timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.request('Debugger.pause', {}, timeoutMs)
  }

  /**
   * @param {'over'|'into'|'out'} kind
   */
  async step (kind) {
    const method = kind === 'into' ? 'Debugger.stepInto' : kind === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver'
    return this.request(method, {}, PAUSE_TIMEOUT_MS)
  }

  /** Release a waiting-for-debugger app (`Runtime.runIfWaitingForDebugger`). */
  async runIfWaiting () {
    return this.request('Runtime.runIfWaitingForDebugger', {})
  }

  /**
   * @param {object} opts
   * @param {string} opts.url exact `scriptParsed.url`
   * @param {number} opts.line 0-based line
   * @param {number} [opts.column]
   * @param {string} [opts.condition]
   */
  async setBreakpoint ({ url, line, column = 0, condition }) {
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: { code: 'invalid', message: 'url is required (use the exact scriptParsed url)' } }
    }
    const lineNumber = Number(line)
    if (!Number.isFinite(lineNumber) || lineNumber < 0) {
      return { ok: false, error: { code: 'invalid', message: 'line must be a non-negative 0-based line number' } }
    }
    const extra = condition ? { condition: String(condition) } : {}
    let reply
    if (this.protocols.includes('getPossibleAndSetBreakpointByUrl')) {
      reply = await this.request('Debugger.getPossibleAndSetBreakpointByUrl', {
        locations: [{ url, lineNumber, columnNumber: Number(column) || 0, ...extra }],
      })
    } else {
      reply = await this.request('Debugger.setBreakpointByUrl', {
        url, lineNumber, columnNumber: Number(column) || 0, ...extra,
      })
    }
    if (!reply.ok) return reply
    const value = reply.value || {}
    const breakpointId = typeof value.breakpointId === 'string' && value.breakpointId
      ? value.breakpointId
      : `id:${lineNumber}:${Number(column) || 0}:${url}`
    const locations = Array.isArray(value.locations) ? value.locations : []
    this.breakpoints.push({ breakpointId, url, line: lineNumber, column: Number(column) || 0, condition: condition || '' })
    return { ok: true, value: { breakpointId, locations } }
  }

  /**
   * Remove one breakpoint by id or every breakpoint on a url.
   * @param {{ breakpointId?: string, url?: string }} opts
   */
  async removeBreakpoint ({ breakpointId, url }) {
    if (typeof breakpointId === 'string' && breakpointId) {
      const reply = await this.request('Debugger.removeBreakpoint', { breakpointId })
      if (reply.ok) this.breakpoints = this.breakpoints.filter((b) => b.breakpointId !== breakpointId)
      return reply
    }
    if (typeof url === 'string' && url) {
      const reply = await this.request('Debugger.removeBreakpointsByUrl', { url })
      if (reply.ok) this.breakpoints = this.breakpoints.filter((b) => b.url !== url)
      return reply
    }
    return { ok: false, error: { code: 'invalid', message: 'breakpoint_id or url is required' } }
  }

  /**
   * Evaluate an expression on the paused frame.
   * @param {string} expression
   * @param {number} [frameIndex]
   */
  async evaluate (expression, frameIndex = 0) {
    if (!this.paused) {
      return { ok: false, error: { code: 'not-paused', message: 'not paused：先 attach 并触发断点/暂停再求值（Runtime.evaluate 在该 ArkVM 上不支持）' } }
    }
    const frame = this.paused.frames[frameIndex]
    if (!frame) return { ok: false, error: { code: 'no-frame', message: `no call frame #${frameIndex}` } }
    return this.request('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: String(expression),
      objectGroup: 'dsh-deveco',
      includeCommandLineAPI: true,
      silent: false,
      returnByValue: false,
    }, PAUSE_TIMEOUT_MS)
  }

  /** Expand one remote object (`Runtime.getProperties`). */
  async properties (objectId) {
    return this.request('Runtime.getProperties', { objectId: String(objectId), ownProperties: true })
  }

  /** @param {'none'|'uncaught'|'all'} state */
  async setPauseOnExceptions (state) {
    const value = ['none', 'uncaught', 'all'].includes(state) ? state : 'none'
    return this.request('Debugger.setPauseOnExceptions', { state: value })
  }

  /** Close the socket; the caller removes the hdc forward rule. */
  close () {
    this.closed = true
    this._rejectAll(new Error('调试器会话已关闭'))
    try { this.socket && this.socket.destroy() } catch (_) { /* */ }
    this.socket = null
  }

  _rejectAll (error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: { code: 'closed', message: error.message } })
    }
    this.pending.clear()
  }
}
