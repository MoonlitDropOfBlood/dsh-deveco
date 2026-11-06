/**
 * 探针：验证 ArkVM 调试器的「跳过暂停」开关与断点命中共存。
 *
 * 背景（2026-11-07 模拟器实测）：ArkVM 对**每一个新加载的脚本**都发一次
 * `Debugger.paused(reason="Break on start")`——app 因此卡在启动页，agent 要
 * resume N 次才能让它跑起来（实测 55 个脚本）。
 * `Debugger.setSkipAllPauses {skip:true}` 能把这些启动暂停全部压掉
 * （实测 scriptParsed=55 / paused=0）。
 *
 * 本探针验证两件事：
 *   ① skip=true  → app 一次跑完，所有脚本注册；
 *   ② skip=false → **断点仍然命中**（paused.reason = "break"），
 *      即「启动期跳过、调试期正常打断」这条路子成立。
 *
 *   node docs/recon-scripts/arkts-debug-probe-break.mjs --bundle com.dukedsh.remotecontrol
 *
 * 触发方式：探针停在「等断点」状态时，从外部点一下 app 界面上的按钮
 * （`devecocli ui click` / `uitest uiInput click`）。
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
const bundle = opt('bundle', 'com.dukedsh.remotecontrol')
const ability = opt('ability', 'EntryAbility')
const port = Number(opt('port', '19008'))
const holdMs = Number(opt('hold', '45000'))
const bpUrl = opt('bp-url', 'entry|entry|1.0.0|src/main/ets/pages/Index.ts')
const bpLine = Number(opt('bp-line', '296'))

const CR = String.fromCharCode(13)
const clean = (s) => `${s || ''}`.split(CR).join('')

const hdcHost = async (...a) => {
  const { stdout, stderr } = await pexec(HDC, ['-t', SERIAL, ...a], { timeout: 20000, windowsHide: true })
  return clean(stdout) + clean(stderr)
}
const shell = async (cmd) => hdcHost('shell', cmd)

const findPid = async () => {
  const raw = await shell('ps -ef')
  for (const line of raw.split('\n')) {
    if (line.includes(bundle)) {
      const pid = Number(line.trim().split(/\s+/)[1])
      if (pid > 0) return pid
    }
  }
  return 0
}

const main = async () => {
  console.log(`> aa appdebug -b ${bundle}`)
  console.log((await shell(`aa appdebug -b ${bundle}`)).trim())
  console.log((await shell(`aa force-stop ${bundle}`)).trim())
  console.log(`> aa start -b ${bundle} -a ${ability} -D`)
  console.log((await shell(`aa start -b ${bundle} -a ${ability} -D`)).trim())

  let pid = 0
  for (let i = 0; i < 20 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 300))
    pid = await findPid()
  }
  if (!pid) { console.log('!! 没拿到 pid'); process.exit(1) }
  console.log(`> pid = ${pid}`)

  const remote = `ark:${pid}@Debugger`
  console.log((await hdcHost('fport', `tcp:${port}`, remote)).trim())

  const socket = net.connect(port, '127.0.0.1')
  const key = crypto.randomBytes(16).toString('base64')
  let handshook = false
  let buf = Buffer.alloc(0)
  const scripts = new Set()
  const state = { phase: 'boot', appScriptSeen: false, bpSent: false, paused: [] }

  socket.on('connect', () => socket.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, key)))
  const send = (obj) => {
    console.log(`>> ${JSON.stringify(obj)}`)
    socket.write(encodeWsClientTextFrame(JSON.stringify(obj)))
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!handshook) {
      const head = buf.toString('utf8')
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      const headerText = head.slice(0, idx)
      console.log('<< ' + headerText.split('\r\n')[0])
      if (!/^HTTP\/1\.1 101/.test(headerText)) { socket.destroy(); return }
      handshook = true
      buf = buf.subarray(idx + 4)
      send({ id: 1, method: 'Runtime.enable', params: {} })
      send({ id: 2, method: 'Debugger.enable', params: { maxScriptsCacheSize: 100000000 } })
      send({ id: 3, method: 'Debugger.setSkipAllPauses', params: { skip: true } })
      send({ id: 4, method: 'Runtime.runIfWaitingForDebugger', params: {} })
    }
    const { texts, pings, closed, rest } = decodeWsServerFrames(buf)
    buf = rest
    for (const p of pings) socket.write(encodeWsPongFrame(p))
    for (const t of texts) {
      let msg = null
      try { msg = JSON.parse(t) } catch { /* ignore */ }
      if (!msg) continue
      if (msg.method === 'Debugger.scriptParsed') {
        const url = msg.params && msg.params.url
        if (url) {
          scripts.add(url)
          if (url.includes('src/main/ets/pages/Index.ts')) {
            state.appScriptSeen = true
            console.log(`>> app 脚本已注册：${url}`)
          }
        }
      } else if (msg.method === 'Debugger.paused') {
        const reason = (msg.params && msg.params.reason) || '?'
        const frames = (msg.params && msg.params.callFrames) || []
        const top = frames[0] || {}
        state.paused.push({ reason, url: top.url, line: ((top.location && top.location.lineNumber) || 0) + 1 })
        console.log(`<< paused reason=${reason} @ ${top.url || '?'}:${((top.location && top.location.lineNumber) || 0) + 1}`)
      } else if (msg.id !== undefined) {
        console.log(`<< reply id=${msg.id} ${JSON.stringify(msg.result || msg.error || {}).slice(0, 300)}`)
      }
    }
    if (closed) socket.end()
  })

  socket.on('error', (e) => console.log('!! socket error: ' + e.message))

  // ① 等 app 自己的脚本注册完（skip=true 时不会暂停）
  for (let i = 0; i < 60 && !state.appScriptSeen; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`\n=== 脚本注册数：${scripts.size}，app 脚本可见：${state.appScriptSeen} ===`)
  if (!state.appScriptSeen) {
    console.log('!! app 自己的脚本没注册（app 没跑起来）')
  } else {
    // ② 关掉 skip → 断点应当恢复生效
    send({ id: 5, method: 'Debugger.setSkipAllPauses', params: { skip: false } })
    await new Promise((r) => setTimeout(r, 400))
    // ③ 在 app 自己的点击处理函数上落断点
    send({
      id: 6,
      method: 'Debugger.setBreakpointByUrl',
      params: { url: bpUrl, lineNumber: bpLine, columnNumber: 0 },
    })
    state.bpSent = true
    console.log(`\n=== 断点已发：${bpUrl}:${bpLine}（0 基），现在从外部点一下界面 ===`)
  }

  await new Promise((r) => setTimeout(r, holdMs))
  try { socket.destroy() } catch { /* ignore */ }
  console.log('\n=== 结果 ===')
  console.log(`脚本总数=${scripts.size} app脚本=${state.appScriptSeen} 断点已发=${state.bpSent}`)
  console.log('全部脚本 url:')
  for (const u of scripts) console.log('   ', u)
  console.log(`暂停事件：${JSON.stringify(state.paused)}`)
  console.log('命中断点（reason=break）：' + (state.paused.some((p) => p.reason === 'break') ? '是 ✅' : '否 ❌'))
  await hdcHost('fport', 'rm', `tcp:${port}`, remote)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
