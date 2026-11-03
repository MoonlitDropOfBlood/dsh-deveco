// dsh-deveco — Agent tool surface end-to-end probe (real device, no DSH).
//
// Runs the exact tool definitions from harmony-agent-tools.mjs with a stub
// `defineTool` (the tool spec object IS the tool) and a real hdc transport, so
// command construction, parsing and debugger sessions are exercised against a
// connected emulator/device.
//
// Only `harmony_debug` is probed here: logs and app management are devecocli's
// job (`devecocli log` / `devecocli device app`), so this plugin does not
// re-implement them.
//
//   node scripts/e2e-agent-tools.mjs --device 127.0.0.1:5555 --bundle io.duke.myapplication [--attach]
//
// Exit code 0 = every requested step passed.

import { execFile } from 'node:child_process'
import { buildHarmonyAgentTools } from '../harmony-agent-tools.mjs'

const HDC_FALLBACK = 'D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc'
const hdcPath = process.env.DSH_DEVECO_HDC || HDC_FALLBACK

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const device = arg('device', '')
const bundle = arg('bundle', '')
const wantAttach = process.argv.includes('--attach')

function hdc (argv, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(hdcPath, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ ok: false, stdout: String(stdout || ''), stderr: String(stderr || ''), error: { code: 'hdc-timeout', message: 'timeout' } })
        return
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

const host = {
  sessions: new Map(),
  hdc,
  shell: (command, dev, timeout) => hdc([...(dev ? ['-t', dev] : []), 'shell', command], timeout),
}

const defineTool = (spec) => spec
const tools = new Map(buildHarmonyAgentTools({ defineTool, host }).map((t) => [t.name, t]))

function step (name) {
  console.log(`\n== ${name}`)
}

async function run (label, fn) {
  try {
    const value = await fn()
    console.log(`✔ ${label}`)
    console.log(JSON.stringify(value, null, 1).slice(0, 4000))
    return { ok: true, value }
  } catch (error) {
    console.log(`✖ ${label}: ${error && error.message ? error.message : error}`)
    return { ok: false, error }
  }
}

const results = []

if (wantAttach && bundle) {
  step('harmony_debug attach (wait-for-debugger launch)')
  const attached = await run('attach launch=true', () => tools.get('harmony_debug').execute({
    device, action: 'attach', package_name: bundle, launch: true,
  }))
  results.push(attached)
  if (attached.ok) {
    const pid = attached.value.pid
    results.push(await run('status', () => tools.get('harmony_debug').execute({ device, action: 'status', pid: String(pid) })))
    step('harmony_debug scripts')
    const scripts = await run('scripts', () => tools.get('harmony_debug').execute({ device, action: 'scripts', pid: String(pid), limit: 40 }))
    results.push(scripts)
    step('harmony_debug breakpoint on first .ets script')
    const first = scripts.ok && scripts.value.data && Array.isArray(scripts.value.data.scripts)
      ? scripts.value.data.scripts.find((s) => /\.ets$/.test(s.url)) || scripts.value.data.scripts[0]
      : null
    if (first) {
      results.push(await run('set_breakpoint ' + first.url, () => tools.get('harmony_debug').execute({
        device, action: 'set_breakpoint', pid: String(pid), url: first.url, line: 5,
      })))
    }
    results.push(await run('stack', () => tools.get('harmony_debug').execute({ device, action: 'stack', pid: String(pid) })))
    results.push(await run('evaluate 1+1 (only meaningful while paused)', () => tools.get('harmony_debug').execute({
      device, action: 'evaluate', pid: String(pid), expression: '1+1',
    })))
    results.push(await run('resume', () => tools.get('harmony_debug').execute({ device, action: 'resume', pid: String(pid) })))
    await new Promise((r) => setTimeout(r, 800))
    results.push(await run('status after resume', () => tools.get('harmony_debug').execute({ device, action: 'status', pid: String(pid) })))
    results.push(await run('detach', () => tools.get('harmony_debug').execute({ device, action: 'detach', pid: String(pid) })))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 ? 0 : 1)
