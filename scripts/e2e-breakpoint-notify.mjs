// dsh-deveco — 断点通知链路端到端探针（**不依赖设备**，用假 ArkVM 调试服务端）。
//
//   node scripts/e2e-breakpoint-notify.mjs
//
// 目的：把「app 停在断点 → 通知 agent」这条链路在没有真机/模拟器时也跑通一遍：
//
//   假 ArkVM（TCP + 裸 socket 6 头 WS 握手 + CDP 风格 JSON-RPC）
//     → 插件真正的 ArktsDebuggerSession（握手/协议/事件解析全部真代码）
//     → 真正的 harmony_debug 工具（buildHarmonyAgentTools，stub defineTool）
//     → 真正的 Host 投递（_notifyDebugAgent：idle→followup / running→inject）
//     → 假的 agent（只记录 followup/inject）
//
// 覆盖：
//   1. attach：入口暂停由工具结果内联回报，**不推送**通知
//   2. set_breakpoint 后假 ArkVM 推送「断点命中」→ agent 收到通知（followup）
//   3. action=pause 自己触发的暂停 → 内联回报，**不推送**
//   4. action=notify enabled=false → 暂停不再推送；enabled=true → 恢复推送
//
// 退出码 0 = 全部通过。

import net from 'node:net'
import crypto from 'node:crypto'
import { buildHarmonyAgentTools } from '../harmony-agent-tools.mjs'
import { decodeWsServerFrames } from '../harmony-device.mjs'
import { HarmonyDevEcoService } from '../index.js'

const SCRIPT_URL = 'entry|com.example.app|1.0.0|src/main/ets/pages/Index.ets'
const SCRIPT_ID = '7'
const BUNDLE = 'com.example.app'
const PID = 4321

const results = []
function check (name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Server → client text frame (unmasked). */
function encodeServerTextFrame (text) {
  const payload = Buffer.from(String(text), 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

/** The fake ArkVM debugger endpoint. */
class FakeArkVm {
  constructor () {
    this.socket = null
    this.server = null
    this.onScriptParsed = null
    this.onEntryPause = null
    this.onBreakpointHit = null
  }

  async listen (port) {
    this.server = net.createServer((socket) => {
      this.socket = socket
      let buf = Buffer.alloc(0)
      let handshaked = false
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (!handshaked) {
          const idx = buf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const head = buf.subarray(0, idx).toString('utf8')
          buf = buf.subarray(idx + 4)
          const key = /sec-websocket-key:\s*(.+)/i.exec(head)?.[1]?.trim() || ''
          const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64')
          socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '', '',
          ].join('\r\n'))
          handshaked = true
        }
        const decoded = decodeWsServerFrames(buf)
        buf = decoded.rest
        for (const text of decoded.texts) this.onMessage(text)
      })
      socket.on('error', () => {})
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', resolve)
    })
  }

  send (obj) {
    if (this.socket) this.socket.write(encodeServerTextFrame(JSON.stringify(obj)))
  }

  /** Push a Debugger.paused event. */
  pause ({ reason, hitBreakpoints = [], url = SCRIPT_URL, lineNumber = 41, functionName = 'onPageShow' }) {
    this.send({
      method: 'Debugger.paused',
      params: {
        reason,
        hitBreakpoints,
        callFrames: [
          { callFrameId: '1', functionName, url, location: { scriptId: SCRIPT_ID, lineNumber, columnNumber: 0 } },
          { callFrameId: '2', functionName: 'build', url, location: { scriptId: SCRIPT_ID, lineNumber: 12, columnNumber: 0 } },
        ],
      },
    })
  }

  onMessage (text) {
    let msg
    try { msg = JSON.parse(text) } catch (_) { return }
    if (msg.id === undefined) return
    const method = msg.method
    let result = {}
    if (method === 'Debugger.enable') {
      result = { protocols: ['getPossibleAndSetBreakpointByUrl'] }
    } else if (method === 'Debugger.getPossibleAndSetBreakpointByUrl' || method === 'Debugger.setBreakpointByUrl') {
      const url = msg.params?.locations?.[0]?.url || msg.params?.url || SCRIPT_URL
      const lineNumber = msg.params?.locations?.[0]?.lineNumber ?? msg.params?.lineNumber ?? 41
      result = {
        breakpointId: `id:${lineNumber}:0:${url}`,
        locations: [{ url, lineNumber, columnNumber: 0, scriptId: SCRIPT_ID }],
      }
    }
    this.send({ id: msg.id, result })
    if (method === 'Debugger.setSkipAllPauses') {
      // 真机行为：skip=true 时不再逐脚本发「Break on start」（模拟器实测 55 脚本 0 暂停）
      this.skipPauses = msg.params?.skip === true
      result = {}
    }
    if (method === 'Runtime.runIfWaitingForDebugger') {
      // 脚本注册 + 入口暂停（Break on start）
      this.send({ method: 'Debugger.scriptParsed', params: { scriptId: SCRIPT_ID, url: SCRIPT_URL } })
      if (!this.skipPauses) {
        setTimeout(() => this.pause({ reason: 'Break on start', lineNumber: 0, functionName: 'build' }), 10)
        // 真机实测：ArkVM 对**每个加载的模块**都会再发一次 "Break on start"
        // （这里模拟库模块的初始化暂停）——属于噪音，不应通知 agent。
        setTimeout(() => this.pause({ reason: 'Break on start', lineNumber: 8, functionName: 'func_main_0' }), 180)
      }
    }
    if (method === 'Debugger.pause') {
      setTimeout(() => this.pause({ reason: 'pause', lineNumber: 41 }), 10)
    }
    if (method === 'Debugger.getPossibleAndSetBreakpointByUrl' || method === 'Debugger.setBreakpointByUrl') {
      // 应用跑起来后命中了断点
      setTimeout(() => {
        this.pause({ reason: 'break', hitBreakpoints: [`id:41:0:${SCRIPT_URL}`], lineNumber: 41 })
      }, 30)
    }
  }

  async close () {
    if (this.socket) this.socket.destroy()
    if (this.server) await new Promise((resolve) => this.server.close(resolve))
  }
}

const fakeArkVm = new FakeArkVm()

const host = {
  sessions: new Map(),
  async hdc (argv) {
    // fport tcp:<port> ark:<pid>@Debugger → 在插件挑中的那个端口上起假 ArkVM
    if (Array.isArray(argv) && argv[0] === 'fport' && String(argv[1] || '').startsWith('tcp:')) {
      const port = Number(String(argv[1]).slice(4))
      await fakeArkVm.listen(port)
    }
    return { ok: true, stdout: 'success', stderr: '' }
  },
  async shell (command) {
    if (String(command).includes('bm dump')) {
      return {
        ok: true,
        stdout: `${BUNDLE}:\n{"applicationInfo":{"appProvisionType":"debug","bundleName":"${BUNDLE}"},"hapModuleInfos":[{"moduleName":"entry","mainElementName":"EntryAbility"}]}`,
        stderr: '',
      }
    }
    if (String(command).includes('ps -ef')) {
      return {
        ok: true,
        stdout: `USER PID PPID VSZ RSS WCHAN ADDR S NAME\nroot ${PID} 1 100 100 0 0 S ${BUNDLE}\n`,
        stderr: '',
      }
    }
    return { ok: true, stdout: '', stderr: '' }
  },
  notifyAgent: async (payload) => service._notifyDebugAgent(payload),
  noteAgentActivity: (owner) => service._noteDebugAgentActivity(owner),
}

const agent = {
  id: 'session-e2e',
  status: 'idle',
  inbox: [],
  followup (message) { agent.inbox.push({ kind: 'followup', message }) },
  inject (message) { agent.inbox.push({ kind: 'inject', message }) },
}

// 真正的 Host 投递（index.js 的 _notifyDebugAgent）：只替换 Cordis ctx。
const service = Object.create(HarmonyDevEcoService.prototype)
service._ctx = {
  get: (name) => (name === 'agents' ? { get: (id) => (id === agent.id ? agent : undefined) } : undefined),
}
service._debugWakeCounts = new Map()

const defineTool = (spec) => spec
const tools = new Map(buildHarmonyAgentTools({ defineTool, host }).map((t) => [t.name, t]))
const tool = tools.get('harmony_debug')
const exec = { agent, signal: new AbortController().signal }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const notices = () => agent.inbox.filter((entry) => entry.kind === 'followup' || entry.kind === 'inject')

const main = async () => {
  // ---- 1. attach（默认 skip_pauses=true）：app 直接跑起来，不产生启动暂停 ----
  const attached = await tool.execute({ action: 'attach', package_name: BUNDLE, pid: String(PID) }, exec)
  check('attach 建立会话', attached.ok === true, attached.message)
  check('attach 默认跳过启动暂停（app 一次跑完）', attached.data && attached.data.skipPauses === true, `skipPauses=${attached.data && attached.data.skipPauses}`)
  await sleep(320)
  check('跳过暂停时没有启动暂停，也就不推送通知', notices().length === 0, `notices=${notices().length}`)

  // ---- 1b. attach(skip_pauses=false)：保留逐脚本暂停，入口暂停内联回报不推送 ----
  await tool.execute({ action: 'detach' }, exec).catch(() => {})
  agent.inbox.length = 0
  const attached2 = await tool.execute(
    { action: 'attach', package_name: BUNDLE, pid: String(PID), skip_pauses: false },
    exec,
  )
  check('attach(skip_pauses=false) 建立会话', attached2.ok === true, attached2.message)
  check(
    '入口暂停由工具结果内联回报',
    attached2.data && attached2.data.paused && attached2.data.paused.reason === 'Break on start',
    attached2.data && attached2.data.paused ? attached2.data.paused.reason : 'none',
  )
  await sleep(320)
  check('入口暂停 + 库模块初始化暂停都不推送通知', notices().length === 0, `notices=${notices().length}`)

  // ---- 2. set_breakpoint → 断点命中 → 通知 agent ----
  const bp = await tool.execute({ action: 'set_breakpoint', url: SCRIPT_URL, line: 41 }, exec)
  check('set_breakpoint 成功', bp.ok === true, bp.message)
  await sleep(300)
  const hits = notices()
  check('断点命中推送了通知', hits.length === 1, `notices=${hits.length}`)
  if (hits.length === 1) {
    const message = hits[0].message
    const text = message.content.map((block) => block.text || '').join('\n')
    check('通知经 followup 投递（agent 空闲 → 唤醒新一轮）', hits[0].kind === 'followup', hits[0].kind)
    check('通知是 user 角色 + 自定义 source', message.role === 'user' && message.source.kind === 'dsh-deveco-debug', message.source.kind)
    check('通知含暂停位置', /Index\.ets:42/.test(text), message.source.summary)
    check('通知含调用栈', /#0 onPageShow @ entry\|com\.example\.app\|1\.0\.0\|src\/main\/ets\/pages\/Index\.ets:42/.test(text))
    check('通知含下一步指引', /action=stack/.test(text) && /action=resume/.test(text))
  }
  const delivered = agent.inbox.filter((entry) => entry.kind === 'followup' || entry.kind === 'inject')
  check('通知投递到了 agent 的收件箱', delivered.length >= 1, `delivered=${delivered.length}`)
  // ---- 3. action=pause：自己触发的暂停内联回报，不推送 ----
  const before = notices().length
  const paused = await tool.execute({ action: 'pause' }, exec)
  check('pause 内联回报暂停', paused.ok === true, paused.message)
  await sleep(200)
  check('自己触发的暂停不推送通知', notices().length === before, `notices=${notices().length} (before=${before})`)

  // ---- 4. notify 开关 ----
  const off = await tool.execute({ action: 'notify', enabled: false }, exec)
  check('notify(enabled=false) 生效', off.ok === true, off.message)
  fakeArkVm.pause({ reason: 'break', hitBreakpoints: [`id:41:0:${SCRIPT_URL}`], lineNumber: 41 })
  await sleep(200)
  check('关闭后不再推送通知', notices().length === before, `notices=${notices().length} (before=${before})`)

  const on = await tool.execute({ action: 'notify', enabled: true }, exec)
  check('notify(enabled=true) 生效', on.ok === true, on.message)
  fakeArkVm.pause({ reason: 'break', hitBreakpoints: [`id:41:0:${SCRIPT_URL}`], lineNumber: 41 })
  await sleep(200)
  check('重新开启后恢复推送', notices().length === before + 1, `notices=${notices().length} (before=${before})`)

  await tool.execute({ action: 'detach' }, exec).catch(() => {})
  await fakeArkVm.close()
}

main()
  .catch((error) => {
    check('探针执行', false, error && error.message ? error.message : String(error))
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    process.exit(failed.length === 0 ? 0 : 1)
  })
