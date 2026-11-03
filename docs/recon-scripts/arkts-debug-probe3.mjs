/**
 * ArkTS 运行时调试链路实测探针 #3：真实会话（暂停态能力 + 断点命中）（recon 用）。
 *
 *   node docs/recon-scripts/arkts-debug-probe3.mjs --pid <pid> [--port 19041] [--pkg io.duke.myapplication]
 *
 * 顺序：fport ark:<pid>@Debugger → WS 握手 → Runtime.enable/Debugger.enable →
 *   收到首个 Debugger.paused（reason="Break on start"）时批量探测暂停态方法：
 *   evaluateOnCallFrame / getProperties / setBreakpointByUrl / getPossibleAndSetBreakpointByUrl
 *   / getScriptSource / setBreakpointsActive / setSkipAllPauses → resume →
 *   等断点命中（Debugger.paused + hitBreakpoints）→ stepOver/stepInto → resume → 断开。
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
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const pid = opt('pid', '')
const port = Number(opt('port', '19041'))
const remote = `ark:${pid}@Debugger`
const hdc = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 20000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.replace(/\r/g, '').trim()
}

let nextId = 1
const pending = new Map()
const scripts = new Map()
const callLog = []

const main = async () => {
  console.log(`> ${await hdc('fport', `tcp:${port}`, remote)}`)
  const socket = net.connect(port, '127.0.0.1')
  let buf = Buffer.alloc(0)
  let handshook = false
  const key = crypto.randomBytes(16).toString('base64')

  const write = (obj) => {
    const text = JSON.stringify(obj)
    socket.write(encodeWsClientTextFrame(text))
  }
  const call = (method, params = {}, waitMs = 1500) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    write({ id, method, params })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }) } }, waitMs)
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const show = (tag, obj) => {
    const s = JSON.stringify(obj)
    console.log(`   ${tag}: ${s.length > 500 ? s.slice(0, 500) + '…' : s}`)
  }
  socket.on('connect', () => socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key)))
  socket.on('error', (e) => console.log('!! ' + e.message))

  let onHandshake
  const handshakeDone = new Promise((r) => { onHandshake = r })

  let pausedCount = 0
  let onPaused = null
  const waitPaused = (ms = 8000) => new Promise((resolve) => {
    onPaused = resolve
    setTimeout(() => { if (onPaused === resolve) onPaused = null; resolve(null) }, ms)
  })

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!handshook) {
      const head = buf.toString('utf8')
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      console.log('<< ' + head.slice(0, idx).split('\r\n')[0])
      handshook = true
      buf = buf.subarray(idx + 4)
      onHandshake()
    }
    const { texts, pings, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      let msg
      try { msg = JSON.parse(t) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const r = JSON.stringify(msg).slice(0, 400)
        callLog.push(`#${msg.id} ${r}`)
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
        continue
      }
      if (msg.method === 'Debugger.scriptParsed') {
        scripts.set(String(msg.params.scriptId), msg.params.url)
        continue
      }
      if (msg.method === 'Debugger.paused') {
        pausedCount++
        const p = msg.params
        console.log(`<< EVENT Debugger.paused #${pausedCount} reason=${p.reason} hitBreakpoints=${JSON.stringify(p.hitBreakpoints)} frames=${p.callFrames.length}`)
        console.log(`   top frame: ${p.callFrames[0].functionName} @ ${p.callFrames[0].url} line=${p.callFrames[0].location.lineNumber} col=${p.callFrames[0].location.columnNumber} callFrameId=${p.callFrames[0].callFrameId}`)
        if (onPaused) { const f = onPaused; onPaused = null; f(p) }
        continue
      }
      if (msg.method !== 'Debugger.scriptParsed') {
        console.log(`<< EVENT ${msg.method} ${JSON.stringify(msg.params).slice(0, 400)}`)
      }
    }
  })

  await handshakeDone
  console.log('--- Runtime.enable'); show('#', await call('Runtime.enable'))
  console.log('--- Debugger.enable'); show('#', await call('Debugger.enable'))

  const startPause = await waitPaused(8000)
  if (!startPause) { console.log('!! no initial paused event'); }

  // 暂停态能力探测（startPause 的 callFrames[0]）
  if (startPause) {
    const cf = startPause.callFrames[0]
    const url = cf.url
    console.log('--- evaluateOnCallFrame'); show('#', await call('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: '1+1' }, 3000))
    console.log('--- evaluateOnCallFrame (member)'); show('#', await call('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: 'globalThis' }, 3000))
    console.log('--- getScriptSource'); show('#', await call('Debugger.getScriptSource', { scriptId: cf.location.scriptId }, 3000))
    if (cf.scopeChain && cf.scopeChain[0] && cf.scopeChain[0].object) {
      console.log('--- Runtime.getProperties(local)'); show('#', await call('Runtime.getProperties', { objectId: cf.scopeChain[0].object.objectId }, 2000))
    }
    console.log('--- setBreakpointByUrl(url, line 12)'); const bp = await call('Debugger.setBreakpointByUrl', { url, lineNumber: 12, columnNumber: 0 }, 2500); show('#', bp)
    console.log('--- getPossibleAndSetBreakpointByUrl(locations[{url,lineNumber}])'); show('#', await call('Debugger.getPossibleAndSetBreakpointByUrl', { locations: [{ url, lineNumber: 12, columnNumber: 0 }] }, 2500))
    console.log('--- setBreakpointsActive(false/true)'); show('#', await call('Debugger.setBreakpointsActive', { active: false })); show('#', await call('Debugger.setBreakpointsActive', { active: true }))
    console.log('--- setSkipAllPauses'); show('#', await call('Debugger.setSkipAllPauses', { skip: false }))
    console.log('--- resume'); show('#', await call('Debugger.resume'))
    console.log('--- stepOver(不在暂停态，预期报错)'); show('#', await call('Debugger.stepOver'))
  }

  await sleep(2500)
  console.log(`--- scripts=${scripts.size}`)
  console.log('   url samples: ' + JSON.stringify([...new Set(scripts.values())].slice(0, 8), null, 0))

  // 让应用跑一会儿再 pause，看能否暂停（UI 线程空闲场景）
  console.log('--- pause (app running)'); show('#', await call('Debugger.pause', {}, 3000))
  const p2 = await waitPaused(6000)
  if (p2) {
    console.log('--- resume'); show('#', await call('Debugger.resume'))
  } else {
    console.log('!! pause 未产生 paused 事件（UI 线程空闲时可能无法暂停）')
  }

  try { socket.destroy() } catch { /* */ }
  console.log(`> ${await hdc('fport', 'rm', `tcp:${port}`, remote)}`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
