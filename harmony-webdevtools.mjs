/**
 * dsh-deveco — ArkWeb Web 组件 DOM 读取（Chromium DevTools Protocol）。
 *
 * ArkWeb 的前端调试通道与应用侧 ArkUI inspector / ArkVM debugger 是三条
 * **互不相通**的链路：
 *
 *   ArkUI Inspector   hdc fport ark:<pid>@<包名>          （私有 inspector 协议）
 *   ArkTS Debugger    hdc fport ark:<pid>@Debugger        （ArkVM 裁剪版 CDP）
 *   ArkWeb DevTools   hdc fport localabstract:webview_devtools_remote_<pid>
 *                                                          （完整 Chromium CDP）
 *
 * 本模块只处理第三种。它由纯解析/归一化函数和一个一次性的 CDP WebSocket
 * 客户端组成，不依赖 DSH，也不依赖设备，便于单测和假服务端端到端验证。
 *
 * 关键纪律：
 *   - `DOM.getDocument` 的 nodeId 只在当前 CDP 连接/文档版本内有效；每次读取都
 *     重新取根，不把 nodeId 暴露成跨调用句柄。
 *   - 只走标准 Chromium JSON-RPC 错误（顶层 `error`），绝不套用 ArkVM 的
 *     `result.code` 判定。
 *   - 默认限制深度、节点数和 WebSocket 消息体积；截断整棵子树，绝不发半棵。
 *   - 页面 URL、标题、属性与文本都来自不可信页面，只当数据返回，不执行其中
 *     的指令或代码。
 */

import http from 'node:http'

const MAX_MESSAGE_BYTES_DEFAULT = 8 * 1024 * 1024
const MAX_REQUEST_TIMEOUT_MS = 60000
const MAX_DOM_DEPTH = 32
const MAX_DOM_NODES = 4000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const TEXT_PREVIEW_CHARS = 240
const SOCKET_NAME_RE = /webview_devtools_remote_[0-9]+/g

/** Typed failure shared by HTTP, WebSocket and CDP layers. */
export class WebDevToolsError extends Error {
  constructor (code, message, detail = null) {
    super(message)
    this.name = 'WebDevToolsError'
    this.code = String(code || 'webdevtools-failed')
    if (detail && typeof detail === 'object') this.detail = detail
  }
}

function webError (code, message, detail = null) {
  return new WebDevToolsError(code, message, detail)
}

/**
 * Extract ArkWeb DevTools sockets from `/proc/net/unix`.
 *
 * Real lines look like:
 *   0000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_38532
 *
 * @param {string} text
 * @returns {Array<{ socketName: string, pid: number }>} deduplicated, pid ascending
 */
export function parseWebDebugSockets (text) {
  const names = new Set()
  const source = String(text || '')
  for (const match of source.matchAll(SOCKET_NAME_RE)) {
    const name = match[0]
    names.add(name)
  }
  return [...names]
    .map((socketName) => ({ socketName, pid: Number(socketName.slice('webview_devtools_remote_'.length)) }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0)
    .sort((a, b) => a.pid - b.pid)
}

/** `hdc fport` argv for one ArkWeb DevTools socket. */
export function buildWebForwardArgs (localPort, socketName) {
  const port = Number(localPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw webError('invalid-request', `无效的本地端口：${localPort}`)
  }
  if (typeof socketName !== 'string' || !socketName.startsWith('webview_devtools_remote_')) {
    throw webError('invalid-request', `无效的 ArkWeb DevTools socket 名：${socketName}`)
  }
  return ['fport', `tcp:${port}`, `localabstract:${socketName}`]
}

/** `hdc fport rm` argv; only remove the rule this plugin created. */
export function buildWebForwardRemoveArgs (localPort, socketName) {
  const port = Number(localPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw webError('invalid-request', `无效的本地端口：${localPort}`)
  }
  return ['fport', 'rm', `tcp:${port}`, `localabstract:${socketName}`]
}

/** Reconstruct the page WebSocket URL from OUR forwarded local port. */
export function buildWebSocketUrl (localPort, targetId) {
  const port = Number(localPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw webError('invalid-request', `无效的本地端口：${localPort}`)
  }
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw webError('invalid-target', '缺少 DevTools target id')
  }
  return `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(targetId.trim())}`
}

/**
 * Normalize `/json` or `/json/list` output to JSON-safe target rows.
 * The raw `webSocketDebuggerUrl` is intentionally not returned: its host/port
 * may name the device side and becomes stale when our forward changes.
 *
 * @param {unknown} payload parsed JSON, or a JSON string
 * @returns {Array<{ id: string, type: string, title: string, url: string, description: string }>}
 */
export function parseDevToolsTargets (payload) {
  let value = payload
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (_) {
      throw webError('devtools-http-failed', 'DevTools /json 返回的不是有效 JSON')
    }
  }
  if (value && !Array.isArray(value) && Array.isArray(value.targets)) value = value.targets
  if (!Array.isArray(value)) {
    throw webError('devtools-http-failed', 'DevTools /json 返回的不是 target 数组')
  }
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      type: typeof item.type === 'string' ? item.type : '',
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      description: typeof item.description === 'string' ? item.description : '',
    })
  }
  return out
}

/**
 * Select one target.
 * Explicit id wins. Otherwise auto-select only a single page/webview target;
 * multiple candidates stay ambiguous instead of guessing.
 *
 * @param {Array<{ id: string, type?: string }>} targets
 * @param {string} [targetId]
 * @returns {object|null}
 */
export function selectWebTarget (targets, targetId) {
  const list = Array.isArray(targets) ? targets : []
  if (typeof targetId === 'string' && targetId.trim()) {
    return list.find((target) => target && target.id === targetId.trim()) || null
  }
  const pageLike = list.filter((target) => target && (target.type === 'page' || target.type === 'webview'))
  if (pageLike.length === 1) return pageLike[0]
  if (pageLike.length === 0 && list.length === 1) return list[0]
  return null
}

/**
 * HTTP GET one local DevTools endpoint. Never accepts an arbitrary origin:
 * only loopback 127.0.0.1 and a path beginning with `/json` are allowed.
 *
 * @param {number} port local forwarded port
 * @param {string} [path]
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<any>} parsed JSON
 */
export function fetchDevToolsJson (port, path = '/json', options = {}) {
  const localPort = Number(port)
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    return Promise.reject(webError('invalid-request', `无效的本地端口：${port}`))
  }
  const requestPath = typeof path === 'string' && path ? path : '/json'
  if (!requestPath.startsWith('/json')) {
    return Promise.reject(webError('invalid-request', `拒绝请求非 DevTools JSON 路径：${requestPath}`))
  }
  const timeoutMs = clampTimeout(options.timeoutMs, 5000)
  const maxBytes = clampBytes(options.maxBytes, 2 * 1024 * 1024)

  return new Promise((resolve, reject) => {
    let settled = false
    let req = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (req) req.destroy()
      fn(value)
    }
    req = http.get({
      host: '127.0.0.1',
      port: localPort,
      path: requestPath,
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        if (settled) return
        bytes += chunk.length
        if (bytes > maxBytes) {
          finish(reject, webError('devtools-http-failed', `DevTools 响应超过 ${maxBytes} 字节上限`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        if (res.statusCode !== 200) {
          finish(reject, webError('devtools-http-failed', `DevTools ${requestPath} 返回 HTTP ${res.statusCode}`))
          return
        }
        try {
          finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          finish(reject, webError('devtools-http-failed', `DevTools ${requestPath} 返回的不是有效 JSON：${error.message}`))
        }
      })
      res.on('error', (error) => finish(reject, webError('devtools-http-failed', `DevTools HTTP 响应失败：${error.message}`)))
    })
    req.setTimeout(timeoutMs, () => {
      finish(reject, webError('devtools-http-timeout', `DevTools ${requestPath} 请求超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => {
      finish(reject, webError('devtools-http-failed', `连接 DevTools ${requestPath} 失败：${error.message}`))
    })
  })
}

function clampTimeout (value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1000, Math.min(Math.floor(n), MAX_REQUEST_TIMEOUT_MS))
}

function clampBytes (value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(64 * 1024, Math.floor(n))
}

function clampDepth (value, fallback = 8) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(Math.floor(n), MAX_DOM_DEPTH))
}

function clampNodes (value, fallback = 400) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(Math.floor(n), MAX_DOM_NODES))
}

function asFiniteInt (value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function attributePairs (node) {
  if (Array.isArray(node && node.attributes)) {
    const out = []
    for (let i = 0; i + 1 < node.attributes.length; i += 2) {
      out.push([String(node.attributes[i]), String(node.attributes[i + 1])])
    }
    return out
  }
  if (node && node.attributes && typeof node.attributes === 'object') {
    return Object.entries(node.attributes).map(([key, value]) => [String(key), String(value)])
  }
  return []
}

function directChildrenOf (node) {
  const direct = []
  if (!node || typeof node !== 'object') return direct
  if (Array.isArray(node.children)) direct.push(...node.children)
  if (Array.isArray(node.shadowRoots)) direct.push(...node.shadowRoots)
  if (node.contentDocument && typeof node.contentDocument === 'object') direct.push(node.contentDocument)
  if (node.templateContent && typeof node.templateContent === 'object') direct.push(node.templateContent)
  return direct.filter((child) => child && typeof child === 'object')
}

function nodeTextPreview (node) {
  if (!node || typeof node !== 'object') return ''
  const own = typeof node.nodeValue === 'string' ? node.nodeValue : ''
  if (own.trim()) return collapseText(own)
  if (node.nodeType !== 1) return ''
  const directText = (Array.isArray(node.children) ? node.children : [])
    .filter((child) => child && child.nodeType === 3 && typeof child.nodeValue === 'string')
    .map((child) => child.nodeValue)
  return directText.length ? collapseText(directText.join(' ')) : ''
}

function collapseText (value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > TEXT_PREVIEW_CHARS ? `${text.slice(0, TEXT_PREVIEW_CHARS)}…` : text
}

function displayTag (node) {
  if (!node || typeof node !== 'object') return 'Node'
  if (node.nodeType === 3) return '#text'
  if (node.nodeType === 8) return '#comment'
  if (node.nodeType === 9) return '#document'
  if (node.nodeType === 10) {
    const name = typeof node.nodeName === 'string' && node.nodeName ? node.nodeName : 'html'
    return `<!doctype ${name.toLowerCase()}>`
  }
  const local = typeof node.localName === 'string' ? node.localName : ''
  if (local) return local
  const name = typeof node.nodeName === 'string' ? node.nodeName : ''
  return name || (node.shadowRootType ? '#shadow-root' : 'Node')
}



/**
 * Flatten one CDP `Node` subtree into a bounded, JSON-safe node list.
 *
 * Truncation is whole-subtree-only: when maxNodes or maxDepth drops a branch,
 * the nearest kept parent gets `childrenOmitted: true` and `hiddenDirect`
 * counts the omitted direct children. `childCount` always keeps the original
 * direct-child count. Stale/depth-limited CDP children are also reported as
 * omitted instead of being misrepresented as natural leaves.
 *
 * @param {object} root CDP Node
 * @param {{ maxDepth?: number, maxNodes?: number, includeAttrs?: boolean }} [options]
 * @returns {{ nodes: object[], nodeCount: number, truncated: boolean, hiddenNodes: number }}
 */
export function normalizeWebDom (root, options = {}) {
  if (!root || typeof root !== 'object') {
    throw webError('empty-dom', 'DevTools 没有返回 DOM 根节点')
  }
  const maxDepth = clampDepth(options.maxDepth, 8)
  const maxNodes = clampNodes(options.maxNodes, 400)
  const includeAttrs = options.includeAttrs === true
  const nodes = []
  let rawCount = 0
  let hiddenNodes = 0
  let truncated = false
  const visitedObjects = new WeakSet()
  const countedObjects = new WeakSet()

  // CDP describeNode can report nodeId = 0 for descendants that were not
  // pushed into the frontend node map, so raw counting must NOT dedupe by
  // nodeId. Object identity is sufficient and also handles cycles.
  const countRaw = (node) => {
    if (!node || typeof node !== 'object') return
    if (countedObjects.has(node)) return
    countedObjects.add(node)
    rawCount += 1
    for (const child of directChildrenOf(node)) countRaw(child)
  }
  countRaw(root)

  const visit = (source, depth, parentIndex) => {
    if (!source || typeof source !== 'object') return
    if (visitedObjects.has(source)) {
      truncated = true
      return
    }
    visitedObjects.add(source)

    if (nodes.length >= maxNodes) {
      truncated = true
      return
    }

    const pairs = attributePairs(source)
    const attrs = Object.fromEntries(pairs)
    const children = directChildrenOf(source)
    const declaredChildCount = Number.isFinite(Number(source.childNodeCount))
      ? Math.max(0, Math.trunc(Number(source.childNodeCount)))
      : children.length
    const childCount = Math.max(declaredChildCount, children.length)
    const text = nodeTextPreview(source)
    const tag = displayTag(source)
    const node = {
      index: nodes.length,
      depth,
      parentIndex,
      nodeType: asFiniteInt(source.nodeType, 1),
      tag,
      name: tag,
      text,
      childCount,
      attrCount: pairs.length,
    }
    if (source.nodeName) node.nodeName = String(source.nodeName)
    if (source.localName) node.localName = String(source.localName)
    if (source.shadowRootType) node.shadowRootType = String(source.shadowRootType)
    if (source.frameId) node.frameId = String(source.frameId)
    if (attrs.id) node.id = attrs.id
    if (attrs.class) node.classes = attrs.class.split(/\s+/).filter(Boolean)
    if (includeAttrs) node.attributes = attrs

    nodes.push(node)

    const rawGap = Math.max(0, childCount - children.length)
    let hiddenDirect = rawGap
    if (rawGap > 0) truncated = true

    if (depth >= maxDepth) {
      if (children.length > 0) {
        hiddenDirect += children.length
        truncated = true
      }
      if (hiddenDirect > 0) {
        node.childrenOmitted = true
        node.hiddenDirect = hiddenDirect
        hiddenNodes += hiddenDirect
      }
      return
    }

    for (const child of children) {
      const before = nodes.length
      visit(child, depth + 1, node.index)
      if (nodes.length === before) {
        hiddenDirect += 1
        hiddenNodes += 1
        truncated = true
      }
    }
    if (hiddenDirect > 0) {
      node.childrenOmitted = true
      node.hiddenDirect = hiddenDirect
    }
  }

  visit(root, 0, -1)
  return { nodes, nodeCount: rawCount, truncated, hiddenNodes }
}

/** Render normalized DOM nodes as an indented, model-readable tree. */
export function webDomTreeLines (nodes) {
  const out = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node) continue
    const indent = '  '.repeat(Math.max(0, asFiniteInt(node.depth, 0)))
    let label = node.tag || node.name || 'Node'
    if (node.tag !== '#text' && node.tag !== '#comment' && node.tag !== '#document') {
      if (node.id) label += `#${node.id}`
      if (Array.isArray(node.classes) && node.classes.length) label += `.${node.classes.join('.')}`
    }
    const parts = [`${indent}${label}`]
    if (node.text) parts.push(JSON.stringify(node.text))
    if (node.attrCount) parts.push(`[${node.attrCount} attrs]`)
    if (node.childCount && node.childrenOmitted) parts.push(`+${node.hiddenDirect || 0}/${node.childCount} children hidden`)
    else if (node.childCount) parts.push(`(${node.childCount} children)`)
    out.push(parts.join(' '))
  }
  return out
}

/** Render target rows for the agent tool. */
export function webTargetLines (targets) {
  return (Array.isArray(targets) ? targets : []).map((target) => {
    const head = `[${target.pid}] ${target.title || '(untitled)'}`
    const meta = [target.type || 'unknown', target.url || ''].filter(Boolean).join(' · ')
    const tail = target.id ? `id=${target.id}` : ''
    return [head, meta, tail].filter(Boolean).join(' — ')
  })
}

/**
 * Minimal CDP client over one page WebSocket. One instance is one short-lived
 * read session; close it in `finally`.
 */
export class WebDevToolsSession {
  constructor (options = {}) {
    this.port = Number(options.port)
    this.targetId = typeof options.targetId === 'string' ? options.targetId : ''
    this.timeoutMs = clampTimeout(options.timeoutMs, 10000)
    this.maxMessageBytes = clampBytes(options.maxMessageBytes, MAX_MESSAGE_BYTES_DEFAULT)
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket
    this.ws = null
    this.closed = false
    this.nextId = 1
    this.pending = new Map()
  }

  get url () {
    return buildWebSocketUrl(this.port, this.targetId)
  }

  /** Open the WebSocket and wait for the HTTP 101 upgrade. */
  async connect () {
    if (typeof this.WebSocketImpl !== 'function') {
      throw webError('devtools-ws-unsupported', '当前 Node 运行时不提供标准 WebSocket，无法连接 ArkWeb DevTools')
    }
    if (this.ws) throw webError('devtools-ws-failed', 'WebSocket 会话已存在')
    let ws
    try {
      ws = new this.WebSocketImpl(this.url)
    } catch (error) {
      throw webError('devtools-ws-failed', `创建 DevTools WebSocket 失败：${error.message}`)
    }
    this.ws = ws
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          fn(value)
        }
        const timer = setTimeout(() => {
          finish(reject, webError('devtools-ws-timeout', `连接 DevTools WebSocket 超时（${this.timeoutMs}ms）`))
        }, this.timeoutMs)
        ws.onopen = () => {
          clearTimeout(timer)
          finish(resolve)
        }
        ws.onerror = (event) => {
          clearTimeout(timer)
          const message = (event && event.message) ? String(event.message) : '握手失败或被目标拒绝'
          finish(reject, webError('devtools-ws-handshake-failed', `连接 ${this.url} 失败：${message}`))
        }
        ws.onclose = (event) => {
          clearTimeout(timer)
          this.closed = true
          this._rejectPending(webError('devtools-ws-closed', `DevTools WebSocket 已关闭（code=${event && event.code}）`))
          if (!settled) finish(reject, webError('devtools-ws-handshake-failed', `DevTools WebSocket 在握手阶段关闭（code=${event && event.code}）`))
        }
      })
    } catch (error) {
      this.close()
      throw error
    }
    ws.onmessage = (event) => this._handleMessage(event)
  }

  _handleMessage (event) {
    const data = event && event.data
    if (typeof data !== 'string') {
      if (typeof data === 'object' && data !== null && typeof data.text === 'function') {
        data.text().then((text) => this._parseMessage(text)).catch(() => {})
      } else if (data instanceof ArrayBuffer) {
        this._parseMessage(Buffer.from(data).toString('utf8'))
      }
      return
    }
    this._parseMessage(data)
  }

  _parseMessage (text) {
    const raw = String(text || '')
    if (Buffer.byteLength(raw, 'utf8') > this.maxMessageBytes) {
      const error = webError('devtools-response-too-large', `DevTools 响应超过 ${this.maxMessageBytes} 字节上限`)
      this._rejectPending(error)
      try { this.ws && this.ws.close() } catch (_) { /* best effort */ }
      return
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch (_) {
      return
    }
    if (!message || !Number.isFinite(Number(message.id))) return
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      const code = message.error.code !== undefined ? message.error.code : 'unknown'
      pending.reject(webError('cdp-error', `CDP ${pending.method} 失败（${code}）：${message.error.message || 'unknown error'}`, message.error))
      return
    }
    pending.resolve(message.result || {})
  }

  _rejectPending (error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Send one CDP command and wait for its matching response. */
  request (method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.ws || this.closed) {
      return Promise.reject(webError('devtools-ws-closed', 'DevTools WebSocket 尚未连接或已关闭'))
    }
    const id = this.nextId++
    const timeout = clampTimeout(timeoutMs, this.timeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(webError('cdp-timeout', `CDP ${method} 超时（${timeout}ms）`))
      }, timeout)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(webError('devtools-ws-failed', `发送 CDP ${method} 失败：${error.message}`))
      }
    })
  }

  /** Close the WebSocket; pending calls fail with a closed-session error. */
  close () {
    this.closed = true
    this._rejectPending(webError('devtools-ws-closed', 'DevTools WebSocket 已关闭'))
    const ws = this.ws
    if (!ws) return Promise.resolve()
    try { ws.close(1000, 'done') } catch (_) { /* best effort */ }
    return Promise.resolve()
  }
}

/**
 * One-shot DOM read over a forwarded DevTools port.
 *
 * @param {{
 *   port: number,
 *   targetId: string,
 *   selector?: string,
 *   depth?: number,
 *   maxNodes?: number,
 *   includeAttrs?: boolean,
 *   includeHtml?: boolean,
 *   pierce?: boolean,
 *   timeoutMs?: number,
 *   maxMessageBytes?: number,
 *   maxHtmlBytes?: number,
 *   WebSocketImpl?: Function
 * }} options
 * @returns {Promise<{ targetId: string, nodes: object[], nodeCount: number, truncated: boolean, hiddenNodes: number, html?: string, htmlTruncated?: boolean }>}
 */
export async function readWebDom (options = {}) {
  const maxDepth = clampDepth(options.depth, 8)
  const maxNodes = clampNodes(options.maxNodes, 400)
  const includeAttrs = options.includeAttrs === true
  const includeHtml = options.includeHtml === true
  const pierce = options.pierce !== false
  const selector = typeof options.selector === 'string' ? options.selector.trim() : ''
  const maxHtmlBytes = clampBytes(options.maxHtmlBytes, MAX_HTML_BYTES)
  const session = new WebDevToolsSession({
    port: options.port,
    targetId: options.targetId,
    timeoutMs: options.timeoutMs,
    maxMessageBytes: options.maxMessageBytes,
    WebSocketImpl: options.WebSocketImpl,
  })
  try {
    await session.connect()
    const document = await session.request('DOM.getDocument', {
      depth: selector ? 1 : maxDepth,
      pierce,
    }, options.timeoutMs)
    const root = document && document.root
    if (!root || typeof root !== 'object') throw webError('empty-dom', 'DevTools DOM.getDocument 没有返回根节点')
    let selected = root
    if (selector) {
      const found = await session.request('DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      }, options.timeoutMs)
      const nodeId = found && Number(found.nodeId)
      if (!nodeId) throw webError('selector-not-found', `CSS 选择器没有命中任何节点：${selector}`)
      const described = await session.request('DOM.describeNode', {
        nodeId,
        depth: maxDepth,
        pierce,
      }, options.timeoutMs)
      selected = described && described.node
      if (!selected || typeof selected !== 'object') throw webError('empty-dom', `选择器 ${selector} 命中节点但 describeNode 没有返回子树`)
    }
    const normalized = normalizeWebDom(selected, { maxDepth, maxNodes, includeAttrs })
    const value = {
      targetId: session.targetId,
      ...normalized,
    }
    if (includeHtml) {
      // A CDP Document node may serialize as an empty outerHTML; use its
      // documentElement (the first element child) instead.
      let htmlNodeId = selected.nodeId
      if (selected.nodeType === 9) {
        const element = (Array.isArray(selected.children) ? selected.children : [])
          .find((child) => child && child.nodeType === 1 && Number(child.nodeId))
        if (element) htmlNodeId = element.nodeId
      }
      const htmlReply = await session.request('DOM.getOuterHTML', {
        nodeId: htmlNodeId,
      }, options.timeoutMs)
      let html = typeof htmlReply.outerHTML === 'string' ? htmlReply.outerHTML : ''
      if (Buffer.byteLength(html, 'utf8') > maxHtmlBytes) {
        html = html.slice(0, maxHtmlBytes)
        value.htmlTruncated = true
      }
      value.html = html
    }
    return value
  } finally {
    await session.close()
  }
}

export const WEB_DEVTOOLS_LIMITS = {
  maxDomDepth: MAX_DOM_DEPTH,
  maxDomNodes: MAX_DOM_NODES,
  maxMessageBytes: MAX_MESSAGE_BYTES_DEFAULT,
  maxHtmlBytes: MAX_HTML_BYTES,
}
