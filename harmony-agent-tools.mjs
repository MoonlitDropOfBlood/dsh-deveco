/**
 * dsh-deveco — Agent-facing HarmonyOS tool definitions (Host half).
 *
 * One tool: `harmony_debug` — the **ArkTS runtime debugger** (attach,
 * breakpoints, pause/resume/step, stack, evaluate, properties). Nothing here
 * duplicates what `devecocli` already does well:
 *
 *   logs          → `devecocli log [--level] [--keyword] [--bundle-name] [--tail] [--format json]`
 *   app list/info → `devecocli device app list|info|start|stop|install|uninstall`
 *   UI tree       → `harmony_ui_tree` (this plugin) / `devecocli ui layout`
 *
 * The builder receives a tiny `host` port so `index.js` owns process spawning
 * while every command string, parser and session state machine stays here and
 * unit-testable:
 *
 *   host.hdc(argv, timeoutMs)                → { ok, stdout, stderr, error? }
 *   host.shell(command, device, timeoutMs)   → { ok, stdout, stderr, error? }
 *   host.sessions                            → Map<number, ArktsDebuggerSession>
 */

import {
  buildBundleInfoCommand,
  parseBundleInfo,
  buildStartAbilityCommand,
  buildForceStopCommand,
  buildAppDebugCommand,
  buildProcessListCommand,
  isBundleName,
} from './harmony-tools.mjs'
import { parseProcessPids } from './harmony-device.mjs'
import {
  ArktsDebuggerSession,
  buildDebuggerForwardArgs,
  buildDebuggerForwardRemoveArgs,
  pickFreePort,
  formatCallFrameLines,
  summarizeCallFrames,
} from './harmony-debugger.mjs'

/** Errors thrown by tools become `isError` text; keep messages actionable. */
function fail (message) {
  const error = new Error(message)
  error.toolFailure = true
  return error
}

/** @returns {string[]} serials from `hdc list targets` (empty on failure). */
async function listTargets (host) {
  const r = await host.hdc(['list', 'targets'], 12000)
  if (!r.ok) return []
  return String(r.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\[Empty\]/i.test(line))
}

/** Resolve the target serial: explicit argument, else the only connected one. */
async function resolveDevice (host, requested) {
  if (typeof requested === 'string' && requested) return requested
  const targets = await listTargets(host)
  if (targets.length === 1) return targets[0]
  if (targets.length === 0) throw fail('没有已连接的设备：先连接真机 / 启动模拟器（设置页设备管理可看目标），再重试。')
  throw fail(`检测到多台设备（${targets.join(', ')}），请用 device 参数指定序列号。`)
}

/** Running pids of one bundle from `ps -ef` (main process + `:suffix` children). */
async function runningPids (host, device, bundle) {
  const r = await host.shell(buildProcessListCommand(), device, 15000)
  if (!r.ok) throw fail(`读取进程列表失败：${(r.error && r.error.message) || r.stdout || 'hdc 失败'}`)
  const pids = parseProcessPids(String(r.stdout || ''), bundle)
  return Array.isArray(pids) ? pids.map(Number).filter((n) => Number.isFinite(n)) : []
}

/**
 * Debug-signature probe: `bm dump -n` must report `appProvisionType: "debug"`
 * (DevEco's own `DebugClient` checks this plus the ALLOW_DEBUG permission).
 * Returns `{ debuggable, provisionType, raw }`; an unreadable dump is unknown.
 */
async function debugSignature (host, device, bundle) {
  const built = buildBundleInfoCommand(bundle)
  if (!built.ok) throw fail(built.error)
  const r = await host.shell(built.command, device, 20000)
  if (!r.ok) return { debuggable: null, provisionType: '', raw: '' }
  const parsed = parseBundleInfo(String(r.stdout || ''))
  const info = parsed.json && parsed.json.applicationInfo ? parsed.json.applicationInfo : {}
  const provisionType = typeof info.appProvisionType === 'string' ? info.appProvisionType : ''
  return {
    debuggable: provisionType ? provisionType === 'debug' : null,
    provisionType,
    mainAbility: parsed.mainAbility,
    abilities: parsed.abilities,
  }
}

function textOf (r) {
  return (r && (r.stdout || r.stderr)) || ''
}

const DEBUG_ACTIONS = [
  'attach', 'status', 'scripts', 'set_breakpoint', 'remove_breakpoint', 'breakpoints',
  'pause', 'resume', 'step', 'run', 'stack', 'evaluate', 'properties', 'exceptions',
  'events', 'detach',
]

/** Pick the session named by pid, or the only live one. */
function sessionFor (host, pid) {
  const sessions = host.sessions
  if (Number.isFinite(Number(pid)) && sessions.has(Number(pid))) return sessions.get(Number(pid))
  if (sessions.size === 1) return [...sessions.values()][0]
  if (sessions.size === 0) throw fail('没有活动的调试会话：先调用 action=attach（建议带 package_name 与 launch=true）。')
  throw fail(`有 ${sessions.size} 个会话（pid ${[...sessions.keys()].join(', ')}）：请用 pid 指定。`)
}

function debugResult (action, session, extra = {}) {
  return {
    action,
    ok: true,
    message: extra.message || '',
    pid: session ? session.pid : 0,
    port: session ? session.port : 0,
    bundleName: session ? session.bundleName || '' : '',
    device: session ? session.device || '' : '',
    data: extra.data === undefined ? {} : extra.data,
  }
}

/** Poll `ps -ef` until the bundle shows a pid (wait-debugger launch is async). */
async function waitForPid (host, device, bundle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await runningPids(host, device, bundle).catch(() => [])
    if (last.length > 0) return last
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return last
}

async function attachSession (host, args) {
  const device = await resolveDevice(host, args.device)
  const bundle = typeof args.package_name === 'string' ? args.package_name.trim() : ''
  if (bundle && !isBundleName(bundle)) throw fail('package_name 必须是合法包名（如 com.example.app）')
  let pid = Number.isFinite(Number(args.pid)) && Number(args.pid) > 0 ? Math.floor(Number(args.pid)) : 0
  let bundleName = bundle
  let launchNote = ''

  if (bundle && (args.launch === true || pid === 0)) {
    const info = await debugSignature(host, device, bundle)
    if (info.debuggable === false) {
      throw fail(`应用 ${bundle} 不是调试签名（appProvisionType=${info.provisionType || '未知'}）：ArkTS 调试器只接受 debug 签名应用。请用 debug 模式重新构建安装（DevEco 调试运行；装了 DevEco CLI 时也可 devecocli build/run）。`)
    }
    const ability = (typeof args.ability === 'string' && args.ability.trim())
      || info.mainAbility
      || ''
    if (!ability) throw fail('无法从 bm dump 解析 mainAbility：请传 ability 参数（如 EntryAbility）')
    // wait-for-debugger launch: the only flow verified to produce a live
    // debugger instance (entry pause + scriptParsed); attach-to-running yields
    // an empty session on this runtime.
    const mark = buildAppDebugCommand(bundle)
    if (!mark.ok) throw fail(mark.error)
    const markReply = await host.shell(mark.command, device, 20000)
    launchNote = textOf(markReply).trim()
    const stopped = buildForceStopCommand(bundle)
    if (!stopped.ok) throw fail(stopped.error)
    await host.shell(stopped.command, device, 20000)
    const started = buildStartAbilityCommand({ bundle, ability, module: args.module, debug: args.debug !== false })
    if (!started.ok) throw fail(started.error)
    const startReply = await host.shell(started.command, device, 20000)
    if (!startReply.ok) throw fail(`启动失败：${textOf(startReply).slice(0, 600)}`)
    const pids = await waitForPid(host, device, bundle, 8000)
    if (pids.length === 0) throw fail(`应用 ${bundle} 启动后没有进程：检查 ability 名是否正确（aa start 回包：${textOf(startReply).slice(0, 300)}）`)
    pid = pids[0]
    bundleName = bundle
  } else if (bundle && pid === 0) {
    const pids = await runningPids(host, device, bundle)
    if (pids.length === 0) throw fail(`包 ${bundle} 未运行：用 launch=true（会 aa appdebug + 启动），或先启动它（devecocli device app start / hdc shell aa start）。`)
    pid = pids[0]
    bundleName = bundle
  }

  if (!pid) throw fail('attach 需要 package_name 或 pid')
  const existing = host.sessions.get(pid)
  if (existing) {
    return { session: existing, reused: true, launchNote }
  }

  // Debug signature check for a pid-only attach (bundle from /proc cmdline).
  if (!bundleName) {
    const ps = await host.shell('ps -ef', device, 15000)
    if (ps.ok) {
      for (const line of String(ps.stdout || '').split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length >= 8 && Number(cols[1]) === pid) {
          const candidate = cols[cols.length - 1].split(':')[0]
          if (isBundleName(candidate)) bundleName = candidate
          break
        }
      }
    }
  }
  if (bundleName) {
    const info = await debugSignature(host, device, bundleName)
    if (info.debuggable === false) {
      throw fail(`应用 ${bundleName} 不是调试签名（appProvisionType=${info.provisionType || '未知'}）：ArkTS 调试器只接受 debug 签名应用。`)
    }
  }

  const forwardFail = /\[Fail\]/i
  let port = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await pickFreePort()
    const forwarded = await host.hdc(buildDebuggerForwardArgs(port, pid), 20000)
    if (!forwarded.ok) {
      throw fail(`hdc fport 失败：${textOf(forwarded).slice(0, 600)}（检查 pid 是否仍存活、hdc 是否可用）`)
    }
    // `[Fail]TCP Port listen failed at <p>` means the local port was taken
    // (stale rule / another session): retry on a fresh port instead of
    // connecting into whatever owns that port.
    if (!forwardFail.test(textOf(forwarded))) break
    await host.hdc(buildDebuggerForwardRemoveArgs(port, pid), 8000).catch(() => {})
    port = 0
  }
  if (!port) throw fail('无法分配可用的本地端口用于 hdc fport：多次 `TCP Port listen failed`，请检查是否有残留的 fport 规则（hdc fport ls）。')

  const session = new ArktsDebuggerSession({ pid, port, bundleName, device })
  try {
    await session.connect(6000)
    const ini = await session.init({ runIfWaiting: args.run_if_waiting !== false })
    if (!ini.ok) throw new Error((ini.error && ini.error.message) || 'Debugger.enable 失败')
    await session.waitForEntry(2500)
  } catch (error) {
    session.close()
    await host.hdc(buildDebuggerForwardRemoveArgs(port, pid), 15000).catch(() => {})
    throw fail(`${error && error.message ? error.message : String(error)}（提示：同一 ark 目标同一时刻只允许一个调试客户端，DevEco 调试会话开着时会连接不上）`)
  }
  host.sessions.set(pid, session)
  const scripts = [...session.scripts.entries()].map(([url, scriptId]) => ({ url, scriptId }))
  const warning = []
  if (scripts.length === 0 && !session.paused) {
    warning.push('空会话：已连接并放行等待调试器的应用，但未收到 scriptParsed / paused。该 ArkVM 只在 wait-for-debugger 启动瞬间注册调试实例——请用 launch=true 重启应用后再 attach，或从 DevEco 的调试启动流程进入。')
  }
  return {
    session,
    reused: false,
    launchNote,
    warning: warning.join(' '),
    data: {
      protocols: session.protocols,
      scriptCount: scripts.length,
      scripts: scripts.slice(0, 40),
      paused: session.paused
        ? {
            reason: session.paused.reason,
            frames: session.paused.frames,
            stackLines: formatCallFrameLines(session.paused.frames),
          }
        : null,
    },
  }
}

function buildHarmonyDebugTool (defineTool, host) {
  return defineTool({
    name: 'harmony_debug',
    description: [
      'Debug a running ArkTS app on a HarmonyOS device with the ArkVM remote debugger — the channel DevEco Studio itself uses (hdc fport ark:<pid>@Debugger + a CDP-style JSON-RPC session).',
      'Actions: attach (with launch=true it performs the verified wait-for-debugger flow: aa appdebug -b → aa force-stop → aa start -D → fport → handshake; without launch it attaches to a running pid), status/scripts (loaded script URLs to set breakpoints on), set_breakpoint/remove_breakpoint/breakpoints, pause/resume, step (over/into/out), stack (frames of the last Debugger.paused), evaluate (Debugger.evaluateOnCallFrame — Runtime.evaluate is unsupported by this runtime and the call must happen while paused), properties (Runtime.getProperties on a scope/object id), exceptions (setPauseOnExceptions none|uncaught|all), events (recent protocol events), detach.',
      'Breakpoint URLs must equal the scriptParsed.url exactly (e.g. entry|hrouter|2.0.0|src/main/ets/...); lines are 0-based. Errors are returned inside result.code/message by the runtime, so a successful call means no code member. Only one debugger client per pid is allowed: an IDE debug session blocks attach, and attaching to an app that was not started with wait-for-debugger often yields an empty session (no scriptParsed/paused) — the tool reports that explicitly instead of pretending the session works.',
      'This tool is only for the ArkTS runtime debugger. Device logs: devecocli log (--level/--keyword/--bundle-name/--tail/--format json) when DevEco CLI is installed, otherwise hdc shell hilog. App management: devecocli device app (list/info/start/stop/install/uninstall) or hdc/bm/aa shell commands. The UI tree is available through the harmony_ui_tree tool.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: DEBUG_ACTIONS, required: true, description: 'Debugger operation.' },
      device: { type: 'string', description: 'Device/emulator serial. Omit when exactly one target is connected.' },
      package_name: { type: 'string', description: 'Bundle name to attach to (attach).' },
      pid: { type: 'string', description: 'Process id to attach to, or the session to target. Omit to use the only session.' },
      launch: { type: 'boolean', description: 'attach only: relaunch the app in wait-for-debugger mode first (recommended; verified to produce a live debugger instance).' },
      run_if_waiting: { type: 'boolean', description: 'attach: after Debugger.enable send Runtime.runIfWaitingForDebugger (default true). That message is what releases an app waiting for a debugger and makes the runtime report its scripts and entry pause; set false only to inspect a session before releasing it.' },
      ability: { type: 'string', description: 'attach/launch: ability to start (defaults to bm dump mainElementName).' },
      module: { type: 'string', description: 'attach/launch: module name (aa start -m).' },
      debug: { type: 'boolean', description: 'attach/launch: start with aa start -D (default true).' },
      url: { type: 'string', description: 'set_breakpoint/remove_breakpoint: exact scriptParsed url.' },
      line: { type: 'integer', description: 'set_breakpoint: 0-based line number.' },
      column: { type: 'integer', description: 'set_breakpoint: 0-based column (default 0).' },
      condition: { type: 'string', description: 'set_breakpoint: conditional expression.' },
      breakpoint_id: { type: 'string', description: 'remove_breakpoint: breakpoint id returned by set_breakpoint.' },
      expression: { type: 'string', description: 'evaluate: expression to run on the paused frame.' },
      frame: { type: 'integer', description: 'evaluate: call-frame index (default 0 = innermost).' },
      object_id: { type: 'string', description: 'properties: remote object id (from scopeChain / evaluate result).' },
      state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'exceptions: pause-on-exception state.' },
      step: { type: 'string', enum: ['over', 'into', 'out'], description: 'step: which step command.' },
      limit: { type: 'integer', description: 'events/scripts: maximum rows to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          pid: { type: 'integer', required: true },
          port: { type: 'integer', required: true },
          bundleName: { type: 'string', required: true },
          device: { type: 'string', required: true },
          data: { type: 'json', required: true },
        },
      },
      render (args, value) {
        const head = `harmony_debug ${value.action} · pid ${value.pid || '-'} · ${value.bundleName || ''} ${value.device ? '· ' + value.device : ''}`
        const lines = [head]
        if (value.message) lines.push(value.message)
        const data = value.data || {}
        if (Array.isArray(data.stackLines) && data.stackLines.length) lines.push(...data.stackLines)
        if (Array.isArray(data.scripts)) {
          lines.push(`脚本 ${data.scriptCount} 个：`)
          lines.push(...data.scripts.slice(0, 40).map((s) => `  [${s.scriptId}] ${s.url}`))
        }
        if (Array.isArray(data.breakpoints) && data.breakpoints.length) {
          lines.push('断点：')
          lines.push(...data.breakpoints.map((b) => `  ${b.url}:${(b.line || 0) + 1} ${b.condition ? 'if ' + b.condition : ''} (${b.breakpointId})`))
        }
        if (Array.isArray(data.events) && data.events.length) {
          lines.push(...data.events.slice(-(args.limit || 20)).map((e) => `  ${e.method}`))
        }
        if (data.result !== undefined) lines.push(JSON.stringify(data.result, null, 1))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute (args) {
      const action = String(args.action || '')
      if (action === 'attach') {
        const attached = await attachSession(host, args)
        const data = attached.reused
          ? { reused: true, protocols: attached.session.protocols }
          : attached.data
        return debugResult('attach', attached.session, {
          message: [
            attached.reused ? '复用已有会话' : '已连接 ArkTS 调试器',
            attached.launchNote ? `（launch: ${attached.launchNote}）` : '',
            attached.warning || '',
          ].filter(Boolean).join(' '),
          data,
        })
      }
      if (action === 'detach') {
        const session = sessionFor(host, args.pid)
        session.close()
        host.sessions.delete(session.pid)
        const removed = await host.hdc(buildDebuggerForwardRemoveArgs(session.port, session.pid), 15000)
        return debugResult('detach', session, {
          message: `已断开（fport 清理${removed.ok ? '成功' : '失败'}）。注意：调试模式启动的应用在调试器断开后可能被系统结束。`,
          data: { forwardRemoved: removed.ok },
        })
      }
      const session = sessionFor(host, args.pid)
      if (action === 'status') {
        return debugResult('status', session, {
          message: session.paused ? `已暂停（${session.paused.reason || 'break'}）` : '运行中',
          data: {
            protocols: session.protocols,
            scripts: [...session.scripts.keys()].length,
            paused: session.paused ? { reason: session.paused.reason, frames: session.paused.frames } : null,
            breakpoints: session.breakpoints,
            closed: session.closed,
          },
        })
      }
      if (action === 'scripts') {
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000))
        const scripts = [...session.scripts.entries()].map(([url, scriptId]) => ({ url, scriptId }))
        const filtered = typeof args.url === 'string' && args.url
          ? scripts.filter((s) => s.url.includes(args.url))
          : scripts
        return debugResult('scripts', session, {
          message: `${filtered.length} 个脚本${filtered.length !== scripts.length ? `（共 ${scripts.length}）` : ''}`,
          data: { scriptCount: scripts.length, scripts: filtered.slice(0, limit) },
        })
      }
      if (action === 'set_breakpoint') {
        const reply = await session.setBreakpoint({ url: args.url, line: args.line, column: args.column, condition: args.condition })
        if (!reply.ok) throw fail(`设置断点失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        const anyInvalid = Array.isArray(reply.value.locations) && reply.value.locations.some((l) => l.id === 'invalid')
        return debugResult('set_breakpoint', session, {
          message: anyInvalid
            ? '断点已记录，但该 url 当前没有已加载脚本可落点（id:"invalid"）——确认 url 与 scriptParsed.url 完全一致，或等脚本加载后再试。'
            : '断点已设置',
          data: { breakpointId: reply.value.breakpointId, locations: reply.value.locations, breakpoints: session.breakpoints },
        })
      }
      if (action === 'remove_breakpoint') {
        const reply = await session.removeBreakpoint({ breakpointId: args.breakpoint_id, url: args.url })
        if (!reply.ok) throw fail(`删除断点失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('remove_breakpoint', session, { message: '断点已删除', data: { breakpoints: session.breakpoints } })
      }
      if (action === 'breakpoints') {
        return debugResult('breakpoints', session, {
          message: `${session.breakpoints.length} 个断点`,
          data: { breakpoints: session.breakpoints },
        })
      }
      if (action === 'pause') {
        const pending = session.waitEvent('Debugger.paused', null, 6000).then((params) => params, () => null)
        const reply = await session.pause()
        if (!reply.ok) throw fail(`pause 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        const paused = await pending
        return debugResult('pause', session, {
          message: paused ? `已暂停：${session.paused ? session.paused.reason : ''}` : 'pause 已受理，但 6s 内没有 Debugger.paused（空闲 JS 线程无检查点；触发一次交互或改用断点）',
          data: { paused: session.paused ? { reason: session.paused.reason, frames: session.paused.frames } : null },
        })
      }
      if (action === 'resume') {
        const reply = await session.resume()
        if (!reply.ok) throw fail(`resume 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        // The runtime may not emit Debugger.resumed for an entry pause, so
        // clear the local pause state ourselves — otherwise `stack` would keep
        // reporting the stale frames.
        await new Promise((resolve) => setTimeout(resolve, 200))
        session.paused = null
        return debugResult('resume', session, { message: '已继续运行' })
      }
      if (action === 'step') {
        const kind = ['over', 'into', 'out'].includes(args.step) ? args.step : 'over'
        const reply = await session.step(kind)
        if (!reply.ok) throw fail(`step 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('step', session, {
          message: `已执行 step ${kind}`,
          data: { paused: session.paused ? { reason: session.paused.reason, frames: session.paused.frames } : null },
        })
      }
      if (action === 'run') {
        const reply = await session.runIfWaiting()
        if (!reply.ok) throw fail(`runIfWaitingForDebugger 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('run', session, { message: '已放行等待调试器的应用' })
      }
      if (action === 'stack') {
        if (!session.paused) {
          return debugResult('stack', session, { message: '当前未暂停：先触发断点 / step / pause，再读取调用栈。', data: {} })
        }
        const frames = session.paused.frames
        return debugResult('stack', session, {
          message: `暂停原因：${session.paused.reason || 'unknown'}${session.paused.hitBreakpoints && session.paused.hitBreakpoints.length ? ` · 命中：${session.paused.hitBreakpoints.join(', ')}` : ''}`,
          data: { reason: session.paused.reason, frames, stackLines: formatCallFrameLines(frames) },
        })
      }
      if (action === 'evaluate') {
        if (typeof args.expression !== 'string' || !args.expression.trim()) throw fail('evaluate 需要 expression 参数')
        const reply = await session.evaluate(args.expression, Number(args.frame) || 0)
        if (!reply.ok) throw fail(`求值失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('evaluate', session, { message: '求值完成', data: { result: reply.value } })
      }
      if (action === 'properties') {
        if (typeof args.object_id !== 'string' || !args.object_id) throw fail('properties 需要 object_id 参数（scopeChain 或求值结果里的 objectId）')
        const reply = await session.properties(args.object_id)
        if (!reply.ok) throw fail(`getProperties 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('properties', session, { message: '对象属性已读取', data: { result: reply.value } })
      }
      if (action === 'exceptions') {
        const reply = await session.setPauseOnExceptions(args.state)
        if (!reply.ok) throw fail(`setPauseOnExceptions 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        const state = ['none', 'uncaught', 'all'].includes(args.state) ? args.state : 'none'
        return debugResult('exceptions', session, { message: `异常暂停：${state}` })
      }
      if (action === 'events') {
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200))
        return debugResult('events', session, {
          message: `${session.events.length} 条事件（显示最近 ${Math.min(limit, session.events.length)}）`,
          data: { events: session.events.slice(-limit) },
        })
      }
      throw fail(`未知 action：${action}`)
    },
    isConcurrencySafe () { return false },
  })
}

/**
 * Build every agent tool. `host` supplies hdc execution and the session map.
 * @param {{ defineTool: Function, host: object }} api
 */
export function buildHarmonyAgentTools ({ defineTool, host }) {
  return [buildHarmonyDebugTool(defineTool, host)]
}
