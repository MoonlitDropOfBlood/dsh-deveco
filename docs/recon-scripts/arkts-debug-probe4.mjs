/**
 * ArkTS 调试探针 #4：断点参数形态探测 + 空闲态 pause（recon 用）。
 *   node docs/recon-scripts/arkts-debug-probe4.mjs --pid <pid> [--port 19071]
 * 试错 getPossibleAndSetBreakpointByUrl / saveAllPossibleBreakpoints 的参数形状，
 * 并观察 setBreakpointByUrl 后触发 UI 点击能否命中（Debugger.paused）。
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
const port = Number(opt('port', '19071'))
const remote = `ark:${pid}@Debugger`
const hdc = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 20000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.replace(/\r/g, '').trim()
}

let nextId = 1
const pending = new Map()
const scripts = new Map()

const main = async () => {
  console.log(`> ${await hdc('fport', `tcp:${port}`, remote)}`)
  const socket = net.connect(port, '127.0.0.1')
  let buf = Buffer.alloc(0)
  let handshook = false
  const key = crypto.randomBytes(16).toString('base64')
  const call = (method, params = {}, waitMs = 2000) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    const text = JSON.stringify({ id, method, params })
    console.log(`>> ${text.length > 400 ? text.slice(0, 400) + '…' : text}`)
    socket.write(encodeWsClientTextFrame(text))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }) } }, waitMs)
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let pausedSeen = 0
  socket.on('connect', () => socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key)))
  socket.on('error', (e) => console.log('!! ' + e.message))
  let onHs
  const hs = new Promise((r) => { onHs = r })
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!handshook) {
      const head = buf.toString('utf8')
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      console.log('<< ' + head.slice(0, idx).split('\r\n')[0])
      handshook = true
      buf = buf.subarray(idx + 4)
      onHs()
    }
    const { texts, pings, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      let m
      try { m = JSON.parse(t) } catch { continue }
      if (m.id !== undefined && pending.has(m.id)) {
        console.log(`<< #${m.id} ${JSON.stringify(m).slice(0, 400)}`)
        pending.get(m.id)(m); pending.delete(m.id)
      } else if (m.method === 'Debugger.scriptParsed') {
        scripts.set(String(m.params.scriptId), m.params.url)
      } else if (m.method === 'Debugger.paused') {
        pausedSeen++
        console.log(`<< EVENT Debugger.paused reason=${m.params.reason} hit=${JSON.stringify(m.params.hitBreakpoints)} top=${m.params.callFrames[0].url}:${m.params.callFrames[0].location.lineNumber}`)
      } else {
        console.log(`<< EVENT ${m.method} ${JSON.stringify(m.params).slice(0, 300)}`)
      }
    }
  })
  await hs
  await call('Runtime.enable')
  console.log('--- Debugger.enable'); await call('Debugger.enable')
  await sleep(600)
  console.log(`scripts=${scripts.size}`)

  const urls = [...new Set(scripts.values())]
  const guess = urls[0] || 'entry|entry|1.0.0|src/main/ets/pages/Index.ets'
  console.log('--- breakpoint param shapes on url=' + guess)
  await call('Debugger.getPossibleAndSetBreakpointByUrl', { locations: [{ url: guess, lineNumber: 20, columnNumber: 0 }] })
  await call('Debugger.getPossibleAndSetBreakpointByUrl', { locations: [{ scriptId: '0', breakPointLineNumber: 20, lineNumber: 20, columnNumber: 0 }] })
  await call('Debugger.getPossibleAndSetBreakpointByUrl', { url: guess, lineNumber: 20, columnNumber: 0 })
  await call('Debugger.saveAllPossibleBreakpoints', { locations: { [guess]: [{ lineNumber: 20, columnNumber: 0 }] } })
  await call('Debugger.saveAllPossibleBreakpoints', { [guess]: [{ lineNumber: 20, columnNumber: 0 }] })
  await call('Debugger.setBreakpointByUrl', { url: guess, lineNumber: 20, columnNumber: 0 })
  await call('Debugger.setBreakpointByUrl', { urlRegex: '.*Index\\.ets', lineNumber: 20 })
  await call('Debugger.setBreakpointByUrl', { lineNumber: 20, url: guess, condition: '1===1' })

  console.log('--- 触发 UI 交互后看是否命中断点')
  console.log('   (hdc shell uitest uiInput click 500 1000)')
  console.log((await hdc('shell', 'uitest uiInput click 500 1000')).slice(0, 120))
  await sleep(3000)
  console.log('--- 再 pause 一次')
  await call('Debugger.pause', {}, 2500)
  await sleep(2000)
  console.log(`pausedSeen=${pausedSeen}`)
  try { socket.destroy() } catch { /* */ }
  console.log(`> ${await hdc('fport', 'rm', `tcp:${port}`, remote)}`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
