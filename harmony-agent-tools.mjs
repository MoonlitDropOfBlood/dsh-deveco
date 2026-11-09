/**
 * dsh-deveco — Agent-facing HarmonyOS tool definitions (Host half).
 *
 * Two tools: `harmony_project` — the read-only HarmonyOS project model, and
 * `harmony_debug` — the **ArkTS runtime debugger** (source/compiled breakpoints,
 * pause/resume/step, source-mapped stack, evaluate, properties). Nothing here
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
  formatPauseNotification,
  isStartupPause,
  STARTUP_PAUSE_REASONS,
  summarizeCallFrames,
  describePauseReason,
} from './harmony-debugger.mjs'
import { inspectHarmonyProject } from './harmony-project.mjs'
import { assertSourceBreakpointFresh, loadHarmonySourceMapIndex } from './harmony-source-map.mjs'

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

/** Current agent workspace, falling back to the Host/e2e working directory. */
function agentWorkspace (exec, host) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : ''
  return cwd || (host && host.cwd) || process.cwd()
}

function mappedFrames (session, frames = session.paused && session.paused.frames) {
  return session.sourceMaps ? session.sourceMaps.mapFrames(frames) : (Array.isArray(frames) ? frames : [])
}

function pausedData (session) {
  if (!session.paused) return null
  const frames = mappedFrames(session)
  return {
    reason: describePauseReason(session.paused),
    rawReason: session.paused.reason,
    hitBreakpoints: session.paused.hitBreakpoints || [],
    frames,
    stackLines: formatCallFrameLines(frames),
  }
}

function sourceMapData (session) {
  if (!session.sourceMaps) return session.sourceMapWarning ? { warning: session.sourceMapWarning } : null
  return {
    projectRoot: session.sourceMaps.projectRoot,
    buildMode: session.sourceMaps.buildMode,
    scriptCount: session.sourceMaps.scriptCount,
    mapFileCount: session.sourceMaps.records.length,
    warnings: session.sourceMaps.warnings.slice(-4),
  }
}

/** Load/reload the project's maps; discovery is optional until source mode is used. */
async function configureSessionSourceMaps (session, host, args, exec, required = false) {
  const input = args.project_path || session.projectRoot || agentWorkspace(exec, host)
  try {
    const index = await loadHarmonySourceMapIndex(input, { buildMode: args.build_mode || session.sourceMaps?.buildMode || 'debug' })
    session.sourceMaps = index
    session.projectRoot = index.projectRoot
    session.sourceMapWarning = index.scriptCount === 0
      ? '工程存在，但没有可用 Source Map；先执行 debug 构建/运行后再使用源码断点。'
      : ''
    return index
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    session.sourceMapWarning = (required || args.project_path || session.projectRoot) ? message : ''
    if (required || args.project_path) throw fail(`Source Map 初始化失败：${message}`)
    return null
  }
}

const DEBUG_ACTIONS = [
  'attach', 'status', 'scripts', 'set_breakpoint', 'remove_breakpoint', 'breakpoints',
  'pause', 'resume', 'step', 'run', 'stack', 'evaluate', 'properties', 'exceptions',
  'events', 'notify', 'skip_pauses', 'detach',
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

/**
 * Bind the calling agent to the session so later pauses can reach it.
 *
 * The Agent is the live runtime face (`ctx.agents` entry) — its id is the
 * Session id, which is how the Host resolves the agent again when the pause
 * arrives outside any tool call.
 *
 * @param {object} session
 * @param {object} [exec] tool run context (`exec.agent`)
 * @param {object} [host] optional host port (`host.noteAgentActivity`)
 * @returns {object|null} the bound agent
 */
function claimOwner (session, exec, host) {
  const agent = exec && exec.agent ? exec.agent : null
  if (!agent) return null
  session.ownerAgent = agent
  session.ownerSessionId = String(agent.id || '')
  // The agent used the debugger again: it reacted, so it may be woken again.
  if (host && typeof host.noteAgentActivity === 'function') {
    try { host.noteAgentActivity(agent) } catch (_) { /* best effort */ }
  }
  return agent
}

/**
 * Push one pause notification to the owning agent.
 *
 * The app can stop for reasons the agent never asked for (a breakpoint hit, an
 * exception pause). Without this the agent would have to poll `action=status`
 * to notice the stop. Pauses the tool already reports inline (attach entry
 * pause, explicit `pause`, `step`) are suppressed by the session's expected
 * -pause counter, so the agent never gets the same stop twice.
 *
 * Exported for the self-test (the delivery contract is unit-tested with a
 * fake host and a real session).
 *
 * @param {object} session
 * @param {object} host
 */
export function installPauseNotifier (session, host) {
  if (session.pauseNotifierInstalled) return
  session.pauseNotifierInstalled = true
  session.on('Debugger.paused', () => {
    const reason = session.paused && typeof session.paused.reason === 'string' ? session.paused.reason : ''
    if (session.consumeExpectedPause(reason)) return
    // Module-initialization pauses ("Break on start") are startup noise: the
    // first one is reported inline by attach, the rest belong to library
    // loading, not to the agent's breakpoint.
    if (isStartupPause(reason)) return
    // A pause a tool result already carried must not be pushed a second time.
    if (session.paused && session.paused.reportedInline === true) return
    if (session.notifyEnabled === false) return
    const owner = session.ownerAgent
    if (!owner) return
    if (typeof host.notifyAgent !== 'function') return
    const notice = formatPauseNotification({
      bundleName: session.bundleName,
      pid: session.pid,
      device: session.device,
      paused: session.paused ? { ...session.paused, frames: mappedFrames(session) } : session.paused,
    })
    try {
      const result = host.notifyAgent({ agent: owner, text: notice.text, summary: notice.summary })
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch (_) { /* a failed notice must never break the debugger */ }
  })
}

async function attachSession (host, args, exec) {
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
    claimOwner(existing, exec, host)
    installPauseNotifier(existing, host)
    if (args.notify === false) existing.notifyEnabled = false
    if (args.project_path || !existing.sourceMaps) await configureSessionSourceMaps(existing, host, args, exec)
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

  const anyForwardFail = /\[Fail\]/i
  const portListenFail = /\[Fail\]\s*TCP Port listen failed\b/i
  let port = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await pickFreePort()
    const forwarded = await host.hdc(buildDebuggerForwardArgs(port, pid, device), 20000)
    const output = [forwarded.stdout, forwarded.stderr].filter(Boolean).join('\n').trim()
    if (!forwarded.ok) {
      const detail = output || (forwarded.error && forwarded.error.message) || '未知错误'
      throw fail(`hdc fport 失败：${detail.slice(0, 600)}（检查 pid 是否仍存活、hdc 是否可用）`)
    }
    if (!anyForwardFail.test(output)) break
    // Only this exact failure means the local port was taken (stale rule /
    // another session). Other [Fail] responses (bad device, missing ark
    // target, ...) are deterministic errors: preserve them and do not retry.
    if (!portListenFail.test(output)) {
      throw fail(`hdc fport 失败：${output.slice(0, 600)}`)
    }
    await host.hdc(buildDebuggerForwardRemoveArgs(port, pid, device), 8000).catch(() => {})
    port = 0
  }
  if (!port) throw fail('无法分配可用的本地端口用于 hdc fport：多次 `TCP Port listen failed`，请检查是否有残留的 fport 规则（hdc fport ls）。')

  const session = new ArktsDebuggerSession({ pid, port, bundleName, device })
  // The entry pause ("Break on start") is reported inline by this attach
  // result, so it must not also be pushed to the agent. The expectation is
  // scoped to the startup reasons and deliberately NOT cleared below: the
  // runtime may emit the entry pause *after* waitForEntry returned (it
  // returns as soon as the first script is parsed), and the ArkVM emits one
  // "Break on start" per loaded module.
  session.noteExpectedPause(15000, { reasons: STARTUP_PAUSE_REASONS })
  try {
    // Optional for legacy URL breakpoints; explicit project_path errors still
    // pass through the same catch so the just-created hdc forward is removed.
    await configureSessionSourceMaps(session, host, args, exec)
    await session.connect(6000)
    // 启动期默认跳过 ArkVM 的「每脚本一次 Break on start」暂停——否则 app
    // 会卡在启动页（实测 55 个脚本 = 55 次 resume，agent 根本没法调试）。
    // agent 传 skip_pauses=false 可以保留逐脚本暂停（调试启动流程时用）。
    const ini = await session.init({
      runIfWaiting: args.run_if_waiting !== false,
      skipPauses: args.skip_pauses !== false,
    })
    if (!ini.ok) throw new Error((ini.error && ini.error.message) || 'Debugger.enable 失败')
    // 跳过暂停时没有入口暂停，但 scriptParsed 会照常到达——waitForEntry 两者都等。
    await session.waitForEntry(2500)
  } catch (error) {
    session.close()
    await host.hdc(buildDebuggerForwardRemoveArgs(port, pid, device), 15000).catch(() => {})
    throw fail(`${error && error.message ? error.message : String(error)}（提示：同一 ark 目标同一时刻只允许一个调试客户端，DevEco 调试会话开着时会连接不上）`)
  }
  // This attach result carries the current pause inline.
  session.markPauseReportedInline()
  if (args.notify === false) session.notifyEnabled = false
  claimOwner(session, exec, host)
  installPauseNotifier(session, host)
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
      skipPauses: session.skipPauses,
      scriptCount: scripts.length,
      scripts: scripts.slice(0, 40),
      paused: pausedData(session),
      sourceMaps: sourceMapData(session),
    },
  }
}

function buildHarmonyProjectTool (defineTool, host) {
  return defineTool({
    name: 'harmony_project',
    description: 'Inspect a HarmonyOS application as a structured DevEco-style project model. Reads build-profile.json5, AppScope/app.json5, module.json5 and oh-package.json5, then returns the app identity, products/build modes, modules/targets, abilities, permissions, page routes, dependencies, built HAP/HSP/HAR/APP artifacts, and available ArkTS Source Maps. Pass any file/directory inside the project; omitted path uses the current agent workspace. Signing output contains only configuration names and completeness, never certificates, key aliases or passwords. Read-only.',
    parameters: {
      path: { type: 'string', description: 'Project root or any file/directory inside it. Omit to use the current session workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          project: { type: 'json', required: true },
        },
      },
      render (args, value) {
        const p = value.project
        const lines = [
          `${p.name || p.root}${p.bundleName ? ` · ${p.bundleName}` : ''}`,
          `根目录：${p.root}`,
          `版本：${p.versionName || '-'} (${p.versionCode || 0}) · 模型：${p.modelVersion || '-'} · 默认：${p.defaultProduct}/${p.defaultBuildMode}`,
        ]
        if (p.products.length) lines.push(`Products：${p.products.map((item) => `${item.name}[${item.targetSdkVersion || '-'}]`).join(', ')}`)
        lines.push(`模块 ${p.modules.length} 个：`)
        for (const module of p.modules) {
          const details = [module.type || 'unknown', `${module.abilities.length} abilities`, `${module.requestPermissions.length} permissions`]
          if (module.mainElement) details.push(`main=${module.mainElement}`)
          if (module.deviceTypes.length) details.push(module.deviceTypes.join('/'))
          lines.push(`- ${module.name}：${details.join(' · ')}`)
          lines.push(`  ${module.path}`)
          if (module.pages.length) lines.push(`  页面：${module.pages.join(', ')}`)
          const maps = module.sourceMaps.reduce((sum, item) => Math.max(sum, item.scriptCount || 0), 0)
          lines.push(`  构建产物 ${module.artifacts.length} · Source Map ${module.sourceMaps.length} 份${maps ? `（${maps} 脚本）` : ''}`)
        }
        if (p.warnings.length) lines.push(`警告：${p.warnings.join('；')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute (args, exec) {
      try {
        return { ok: true, project: await inspectHarmonyProject(args.path || agentWorkspace(exec, host)) }
      } catch (error) {
        throw fail(error && error.message ? error.message : String(error))
      }
    },
    isConcurrencySafe () { return true },
  })
}

function buildHarmonyDebugTool (defineTool, host) {
  return defineTool({
    name: 'harmony_debug',
    description: [
      'Debug a running ArkTS app on a HarmonyOS device with the ArkVM remote debugger — the channel DevEco Studio itself uses (hdc fport ark:<pid>@Debugger + a CDP-style JSON-RPC session).',
      'Actions: attach (with launch=true it performs the verified wait-for-debugger flow: aa appdebug -b → aa force-stop → aa start -D → fport → handshake; without launch it attaches to a running pid), status/scripts (loaded script URLs), set_breakpoint/remove_breakpoint/breakpoints, pause/resume, step (over/into/out), stack (frames of the last Debugger.paused), evaluate (Debugger.evaluateOnCallFrame — Runtime.evaluate is unsupported and requires a paused frame), properties, exceptions, events, notify, skip_pauses, detach. Prefer SOURCE breakpoints: set source_path (.ets absolute/project-relative path) + source_line (1-based), optionally project_path/build_mode; the tool uses Hvigor Source Maps to choose the exact ArkVM URL and generated line, rejects stale maps, and maps stack frames/notifications back to .ets. The legacy url + line (0-based) form sets a COMPILED .ts breakpoint directly.',
      'Breakpoint URLs must equal the scriptParsed.url exactly (e.g. entry|hrouter|2.0.0|src/main/ets/...); lines are 0-based. Errors are returned inside result.code/message by the runtime, so a successful call means no code member. Only one debugger client per pid is allowed: an IDE debug session blocks attach, and attaching to an app that was not started with wait-for-debugger often yields an empty session (no scriptParsed/paused) — the tool reports that explicitly instead of pretending the session works.',
      'When the app stops at a breakpoint (or on an exception) this session is notified automatically with the pause location and the call stack — you receive it as an in-session message, so do not poll action=status in a loop to detect it. Pauses you trigger yourself (attach entry pause, action=pause, action=step) are reported inline by the tool result instead and are never pushed twice.',
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
      url: { type: 'string', description: 'Compiled mode: exact scriptParsed url for set_breakpoint/remove_breakpoint. scripts may also use it as a substring filter.' },
      line: { type: 'integer', description: 'Compiled breakpoint only: 0-based generated .ts line. For .ets use source_line instead.' },
      column: { type: 'integer', description: 'Compiled breakpoint only: 0-based generated column (default 0).' },
      source_path: { type: 'string', description: 'Source breakpoint: .ets absolute path or project-relative path (for example entry/src/main/ets/pages/Index.ets).' },
      source_line: { type: 'integer', description: 'Source breakpoint: 1-based .ets line. The resolver moves blank/non-executable lines to the next mapped statement and reports the actual line.' },
      source_column: { type: 'integer', description: 'Source breakpoint: optional 1-based .ets column (default 1).' },
      project_path: { type: 'string', description: 'Project root or any path inside it. Used to load Hvigor Source Maps; defaults to the current session workspace, then the session project.' },
      build_mode: { type: 'string', enum: ['debug', 'release'], description: 'Source-map build variant (default debug). Must match the running app build.' },
      condition: { type: 'string', description: 'set_breakpoint: conditional expression.' },
      breakpoint_id: { type: 'string', description: 'remove_breakpoint: breakpoint id returned by set_breakpoint.' },
      expression: { type: 'string', description: 'evaluate: expression to run on the paused frame.' },
      frame: { type: 'integer', description: 'evaluate: call-frame index (default 0 = innermost).' },
      object_id: { type: 'string', description: 'properties: remote object id (from scopeChain / evaluate result).' },
      state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'exceptions: pause-on-exception state.' },
      step: { type: 'string', enum: ['over', 'into', 'out'], description: 'step: which step command.' },
      enabled: { type: 'boolean', description: 'notify: turn the automatic breakpoint notification on (true) or off (false).' },
      notify: { type: 'boolean', description: 'attach only: set false to skip the automatic breakpoint notification for this session (default true).' },
      skip_pauses: { type: 'boolean', description: 'attach only: set false to keep the runtime pausing on every loaded script (default true = skip those startup pauses so the app actually runs).' },
      skip: { type: 'boolean', description: 'skip_pauses: true = skip all pauses (startup fast-forward), false = normal pausing (breakpoints work).' },
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
          lines.push(...data.breakpoints.map((b) => {
            const where = b.sourcePath ? `${b.sourcePath}:${b.sourceLine} → ${b.url}:${(b.line ?? 0) + 1}` : `${b.url}:${(b.line ?? 0) + 1}`
            return `  ${where} ${b.condition ? 'if ' + b.condition : ''} (${b.breakpointId})`
          }))
        }
        if (Array.isArray(data.events) && data.events.length) {
          lines.push(...data.events.slice(-(args.limit || 20)).map((e) => `  ${e.method}`))
        }
        if (data.result !== undefined) lines.push(JSON.stringify(data.result, null, 1))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute (args, exec) {
      const action = String(args.action || '')
      if (action === 'attach') {
        const attached = await attachSession(host, args, exec)
        const data = attached.reused
          ? { reused: true, protocols: attached.session.protocols, paused: pausedData(attached.session), sourceMaps: sourceMapData(attached.session) }
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
        const removed = await host.hdc(buildDebuggerForwardRemoveArgs(session.port, session.pid, session.device), 15000)
        return debugResult('detach', session, {
          message: `已断开（fport 清理${removed.ok ? '成功' : '失败'}）。注意：调试模式启动的应用在调试器断开后可能被系统结束。`,
          data: { forwardRemoved: removed.ok },
        })
      }
      const session = sessionFor(host, args.pid)
      // The calling agent owns the session from now on: a later pause is
      // reported to whoever asked for the debug session last.
      claimOwner(session, exec, host)
      installPauseNotifier(session, host)
      if ((args.project_path || args.build_mode) && action !== 'set_breakpoint') {
        await configureSessionSourceMaps(session, host, args, exec)
      }
      if (action === 'status') {
        return debugResult('status', session, {
          message: session.paused ? `已暂停（${describePauseReason(session.paused)}）` : '运行中',
          data: {
            protocols: session.protocols,
            scripts: [...session.scripts.keys()].length,
            paused: pausedData(session),
            breakpoints: session.breakpoints,
            sourceMaps: sourceMapData(session),
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
        const sourcePath = typeof args.source_path === 'string' ? args.source_path.trim() : ''
        let target = { url: args.url, line: args.line, column: args.column, condition: args.condition }
        let source = null
        if (sourcePath) {
          const sourceLine = Number(args.source_line)
          if (!Number.isInteger(sourceLine) || sourceLine < 1) throw fail('源码断点需要 source_line（1 基正整数）；line 仅用于编译后 .ts 的 0 基行号。')
          const sourceColumn = args.source_column === undefined ? 1 : Number(args.source_column)
          if (!Number.isInteger(sourceColumn) || sourceColumn < 1) throw fail('source_column 必须是 1 基正整数。')
          const index = await configureSessionSourceMaps(session, host, args, exec, true)
          if (!index || index.scriptCount === 0) throw fail('没有可用 Source Map：先对当前工程执行 debug 模式的 devecocli build/run，再设置源码断点。')
          try {
            source = index.resolveSourceBreakpoint({
              sourcePath,
              sourceLine: sourceLine - 1,
              sourceColumn: sourceColumn - 1,
              loadedScripts: new Set(session.scripts.keys()),
            })
          } catch (error) {
            throw fail(error && error.message ? error.message : String(error))
          }
          if (!source) throw fail(`Source Map 中找不到 ${sourcePath}:${sourceLine} 的可执行映射。确认文件属于当前工程且已编译；空白/纯类型行可改到具体语句行。`)
          await assertSourceBreakpointFresh(source, sourcePath, index.projectRoot).catch((error) => { throw fail(error.message) })
          target = { url: source.url, line: source.line, column: source.column, condition: args.condition }
        } else if (args.project_path || args.build_mode) {
          await configureSessionSourceMaps(session, host, args, exec)
        }
        // 断点只在「不跳过暂停」时才会命中——先把启动期跳过的开关关掉。
        await session.ensurePausesEnabled()
        const reply = await session.setBreakpoint(target)
        if (!reply.ok) throw fail(`设置断点失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        if (source) {
          const breakpoint = [...session.breakpoints].reverse().find((item) => item.breakpointId === reply.value.breakpointId)
          if (breakpoint) Object.assign(breakpoint, {
            sourcePath: source.sourcePath,
            sourceLine: source.sourceLine,
            sourceColumn: source.sourceColumn,
            requestedSourceLine: Number(args.source_line),
          })
        }
        const anyInvalid = Array.isArray(reply.value.locations) && reply.value.locations.some((l) => l.id === 'invalid')
        const mapping = source
          ? `源码 ${source.sourcePath}:${args.source_line} → ${source.url}:${source.line + 1}:${source.column + 1}${source.sourceLine !== Number(args.source_line) ? `（实际落在源码 ${source.sourceLine} 行）` : ''}`
          : ''
        return debugResult('set_breakpoint', session, {
          message: [source ? `已设置源码断点：${mapping}` : '断点已设置', anyInvalid
            ? '但该 url 当前没有已加载脚本可落点（id:"invalid"）——等脚本加载后再试，或确认运行的是当前构建。'
            : ''].filter(Boolean).join('；'),
          data: { breakpointId: reply.value.breakpointId, locations: reply.value.locations, source, sourceMaps: sourceMapData(session), breakpoints: session.breakpoints },
        })
      }
      if (action === 'skip_pauses') {
        const skip = args.skip !== false
        const reply = await session.setSkipAllPauses(skip)
        if (!reply.ok) throw fail(`设置跳过暂停失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        return debugResult('skip_pauses', session, {
          message: skip
            ? '已开启「跳过暂停」：应用加载脚本时不再逐个停下（启动期用）。设断点/pause/step 会自动关掉它。'
            : '已关闭「跳过暂停」：断点、pause、step 恢复生效（应用每加载一个新脚本会停一次）。',
          data: { skipPauses: session.skipPauses },
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
        // 显式暂停在「跳过暂停」状态下不会生效——先关掉。
        await session.ensurePausesEnabled()
        // This pause is reported inline below — it must not also be pushed.
        session.noteExpectedPause(8000)
        const pending = session.waitEvent('Debugger.paused', null, 6000).then((params) => params, () => null)
        const reply = await session.pause()
        if (!reply.ok) {
          session.clearExpectedPauses()
          throw fail(`pause 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        }
        const paused = await pending
        if (!paused) session.clearExpectedPauses()
        else session.markPauseReportedInline()
        return debugResult('pause', session, {
          message: paused ? `已暂停：${session.paused ? describePauseReason(session.paused) : ''}` : 'pause 已受理，但 6s 内没有 Debugger.paused（空闲 JS 线程无检查点；触发一次交互或改用断点）',
          data: { paused: pausedData(session) },
        })
      }
      if (action === 'resume') {
        const reply = await session.resume()
        if (!reply.ok) throw fail(`resume 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        // The runtime may not emit Debugger.resumed for an entry pause, so
        // clear the local pause state ourselves — otherwise `stack` would keep
        // reporting the stale frames. Only clear the snapshot we paused at: a
        // pause the runtime reports *after* the resume (the ArkVM emits one
        // "Break on start" per loaded module) must survive.
        const before = session.paused
        await new Promise((resolve) => setTimeout(resolve, 200))
        if (session.paused === before) session.paused = null
        return debugResult('resume', session, { message: '已继续运行' })
      }
      if (action === 'step') {
        const kind = ['over', 'into', 'out'].includes(args.step) ? args.step : 'over'
        // 单步依赖暂停——先关掉「跳过暂停」。
        await session.ensurePausesEnabled()
        // The step's own pause is reported inline below.
        session.noteExpectedPause(8000)
        const pending = session.waitEvent('Debugger.paused', null, 3000).then((params) => params, () => null)
        const reply = await session.step(kind)
        if (!reply.ok) {
          session.clearExpectedPauses()
          throw fail(`step 失败：${(reply.error && reply.error.message) || 'unknown error'}`)
        }
        // The runtime answers the step request before it emits the new pause;
        // wait for that event so the reported frames are the stepped-to ones.
        const paused = await pending
        if (!paused) session.clearExpectedPauses()
        else session.markPauseReportedInline()
        const top = mappedFrames(session)[0]
        const steppedLocation = top
          ? (top.sourcePath ? `${top.sourcePath}:${top.sourceLine}` : `${top.url}:${(top.lineNumber || 0) + 1}`)
          : '新位置'
        return debugResult('step', session, {
          message: `已执行 step ${kind}${paused ? `（已停在 ${steppedLocation}）` : ''}`,
          data: { paused: pausedData(session) },
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
        const frames = mappedFrames(session)
        return debugResult('stack', session, {
          message: `暂停原因：${describePauseReason(session.paused)}${session.paused.hitBreakpoints && session.paused.hitBreakpoints.length ? ` · 命中：${session.paused.hitBreakpoints.join(', ')}` : ''}`,
          data: { reason: session.paused.reason, frames, stackLines: formatCallFrameLines(frames), sourceMaps: sourceMapData(session) },
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
      if (action === 'notify') {
        const enabled = args.enabled !== false
        session.notifyEnabled = enabled
        return debugResult('notify', session, {
          message: enabled
            ? '已开启断点通知：应用停在断点/异常暂停时，本会话会自动收到一条包含暂停位置与调用栈的消息。'
            : '已关闭断点通知：应用停在断点时不再自动通知（需要时用 action=status 自行查询）。',
          data: { notifyEnabled: enabled },
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
  return [buildHarmonyProjectTool(defineTool, host), buildHarmonyDebugTool(defineTool, host)]
}
