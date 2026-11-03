/**
 * ArkTS 运行时调试链路实测探针（recon 用，非产品代码）。
 *
 *   node docs/recon-scripts/arkts-debug-probe.mjs --pid 1396 [--port 19001] [--seq init|pause|eval]
 *
 * 步骤（与 DevEco Studio 一致）：
 *   hdc fport tcp:<port> ark:<pid>@Debugger
 *   → TCP 连 127.0.0.1:<port> → 裸 socket 发 6 头 WS 握手（GET /）
 *   → 收 101 → 发 Debugger.enable / Runtime.enable … → 打印所有帧
 *   → 结束时 hdc fport rm
 */
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildDevEcoWsHandshake, encodeWsClientTextFrame, decodeWsServerFrames, encodeWsPongFrame,
} from '../../harmony-device.mjs'

const pexec = promisify(execFile)

const HDC = process.env.DSH_HDC || 'D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
const SERIAL = process.env.DSH_SERIAL || '127.0.0.1:5555'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const pid = opt('pid', '')
const port = Number(opt('port', '19001'))
const seq = opt('seq', 'init')
const remote = opt('remote', '') || `ark:${pid}@Debugger`
const holdMs = Number(opt('hold', '6000'))

const hdc = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 15000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.replace(/\r/g, '')
}

const CMD = {
  init: [
    { id: 1, method: 'Runtime.enable', params: {} },
    { id: 2, method: 'Debugger.enable', params: { maxScriptsCacheSize: 100000000 } },
    { id: 3, method: 'Debugger.setBreakpointsActive', params: { active: true } },
    { id: 4, method: 'Runtime.runIfWaitingForDebugger', params: {} },
  ],
  threads: [
    { id: 1, method: 'Runtime.enable', params: {} },
    { id: 2, method: 'Debugger.enable', params: {} },
    { id: 3, method: 'Runtime.evaluate', params: { expression: '1+1' } },
    { id: 4, method: 'Debugger.setPauseOnExceptions', params: { state: 'all' } },
  ],
}

const main = async () => {
  console.log(`> hdc fport tcp:${port} ${remote}`)
  console.log((await hdc('fport', `tcp:${port}`, remote)).trim())

  const socket = net.connect(port, '127.0.0.1')
  const key = crypto.randomBytes(16).toString('base64')
  let handshook = false
  let buf = Buffer.alloc(0)
  let frameSeq = 0

  socket.on('connect', () => {
    console.log('> TCP connected, sending WS handshake')
    socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key))
  })

  const send = (obj) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj)
    console.log(`>> ${text.length > 400 ? text.slice(0, 400) + '…' : text}`)
    socket.write(encodeWsClientTextFrame(text))
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!handshook) {
      const head = buf.toString('utf8')
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      const headerText = head.slice(0, idx)
      console.log('<< ' + headerText.split('\r\n')[0])
      if (!/^HTTP\/1\.1 101/.test(headerText)) {
        console.log('!! handshake rejected:\n' + headerText)
        socket.destroy()
        return
      }
      handshook = true
      buf = buf.subarray(idx + 4)
      const cmds = CMD[seq] || CMD.init
      let i = 0
      const tick = () => {
        if (i >= cmds.length) return
        send(cmds[i++])
        setTimeout(tick, 350)
      }
      tick()
    }
    const { texts, pings, closed, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      frameSeq++
      const line = t.length > 1200 ? `${t.slice(0, 1200)}…(${t.length}B)` : t
      console.log(`<< [${frameSeq}] ${line}`)
    }
    if (closed) {
      console.log('!! server closed frame')
      socket.end()
    }
  })

  socket.on('error', (e) => console.log('!! socket error: ' + e.message))
  socket.on('close', () => console.log('!! socket closed'))

  await new Promise((r) => setTimeout(r, holdMs))
  try { socket.destroy() } catch { /* ignore */ }
  console.log(`> hdc fport rm tcp:${port} ${remote}`)
  console.log((await hdc('fport', 'rm', `tcp:${port}`, remote)).trim())
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
