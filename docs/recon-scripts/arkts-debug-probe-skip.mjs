/**
 * 探针：验证 `Debugger.setSkipAllPauses {skip:true}` 能不能压掉 ArkVM 的
 * 「Break on start」逐脚本暂停（2026-11-07 模拟器实测的粗角：每加载一个脚本
 * 就 paused 一次，agent 需要 resume N 次才能让 app 跑起来）。
 *
 *   node docs/recon-scripts/arkts-debug-probe-skip.mjs --bundle com.dukedsh.remotecontrol
 *   node docs/recon-scripts/arkts-debug-probe-skip.mjs --bundle <pkg> --no-skip   # 对照组
 *
 * 步骤：aa appdebug → aa force-stop → aa start -D → ps -ef 取 pid
 *      → hdc fport tcp:<port> ark:<pid>@Debugger → 裸 socket 6 头 WS 握手
 *      → Runtime.enable / Debugger.enable / [setSkipAllPauses] / runIfWaitingForDebugger
 *      → 打印事件统计（scriptParsed / paused 各几条、暂停原因、是否还有 paused）
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
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)
const bundle = opt('bundle', 'com.dukedsh.remotecontrol')
const port = Number(opt('port', '19007'))
const holdMs = Number(opt('hold', '9000'))
const useSkip = !has('no-skip')
const ability = opt('ability', 'EntryAbility')

const hdcHost = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 20000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.split(String.fromCharCode(13)).join('')
}

const shell = async (cmd) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, 'shell', cmd], { timeout: 20000, windowsHide: true })
  return `${stdout || ''}${stderr || ''}`.replace(/\r/g, '')
}

const findPid = async () => {
  const raw = await shell('ps -ef')
  for (const line of raw.split('\n')) {
    if (line.includes(bundle)) {
      const cols = line.trim().split(/\s+/)
      const pid = Number(cols[1])
      if (pid > 0) return pid
    }
  }
  return 0
}

const main = async () => {
  console.log(`> aa appdebug -b ${bundle}`)
  console.log((await shell(`aa appdebug -b ${bundle}`)).trim())
  console.log(`> aa force-stop ${bundle}`)
  console.log((await shell(`aa force-stop ${bundle}`)).trim())
  console.log(`> aa start -b ${bundle} -a ${ability} -D`)
  console.log((await shell(`aa start -b ${bundle} -a ${ability} -D`)).trim())

  let pid = 0
  for (let i = 0; i < 20 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 300))
    pid = await findPid()
  }
  if (!pid) {
    console.log('!! 没拿到 pid')
    process.exit(1)
  }
  console.log(`> pid = ${pid}`)

  const remote = `ark:${pid}@Debugger`
  console.log(`> hdc fport tcp:${port} ${remote}`)
  console.log((await hdcHost('fport', `tcp:${port}`, remote)).trim())

  const socket = net.connect(port, '127.0.0.1')
  const key = crypto.randomBytes(16).toString('base64')
  let handshook = false
  let buf = Buffer.alloc(0)
  const stats = { scriptParsed: 0, paused: 0, resumed: 0, reasons: {}, urls: [] }

  socket.on('connect', () => {
    socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key))
  })

  const send = (obj) => socket.write(encodeWsClientTextFrame(JSON.stringify(obj)))

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
      const cmds = [
        { id: 1, method: 'Runtime.enable', params: {} },
        { id: 2, method: 'Debugger.enable', params: { maxScriptsCacheSize: 100000000 } },
      ]
      if (useSkip) cmds.push({ id: 3, method: 'Debugger.setSkipAllPauses', params: { skip: true } })
      cmds.push({ id: 4, method: 'Runtime.runIfWaitingForDebugger', params: {} })
      let i = 0
      const tick = () => {
        if (i >= cmds.length) return
        const c = cmds[i++]
        console.log(`>> ${JSON.stringify(c)}`)
        send(c)
        setTimeout(tick, 300)
      }
      tick()
    }
    const { texts, pings, closed, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      let msg = null
      try { msg = JSON.parse(t) } catch { /* ignore */ }
      if (!msg) continue
      if (msg.method === 'Debugger.scriptParsed') {
        stats.scriptParsed++
        const url = msg.params && msg.params.url
        if (url && stats.urls.length < 60) stats.urls.push(url)
      } else if (msg.method === 'Debugger.paused') {
        stats.paused++
        const reason = (msg.params && msg.params.reason) || '?'
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1
        const frames = (msg.params && msg.params.callFrames) || []
        const top = frames[0] || {}
        console.log(`<< paused reason=${reason} @ ${top.url || '?'}:${((top.location && top.location.lineNumber) || 0) + 1}`)
      } else if (msg.method === 'Debugger.resumed') {
        stats.resumed++
      } else if (msg.id !== undefined) {
        console.log(`<< reply id=${msg.id} ${JSON.stringify(msg.result || msg.error || {}).slice(0, 200)}`)
      }
    }
    if (closed) socket.end()
  })

  socket.on('error', (e) => console.log('!! socket error: ' + e.message))

  await new Promise((r) => setTimeout(r, holdMs))
  try { socket.destroy() } catch { /* ignore */ }
  console.log('\n=== 统计 ===')
  console.log(`skip=${useSkip} scriptParsed=${stats.scriptParsed} paused=${stats.paused} resumed=${stats.resumed}`)
  console.log('暂停原因分布:', JSON.stringify(stats.reasons))
  console.log('脚本 url（前 20）:')
  for (const u of stats.urls.slice(0, 20)) console.log('  ', u)
  console.log(`> hdc fport rm tcp:${port} ${remote}`)
  await hdcHost('fport', 'rm', `tcp:${port}`, remote)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
