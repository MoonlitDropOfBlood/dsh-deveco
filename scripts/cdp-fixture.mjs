// dsh-deveco — 零依赖「假 Chromium DevTools Protocol」服务（CDP fixture）。
//
// 用途：给 scripts/e2e-web-dom.mjs 与手工测试提供一台可控的假 Chromium：
//   - node:http 随机端口：GET /json、/json/list、/json/version（其余路径 404 JSON）
//   - 手写 RFC 6455 服务端（/devtools/page/<id>）：只校验 Upgrade / Sec-WebSocket-Key，
//     回 101 + 正确的 Sec-WebSocket-Accept；**不校验 Origin**（便于断言客户端没发 Origin）；
//     支持客户端 MASK 帧、分片 continuation、ping/pong、close；
//     服务端可发未 MASK 的文本帧（>125 字节用 126 / 127 扩展长度）。
//   - 最小 CDP 命令集：DOM.getDocument / DOM.describeNode / DOM.querySelector /
//     DOM.getOuterHTML / DOM.getAttributes；任意未知方法回 JSON-RPC error -32601。
//
// 导出：
//   startCdpFixture(options) → Promise<{
//     port, url, targets, calls, requests, messages, handshakes, httpRequests, close
//   }>
//
// 零依赖：只用 node: 内置模块（客户端侧可用全局 WebSocket）。

import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
const DEFAULT_TARGET_ID = 'TARGET-A'
const DEFAULT_BROWSER = 'Chrome/126.0.0.0'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const ERR_METHOD_NOT_FOUND = { code: -32601, message: 'method not found' }
const ERR_NODE_NOT_FOUND = { code: -32000, message: 'Could not find node with given id' }

function escapeHtml (value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 默认文档树：html > body > div#app.classA[data-x=1] > p + span，p 内含一个 #text 节点。 */
function buildDefaultDom () {
  const textNode = {
    nodeId: 7,
    backendNodeId: 7,
    nodeName: '#text',
    nodeType: 3,
    localName: '',
    nodeValue: 'Hello',
    attributes: [],
    childNodeCount: 0,
    children: []
  }
  const pNode = {
    nodeId: 5,
    backendNodeId: 5,
    nodeName: 'P',
    nodeType: 1,
    localName: 'p',
    nodeValue: '',
    attributes: [],
    childNodeCount: 1,
    children: [textNode]
  }
  const spanNode = {
    nodeId: 6,
    backendNodeId: 6,
    nodeName: 'SPAN',
    nodeType: 1,
    localName: 'span',
    nodeValue: '',
    attributes: [],
    childNodeCount: 0,
    children: []
  }
  const appNode = {
    nodeId: 4,
    backendNodeId: 4,
    nodeName: 'DIV',
    nodeType: 1,
    localName: 'div',
    nodeValue: '',
    attributes: ['id', 'app', 'class', 'classA', 'data-x', '1'],
    childNodeCount: 2,
    children: [pNode, spanNode]
  }
  const bodyNode = {
    nodeId: 3,
    backendNodeId: 3,
    nodeName: 'BODY',
    nodeType: 1,
    localName: 'body',
    nodeValue: '',
    attributes: [],
    childNodeCount: 1,
    children: [appNode]
  }
  const htmlNode = {
    nodeId: 2,
    backendNodeId: 2,
    nodeName: 'HTML',
    nodeType: 1,
    localName: 'html',
    nodeValue: '',
    attributes: [],
    childNodeCount: 1,
    children: [bodyNode]
  }
  return {
    nodeId: 1,
    backendNodeId: 1,
    nodeName: '#document',
    nodeType: 9,
    localName: '',
    nodeValue: '',
    attributes: [],
    childNodeCount: 1,
    children: [htmlNode]
  }
}

function nodeChildren (node) {
  return Array.isArray(node?.children) ? node.children : []
}

/** 按 nodeId 在整棵树里找节点（深度优先）。 */
function findNodeById (node, nodeId) {
  if (!node) return null
  if (node.nodeId === nodeId) return node
  for (const child of nodeChildren(node)) {
    const hit = findNodeById(child, nodeId)
    if (hit) return hit
  }
  return null
}

/** 复制一棵子树，depth = 保留的后代层数（0 = 只有自身，-1 = 全部）。 */
function subtreeWithDepth (node, depth) {
  const out = { ...node }
  const children = nodeChildren(node)
  out.childNodeCount = children.length
  if (depth === 0) {
    out.children = []
    return out
  }
  const nextDepth = depth < 0 ? -1 : depth - 1
  out.children = children.map(child => subtreeWithDepth(child, nextDepth))
  return out
}

function attributePairs (node) {
  const raw = Array.isArray(node?.attributes) ? node.attributes : []
  const pairs = []
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), String(raw[i + 1])])
  return pairs
}

function renderAttributes (node) {
  return attributePairs(node)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('')
}

/** 把节点序列化成 HTML 片段（元素带属性，文本节点转义）。 */
function serializeNode (node) {
  if (!node) return ''
  if (node.nodeType === 3) return escapeHtml(node.nodeValue || '')
  if (node.nodeType === 9) return nodeChildren(node).map(serializeNode).join('')
  const tag = String(node.localName || node.nodeName || '').toLowerCase()
  const inner = nodeChildren(node).map(serializeNode).join('')
  return `<${tag}${renderAttributes(node)}>${inner}</${tag}>`
}

/** 极简 CSS 选择器匹配：只支持 tag / #id / .class 组合（如 'div#app'、'#app'、'p'）。 */
function matchesSelector (node, selector) {
  if (!node || node.nodeType !== 1) return false
  const raw = String(selector || '').trim()
  if (!raw) return false
  if (raw.includes(' ') || raw.includes('>') || raw.includes('+') || raw.includes(':')) return false
  const tagMatch = /^([a-zA-Z][\w-]*)?/.exec(raw)
  const tag = tagMatch?.[1] || null
  if (tag && String(node.localName || node.nodeName).toLowerCase() !== tag.toLowerCase()) return false
  const pairs = attributePairs(node)
  const attrValue = (name) => {
    for (const [key, value] of pairs) if (key === name) return value
    return null
  }
  const idMatch = /#([\w-]+)/.exec(raw)
  if (idMatch && attrValue('id') !== idMatch[1]) return false
  const classNames = String(attrValue('class') || '').split(/\s+/).filter(Boolean)
  for (const classMatch of raw.matchAll(/\.([\w-]+)/g)) {
    if (!classNames.includes(classMatch[1])) return false
  }
  return true
}

function querySelector (root, selector) {
  const stack = [...nodeChildren(root)]
  while (stack.length > 0) {
    const node = stack.shift()
    if (matchesSelector(node, selector)) return node
    stack.push(...nodeChildren(node))
  }
  return null
}

/** 计算 Sec-WebSocket-Accept（RFC 6455）。 */
function computeAccept (key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 服务端 → 客户端帧（未 MASK），支持 126 / 127 扩展长度。 */
function encodeServerFrame (opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

/** 从缓冲区解出完整帧，剩余不完整字节留在 rest。 */
function parseFrames (buffer) {
  const frames = []
  let offset = 0
  while (true) {
    if (buffer.length - offset < 2) break
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let pos = offset + 2
    if (len === 126) {
      if (buffer.length - pos < 2) break
      len = buffer.readUInt16BE(pos)
      pos += 2
    } else if (len === 127) {
      if (buffer.length - pos < 8) break
      const big = buffer.readBigUInt64BE(pos)
      pos += 8
      if (big > BigInt(MAX_PAYLOAD_BYTES)) break
      len = Number(big)
    }
    let maskKey = null
    if (masked) {
      if (buffer.length - pos < 4) break
      maskKey = buffer.subarray(pos, pos + 4)
      pos += 4
    }
    if (len > MAX_PAYLOAD_BYTES) break
    if (buffer.length - pos < len) break
    const payload = Buffer.from(buffer.subarray(pos, pos + len))
    pos += len
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
    }
    frames.push({ fin, opcode, payload })
    offset = pos
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 启动假 Chromium DevTools 服务。
 *
 * @param {object} [options]
 * @param {Array<object>} [options.targets] 覆盖 /json 输出的 page target 列表；
 *   其中 webSocketDebuggerUrl 为空时由 fixture 填真实端口。
 * @param {object} [options.dom] 覆盖 DOM.getDocument 的默认文档树。
 * @returns {Promise<{port:number,url:string,targets:object[],calls:object[],requests:object[],
 *   messages:object[],handshakes:object[],httpRequests:object[],close:()=>Promise<void>}>}
 */
export async function startCdpFixture (options = {}) {
  const calls = []
  const requests = []
  const messages = []
  const handshakes = []
  const httpRequests = []
  const sockets = new Set()
  let closed = false

  const defaultDom = buildDefaultDom()
  const documentRoot = options.dom ?? defaultDom

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    httpRequests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } })
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text)
      })
      res.end(text)
    }
    if (url.pathname === '/json' || url.pathname === '/json/list') {
      send(200, buildTargetList())
      return
    }
    if (url.pathname === '/json/version') {
      send(200, {
        Browser: DEFAULT_BROWSER,
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FIXTURE`
      })
      return
    }
    send(404, { error: 'not found', path: url.pathname })
  })

  let port = 0

  function buildTargetList () {
    const source = Array.isArray(options.targets) && options.targets.length > 0
      ? options.targets
      : [{ id: DEFAULT_TARGET_ID, type: 'page', title: 'Demo Page', url: 'https://example.test/' }]
    return source.map((target) => {
      const id = String(target.id ?? DEFAULT_TARGET_ID)
      const wsPath = `/devtools/page/${id}`
      const out = { ...target }
      out.id = id
      if (!out.webSocketDebuggerUrl) out.webSocketDebuggerUrl = `ws://127.0.0.1:${port}${wsPath}`
      if (!out.devtoolsFrontendUrl) out.devtoolsFrontendUrl = `/devtools/inspector.html?ws=127.0.0.1:${port}${wsPath}`
      return out
    })
  }

  server.on('upgrade', (req, socket, head) => {
    const headers = req.headers || {}
    const upgrade = String(headers.upgrade || '').toLowerCase()
    const key = String(headers['sec-websocket-key'] || '')
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const targetId = decodeURIComponent(url.pathname.split('/').pop() || '')
    handshakes.push({
      method: req.method,
      path: url.pathname,
      targetId,
      headers: { ...headers }
    })
    if (upgrade !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const accept = computeAccept(key)
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n'))
    sockets.add(socket)
    socket.unref?.()
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))

    let buffer = Buffer.alloc(0)
    let fragments = []
    let fragmentOpcode = 0

    const sendText = (text) => {
      if (socket.destroyed) return
      socket.write(encodeServerFrame(OP_TEXT, text))
      messages.push({ direction: 'out', text: String(text) })
    }

    const dispatch = (raw) => {
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        messages.push({ direction: 'in', text: raw, parseError: true })
        return
      }
      messages.push({ direction: 'in', text: raw, message: parsed })
      if (!parsed || typeof parsed !== 'object') return
      if (parsed.id === undefined || parsed.id === null) return
      const method = typeof parsed.method === 'string' ? parsed.method : ''
      const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
      const record = { method, params }
      calls.push(record)
      requests.push(record)
      const outcome = handleCdpCommand(method, params)
      const reply = outcome.error
        ? { id: parsed.id, error: outcome.error }
        : { id: parsed.id, result: outcome.result }
      sendText(JSON.stringify(reply))
    }

    const handleFrame = (frame) => {
      const { fin, opcode, payload } = frame
      if (opcode === OP_CLOSE) {
        if (!socket.destroyed) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          socket.write(encodeServerFrame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.from([0x03, 0xe8])))
          messages.push({ direction: 'out', closeCode: code })
        }
        socket.end()
        return
      }
      if (opcode === OP_PING) {
        if (!socket.destroyed) socket.write(encodeServerFrame(OP_PONG, payload))
        return
      }
      if (opcode === OP_PONG) return
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          fragmentOpcode = opcode
          fragments = [payload]
          return
        }
        if (opcode === OP_TEXT) dispatch(payload.toString('utf8'))
        return
      }
      if (opcode === OP_CONTINUATION) {
        fragments.push(payload)
        if (!fin) return
        const merged = Buffer.concat(fragments)
        fragments = []
        if (fragmentOpcode === OP_TEXT) dispatch(merged.toString('utf8'))
      }
    }

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsedFrames = parseFrames(buffer)
      buffer = parsedFrames.rest
      for (const frame of parsedFrames.frames) handleFrame(frame)
    }

    socket.on('data', onData)
    if (head && head.length > 0) onData(head)
  })

  function handleCdpCommand (method, params) {
    switch (method) {
      case 'DOM.getDocument': {
        return { result: { root: documentRoot } }
      }
      case 'DOM.describeNode': {
        const nodeId = Number(params.nodeId)
        const found = findNodeById(documentRoot, nodeId)
        if (!found) return { error: { ...ERR_NODE_NOT_FOUND } }
        const depth = params.depth === undefined || params.depth === null ? 1 : Number(params.depth)
        return { result: { node: subtreeWithDepth(found, Number.isFinite(depth) ? depth : 1) } }
      }
      case 'DOM.querySelector': {
        const scope = params.nodeId === undefined || params.nodeId === null
          ? documentRoot
          : (findNodeById(documentRoot, Number(params.nodeId)) || documentRoot)
        const found = querySelector(scope, params.selector)
        return { result: { nodeId: found ? found.nodeId : 0 } }
      }
      case 'DOM.getOuterHTML': {
        const found = findNodeById(documentRoot, Number(params.nodeId))
        if (!found) return { error: { ...ERR_NODE_NOT_FOUND } }
        return { result: { outerHTML: serializeNode(found) } }
      }
      case 'DOM.getAttributes': {
        const found = findNodeById(documentRoot, Number(params.nodeId))
        if (!found) return { error: { ...ERR_NODE_NOT_FOUND } }
        return { result: { attributes: attributePairs(found).flat() } }
      }
      default:
        return { error: { ...ERR_METHOD_NOT_FOUND } }
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = server.address().port
  server.unref?.()

  async function close () {
    if (closed) return
    closed = true
    for (const socket of [...sockets]) {
      try {
        socket.destroy()
      } catch {}
    }
    sockets.clear()
    try {
      server.closeAllConnections?.()
    } catch {}
    await new Promise((resolve) => server.close(() => resolve()))
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    targets: buildTargetList(),
    calls,
    requests,
    callMethods: calls.map(call => call.method),
    messages,
    wsMessages: messages,
    handshakes,
    wsHandshakes: handshakes,
    httpRequests,
    close
  }
}

async function selfCheck () {
  const fixture = await startCdpFixture()
  const list = await (await fetch(`${fixture.url}/json`)).json()
  const version = await (await fetch(`${fixture.url}/json/version`)).json()
  const missing = await fetch(`${fixture.url}/nope`)
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  const replies = new Map()
  ws.addEventListener('message', (event) => {
    const parsed = JSON.parse(event.data)
    replies.set(parsed.id, parsed)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }))
  send(1, 'DOM.getDocument', {})
  send(2, 'DOM.querySelector', { selector: 'div#app' })
  send(3, 'DOM.getOuterHTML', { nodeId: 4 })
  send(4, 'DOM.getAttributes', { nodeId: 4 })
  send(5, 'DOM.nope', {})
  await new Promise((resolve) => setTimeout(resolve, 200))
  console.log('targets     :', JSON.stringify(list))
  console.log('version     :', JSON.stringify(version))
  console.log('404 status  :', missing.status)
  console.log('getDocument :', replies.get(1)?.result?.root?.nodeName)
  console.log('querySelector:', replies.get(2)?.result?.nodeId)
  console.log('outerHTML   :', replies.get(3)?.result?.outerHTML)
  console.log('attributes  :', JSON.stringify(replies.get(4)?.result?.attributes))
  console.log('unknown err :', JSON.stringify(replies.get(5)?.error))
  console.log('handshake   :', JSON.stringify(fixture.handshakes[0]?.headers))
  console.log('requests    :', JSON.stringify(fixture.requests))
  ws.close()
  await fixture.close()
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  selfCheck().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
