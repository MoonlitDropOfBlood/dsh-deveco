/**
 * ArkTS 运行时调试链路实测探针 #2：完整 CDP 方法探测器（recon 用，非产品代码）。
 *
 *   node docs/recon-scripts/arkts-debug-probe2.mjs --pid <pid> [--port 19031]
 *
 * 流程：fport tcp:<p> ark:<pid>@Debugger → 裸 socket 6 头 WS 握手 →
 *   Runtime.enable / Debugger.enable → 收 scriptParsed → 在第一个 .ets 脚本上设断点
 *   → evaluateOnCallFrame / getScriptSource / Runtime.evaluate / getProperties
 *   → resume / pause / stepOver / stepInto / stepOut / setPauseOnExceptions
 *   → 试错探针：setBreakpointByUrl（标准 CDP 名，预期不支持）、removeBreakpointsByUrl
 * 结束时 fport rm。所有收发原样打印（前缀 >> 发送 / << 接收）。
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
const port = Number(opt('port', '19031'))
const remote = `ark:${pid}@Debugger`
const hdc = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 20000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.replace(/\r/g, '').trim()
}

let nextId = 1
const pending = new Map()
const scripts = new Map()      // scriptId -> url
const frames = []              // 关键事件摘要

const main = async () => {
  console.log(`> ${await hdc('fport', `tcp:${port}`, remote)}`)
  const socket = net.connect(port, '127.0.0.1')
  let buf = Buffer.alloc(0)
  let handshook = false
  const key = crypto.randomBytes(16).toString('base64')

  const write = (obj) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj)
    console.log(`>> ${text.length > 600 ? text.slice(0, 600) + '…' : text}`)
    socket.write(encodeWsClientTextFrame(text))
  }
  const call = (method, params = {}, waitMs = 1500) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    write({ id, method, params })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }) } }, waitMs)
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  socket.on('connect', () => socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key)))
  socket.on('error', (e) => console.log('!! ' + e.message))

  let onResolve
  const resolved = new Promise((r) => { onResolve = r })

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!handshook) {
      const head = buf.toString('utf8')
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      console.log('<< ' + head.slice(0, idx).split('\r\n')[0])
      handshook = true
      buf = buf.subarray(idx + 4)
      onResolve()
    }
    const { texts, pings, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      let msg
      try { msg = JSON.parse(t) } catch { console.log('<< (non-json) ' + t.slice(0, 300)); continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        console.log(`<< #${msg.id} ${JSON.stringify(msg).slice(0, 700)}`)
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
        continue
      }
      if (msg.method === 'Debugger.scriptParsed') {
        const p = msg.params
        scripts.set(String(p.scriptId), p.url)
        if (scripts.size <= 12 || /\.ets$/.test(p.url)) {
          console.log(`<< scriptParsed scriptId=${p.scriptId} url=${p.url} lang=${p.scriptLanguage || '-'} execCtx=${p.executionContextId}`)
        }
        continue
      }
      console.log(`<< EVENT ${msg.method} ${JSON.stringify(msg.params).slice(0, 900)}`)
      frames.push(msg.method)
    }
  })

  await resolved
  await sleep(800)

  const log = (s) => console.log(`--- ${s}`)

  log('enable')
  await call('Runtime.enable')
  await call('Debugger.enable')

  // 等一会，让 scriptParsed 全部到齐
  await sleep(1200)
  log(`scripts=${scripts.size}`)

  const ets = [...scripts.entries()].filter(([, u]) => /\.ets$/.test(u)).slice(0, 3)
  const first = ets[0] || [...scripts.entries()][0]
  log(`pick script ${first ? first[0] + ' ' + first[1] : '(none)'}`)

  if (first) {
    const [sid, url] = first
    log('getScriptSource')
    const src = await call('Debugger.getScriptSource', { scriptId: sid }, 3000)
    if (src.result) console.log(`   scriptSource len=${(src.result.scriptSource || '').length} head=${JSON.stringify((src.result.scriptSource || '').slice(0, 120))}`)

    log('getPossibleAndSetBreakpointByUrl (panda 专有)')
    const bp = await call('Debugger.getPossibleAndSetBreakpointByUrl', {
      locations: [{ scriptId: sid, lineNumber: 10, columnNumber: 0 }],
    })
    console.log('   => ' + JSON.stringify(bp).slice(0, 800))

    log('setBreakpointByUrl (标准 CDP 名，用于确认不支持)')
    const std = await call('Debugger.setBreakpointByUrl', { lineNumber: 10, url }, 1200)
    console.log('   => ' + JSON.stringify(std).slice(0, 400))

    log('removeBreakpointsByUrl')
    console.log('   => ' + JSON.stringify(await call('Debugger.removeBreakpointsByUrl', { url }, 1500)).slice(0, 400))
  }

  log('setPauseOnExceptions')
  console.log('   => ' + JSON.stringify(await call('Debugger.setPauseOnExceptions', { state: 'all' })))

  log('runtime evaluate')
  console.log('   => ' + JSON.stringify(await call('Runtime.evaluate', { expression: '1+1' }, 2000)).slice(0, 600))

  log('resume')
  console.log('   => ' + JSON.stringify(await call('Debugger.resume')))
  await sleep(1500)
  log('pause')
  console.log('   => ' + JSON.stringify(await call('Debugger.pause', {}, 2500)).slice(0, 500))
  await sleep(600)

  log('stepOver + stepInto + stepOut')
  console.log('   => stepOver ' + JSON.stringify(await call('Debugger.stepOver', {}, 2000)).slice(0, 200))
  await sleep(400)
  console.log('   => stepInto ' + JSON.stringify(await call('Debugger.stepInto', {}, 2000)).slice(0, 200))
  await sleep(400)
  console.log('   => stepOut  ' + JSON.stringify(await call('Debugger.stepOut', {}, 2000)).slice(0, 200))

  log('getStackTrace')
  console.log('   => ' + JSON.stringify(await call('Debugger.getStackTrace', { stackTraceId: { id: '0' } }, 1500)).slice(0, 400))

  log('Runtime.getProperties on last objectId')
  console.log('   => ' + JSON.stringify(await call('Runtime.getProperties', { objectId: '0' }, 1500)).slice(0, 500))

  log('resume & close')
  await call('Debugger.resume')
  await sleep(300)
  try { socket.destroy() } catch { /* */ }
  console.log(`> ${await hdc('fport', 'rm', `tcp:${port}`, remote)}`)
  console.log('EVENTS seen: ' + JSON.stringify([...new Set(frames)]))
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
