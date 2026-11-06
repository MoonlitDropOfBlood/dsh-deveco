/**
 * dsh-deveco — Host half.
 *
 * A Cordis "class plugin": this module exports a `HarmonyDevEcoService` extending
 * `TypertRemoteService`. The DSH loader instantiates the class and registers it
 * as the `harmonyDevEco` service; the Typert Gateway exposes its `@Remote`-marked
 * methods to the browser Client half under the `harmonyDevEco` Remote namespace.
 *
 * The service provides toolchain path resolution (DevEco Studio / Command Line
 * Tools / PATH devecocli), device enumeration, HiLog batch + live streaming,
 * ArkUI Inspector (UI dump / screenshot / tap / swipe / text), and project
 * browsing for the HarmonyOS development workflow inside the DeepSeek Harness
 * web UI.
 *
 * The Host runs inside the DSH Node process with full privileges; child
 * processes are spawned through node:child_process directly so the plugin
 * can wrap the user's local `devecocli` / `hdc` binaries.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import { randomUUID, randomBytes } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureDiscovery,
  loadConfig,
  saveConfig,
  setStudioPath as persistStudioPath,
  setCltPath as persistCltPath,
} from "./harmony-config.mjs";
import { resolveCli } from "./harmony-studio.mjs";
import {
  execCli,
  execHdc,
  resolveHdc,
  devecoExec,
  buildHilogArgs,
  buildHilogFollowArgs,
  buildUiDumpArgs,
  buildUiScreenshotArgs,
  buildUiTapArgs,
  buildUiSwipeArgs,
  buildUiTextArgs,
  buildUiWindowListArgs,
  buildUiRawDumpArgs,
  buildUiRawRecvArgs,
  buildUiRawCleanArgs,
  buildHdcListTargetsArgs,
  parseHdcTargets,
  buildHdcHilogArgs,
  buildHdcHilogFollowArgs,
  buildHdcScreenCapArgs,
  buildHdcSnapshotDisplayArgs,
  buildHdcFileRecvArgs,
  buildHdcFileRemoveArgs,
  buildHdcTapArgs,
  buildHdcSwipeArgs,
  buildHdcTextArgs,
  buildHdcWindowListArgs,
  parseWindowManagerDump,
  buildHdcParamArgs,
  HDC_DEVICE_PARAM_KEYS,
  buildArkForwardArgs,
  buildLocalAbstractForwardArgs,
  buildForwardRemoveArgs,
  DEV_ECO_WS_MESSAGES,
  parseDevEcoTree,
  buildDevEcoWsHandshake,
  isWsHandshakeAccepted,
  encodeWsClientTextFrame,
  encodeWsPongFrame,
  decodeWsServerFrames,
  devEcoTreeLines,
  devEcoToolNodes,
  buildHdcConnectArgs,
  buildHdcDisconnectArgs,
  parseProcessPids,
  parseHilogLine,
  parseDeviceList,
  parseUiLayoutJson,
  parseUiRawDump,
  parseUiWindowListJson,
  parseTconnResult,
  readPngSize,
} from "./harmony-device.mjs";
import { buildHarmonyAgentTools } from "./harmony-agent-tools.mjs";
import { buildDebuggerForwardRemoveArgs } from "./harmony-debugger.mjs";

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 *
 * Mirrors the pattern in dsh-memory-manager / dsh-token-stats / dsh-archive-manager.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/**
 * Resolve the per-plugin data directory under DSH_HOME.
 * Honors `$DSH_HOME` (DSH's own env); falls back to `~/.dsh`.
 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** Owned wire object — converts a resolved toolchain record into JSON-safe form.
 *
 * `extra` carries runtime capability flags (`cliAvailable` / `hdcAvailable`)
 * that are probed by the service, not by the pure resolver. They let the
 * client show the honest degraded state instead of a healthy badge on a
 * toolchain whose devecocli is missing.
 */
function toResolvedWire(resolved, extra) {
  if (!resolved) {
    return {
      source: "none",
      minVersionOk: false,
      cliAvailable: false,
      hdcAvailable: !!(extra && extra.hdcAvailable),
      message: "未配置工具链",
    };
  }
  const wire = {
    source: resolved.source || "none",
    minVersionOk: !!resolved.minVersionOk,
    cliAvailable: typeof extra?.cliAvailable === "boolean" ? extra.cliAvailable : !!resolved.cliAvailable,
    hdcAvailable: !!(extra && extra.hdcAvailable),
    message: typeof resolved.message === "string" ? resolved.message : "",
  };
  if (typeof resolved.exec === "string" && resolved.exec) wire.exec = resolved.exec;
  if (typeof resolved.path === "string" && resolved.path) wire.path = resolved.path;
  if (Array.isArray(resolved.version)) wire.version = resolved.version;
  else if (typeof resolved.version === "string" && resolved.version) wire.version = resolved.version;
  return wire;
}

/** Owned wire object for the config persistence file. */
function toConfigWire(config) {
  return {
    studioPath: (config && typeof config.studioPath === "string") ? config.studioPath : "",
    cltPath: (config && typeof config.cltPath === "string") ? config.cltPath : "",
    updatedAt: (config && Number.isFinite(config.updatedAt)) ? config.updatedAt : 0,
  };
}

/** Owned wire object for the discovery result. */
function toDiscoveryWire(disc) {
  if (!disc) {
    return {
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      scannedAt: 0,
      studios: [],
      clts: [],
    };
  }
  const platform = (disc.platform === "win32" || disc.platform === "darwin" || disc.platform === "linux")
    ? disc.platform
    : (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
  const studios = Array.isArray(disc.studios) ? disc.studios.map((s) => {
    if (!s) return null;
    const path = typeof s.path === "string" ? s.path : "";
    const kind = s.kind === "studio" ? "studio" : "studio";
    return { path, kind };
  }).filter(Boolean) : [];
  const clts = Array.isArray(disc.clts) ? disc.clts.map((c) => {
    if (!c) return null;
    const path = typeof c.path === "string" ? c.path : "";
    const version = typeof c.version === "string" ? c.version : "";
    return { path, version, kind: "clt" };
  }).filter((c) => c && c.version) : [];
  return {
    schemaVersion: 1,
    platform,
    scannedAt: Number.isFinite(disc.scannedAt) ? disc.scannedAt : 0,
    studios,
    clts,
  };
}

function ok(value) {
  return { ok: true, value };
}

function err(code, message) {
  return { ok: false, error: { code: String(code || "unknown"), message: String(message || "") } };
}

/**
 * Toolchain configuration persistence.
 *
 * The plugin owns its config file at `<DSH_HOME>/data/dsh-deveco/config.json`
 * (schema `{ schemaVersion: 1, studioPath, cltPath, updatedAt }`; mutual
 * exclusion between Studio and CLT is enforced by harmony-config.mjs on every
 * write). The client half reads through `getConfig` and writes through the
 * `setStudioPath` / `setCltPath` Remote methods — no DSH settings service is
 * involved (DSH 0.2.0 removed the `settingsScope` client API).
 */

/** 选一个本机空闲端口（fport 的 tcp 端口侧）。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 连应用调试 socket，按 DevEco 的握手顺序请求组件树，resolve 到 `{"type":"root"}` 回包。
 *
 * **必须用裸 socket + Java-WebSocket 风格极简握手**（实测，2026-10）：应用侧
 * inspector 服务（ets_runtime ConnectServer/HttpHandShake）是手写的极简 HTTP
 * 解析器，Node 自带 WebSocket 的握手头（permessage-deflate 扩展等）会被判
 * 「HTTP upgrade parameters failure」秒拒——hilog 实证。帧编解码见
 * harmony-device.mjs 的 encodeWsClientTextFrame / decodeWsServerFrames。
 */
function devEcoWsRequestTree(port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let stage = "handshake"
    let buf = Buffer.alloc(0)
    const host = `127.0.0.1:${port}`
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.write(buildDevEcoWsHandshake(host, randomBytes(16).toString("base64")))
    })
    const settle = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy(); } catch (_) {}
      fn(v)
    }
    const timer = setTimeout(() => {
      settle(reject, new Error(stage === "handshake"
        ? "WebSocket 握手超时（应用侧未响应升级请求）"
        : "等待组件树超时（应用未回 type:root）"))
    }, timeoutMs)
    const fail = (msg) => settle(reject, new Error(msg))
    sock.on("error", (e) => fail(`调试 socket 连接失败：${e && e.message ? e.message : e}`))
    sock.on("close", () => { if (!settled) fail("调试 socket 已关闭") })
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      if (stage === "handshake") {
        const text = buf.toString("latin1")
        if (!text.includes("\r\n\r\n")) return
        if (!isWsHandshakeAccepted(text)) {
          fail("WebSocket 握手被拒（HTTP upgrade parameters failure）——应用侧只接受极简握手头")
          return
        }
        stage = "frames"
        buf = Buffer.from(text.split("\r\n\r\n").slice(1).join("\r\n\r\n"), "latin1")
        // DevEco 的消息顺序：connected → inspectorAbilities → tree
        // （应用握手成功后会立刻主动推 addInstance，root 也会自动跟来）
        sock.write(encodeWsClientTextFrame(DEV_ECO_WS_MESSAGES.connected, randomBytes(4)))
        setTimeout(() => { try { sock.write(encodeWsClientTextFrame(DEV_ECO_WS_MESSAGES.inspectorAbilities, randomBytes(4))); } catch (_) {} }, 150)
        setTimeout(() => { try { sock.write(encodeWsClientTextFrame(DEV_ECO_WS_MESSAGES.tree, randomBytes(4))); } catch (_) {} }, 350)
      }
      const { texts, pings, closed, rest } = decodeWsServerFrames(buf)
      buf = rest
      for (const p of pings) {
        try { sock.write(encodeWsPongFrame(p, randomBytes(4))); } catch (_) {}
      }
      for (const t of texts) {
        let obj = null
        try { obj = JSON.parse(t); } catch (_) { continue }
        if (obj && obj.type === "root") {
          settle(resolve, obj)
          return
        }
      }
      if (closed) fail("应用关闭了调试连接")
    })
  })
}

/**
 * Agent 工具面：`harmony_ui_tree` —— DevEco 开发调试源取树，注册进 DSH 的
 * `ctx.tools`（`@deepseek-ai/dsh-tools` 的 `defineTool`），让对话里的 agent
 * 直接调用。canonical 输出是紧凑节点数组（`devEcoNodeSummary`），`render`
 * 投影为缩进树文本（或 json 格式时输出完整 JSON）。
 *
 * @param {Function} defineTool dsh-tools 的 defineTool（运行期动态导入）
 * @param {HarmonyDevEcoService} service Host 服务实例（复用 _fetchDevEcoTree）
 */
function buildHarmonyUiTreeTool (defineTool, service) {
  const sidesSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      top: { type: "number", required: true },
      right: { type: "number", required: true },
      bottom: { type: "number", required: true },
      left: { type: "number", required: true },
    },
  };
  const boundsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      left: { type: "number", required: true },
      top: { type: "number", required: true },
      right: { type: "number", required: true },
      bottom: { type: "number", required: true },
      width: { type: "number", required: true },
      height: { type: "number", required: true },
    },
  };
  const nodeSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      index: { type: "integer", required: true },
      depth: { type: "integer", required: true },
      parentIndex: { type: "integer", required: true },
      name: { type: "string", required: true, description: "展示名：组件名 → 开发者 .id() → 真实类型（沿用 UI 标签规则）" },
      componentName: { type: "string", required: true },
      className: { type: "string", required: true },
      kind: { type: "string", enum: ["custom", "build-in"], required: true },
      text: { type: "string", required: true },
      devId: { type: "string", required: true },
      accessibilityId: { type: "string", required: true },
      bounds: { ...boundsSchema, required: true },
      visible: { type: "boolean", required: true },
      enabled: { type: "boolean", required: true },
      clickable: { type: "boolean", required: true },
      scrollable: { type: "boolean", required: true },
      childCount: { type: "integer", required: true, description: "原始树中的直接子节点总数；Swiper/不可见/max_nodes 裁剪后仍保持原值" },
      childrenOmitted: { type: "boolean", description: "true = 该节点的直接子节点因裁剪未返回" },
      hiddenDirect: { type: "integer", description: "被省略的直接子节点数（childrenOmitted 时有值）" },
      padding: sidesSchema,
      margin: sidesSchema,
      borderWidth: { type: "number" },
      borderRadius: { type: "number" },
      borderColor: { type: "string" },
      attrs: { type: "json", description: "include_attrs 时附带的全部原始属性" },
    },
  };
  return defineTool({
    name: "harmony_ui_tree",
    description: "Fetch the ArkUI component tree of a HarmonyOS app on a connected device/emulator through the DevEco development-debug channel — the same data DevEco Studio's ArkUI Inspector shows, including component/Builder names (viewTag) and declared padding/margin/border values (uitest dumps lack these). Invisible nodes (visible=false / Visibility.Hidden / Visibility.None) are kept as leaf stubs (visible=false) while their whole subtrees are pruned — e.g. a home page hidden behind a pushed NavDestination stays inspectable as one stub row. For Swiper with displayCount absent or <= 1, only the currentIndex page is returned in full; other pages keep only their root, plus one child level for TabContent. Requires a debuggable app; the app-side inspector socket is single-client, so close DevEco Studio's ArkUI Inspector panel first if it is open (the error message lists all prerequisites). By default targets the foreground window's app. Returns an indented tree of nodes with bounds, text and box-model declarations.",
    parameters: {
      device: { type: "string", description: "Device/emulator serial as listed by hdc targets (e.g. 127.0.0.1:5555). Omit for the default target." },
      pid: { type: "integer", description: "Target app process id. Omit to use the foreground window's app." },
      package_name: { type: "string", description: "Target app package name (e.g. com.example.app). Derived from /proc/<pid>/cmdline when omitted." },
      format: { type: "string", enum: ["tree", "json"], default: "tree", description: "tree = compact indented text lines (default); json = the full node objects as JSON." },
      include_attrs: { type: "boolean", description: "Include every node's full raw attribute map (very verbose; off by default)." },
      max_nodes: { type: "integer", description: "Maximum number of nodes returned (default 400, capped at 4000). Truncation drops whole subtrees — the boundary parent is flagged with childrenOmitted/hiddenDirect so no half-subtree is ever returned." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", const: "deveco", required: true },
          pid: { type: "integer", required: true },
          packageName: { type: "string", required: true },
          nodeCount: { type: "integer", required: true, description: "树中全部节点数（截断前）" },
          truncated: { type: "boolean", required: true },
          nodes: { type: "array", items: nodeSchema, required: true },
        },
      },
      render (args, value) {
        if (args && args.format === "json") {
          return [{ type: "text", text: JSON.stringify(value, null, 1) }];
        }
        const head = `ArkUI 组件树（DevEco 调试源） pid=${value.pid} ${value.packageName} 共 ${value.nodeCount} 节点`
          + (value.truncated ? `（已截断至 ${value.nodes.length}，加 max_nodes 看更多）` : "");
        return [{ type: "text", text: [head, ...devEcoTreeLines(value.nodes)].join("\n") }];
      },
    },
    async execute (args) {
      const res = await service._fetchDevEcoTree({
        device: args.device,
        pid: args.pid,
        packageName: args.package_name,
      });
      if (!res.ok) {
        throw new Error((res.error && (res.error.message || res.error.code)) || "harmony_ui_tree failed");
      }
      const all = Array.isArray(res.value.nodes) ? res.value.nodes : [];
      let cap = Number.isFinite(args.max_nodes) ? Math.floor(args.max_nodes) : 400;
      cap = Math.max(1, Math.min(cap, 4000));
      // 整棵子树省略式裁剪：绝不发半棵；childCount/childrenOmitted/hiddenDirect
      // 告诉前端与 agent 被省略处内部还有多少直接子节点。
      const trimmed = devEcoToolNodes(all, cap, args.include_attrs === true);
      return {
        source: "deveco",
        pid: res.value.pid,
        packageName: res.value.packageName,
        nodeCount: trimmed.nodeCount,
        truncated: trimmed.truncated,
        nodes: trimmed.nodes,
      };
    },
    isConcurrencySafe () { return true; },  // 只读、无共享状态，可并行
  });
}

export class HarmonyDevEcoService extends TypertRemoteService {
  /**
   * No hard service dependencies — the entire toolchain layer is local modules.
   */
  static inject = [];

  /**
   * Cordis instantiates class plugins with `new Callback(ctx, config)` — the
   * second argument is the plugin config, NOT the service key. Pass the exact
   * service key to `super()` (see dsh-token-stats / dsh-memory-manager).
   */
  constructor(ctx, config) {
    super(ctx, "harmonyDevEco");
    this._ctx = ctx;
    this._configDir = join(dshHome(), "data", "dsh-deveco");
    /** streamId → { child, buffer: Array<object>, closed: boolean, error?: string } */
    this._streams = new Map();
    /** pid → ArktsDebuggerSession（ArkTS 运行时调试会话，单 pid 单客户端） */
    this._debugSessions = new Map();
    this._discovery = null;
    /** In-memory copy of the persisted config, loaded in [Service.init](). */
    this._config = { schemaVersion: 1, studioPath: "", cltPath: "", updatedAt: 0 };
    /** Returns the currently authoritative config. */
    this._getConfigSource = () => this._config;
    this._resolved = null;
  }

  /** Cordis class-plugin initializer: runs after construction, before publish. */
  async [Service.init]() {
    markRemoteMethod(this, "getConfig", "getConfig");
    markRemoteMethod(this, "setStudioPath", "setStudioPath");
    markRemoteMethod(this, "setCltPath", "setCltPath");
    markRemoteMethod(this, "rescan", "rescan");
    markRemoteMethod(this, "deviceList", "deviceList");
    markRemoteMethod(this, "deviceInfo", "deviceInfo");
    markRemoteMethod(this, "deviceConnectIp", "deviceConnectIp");
    markRemoteMethod(this, "deviceDisconnectIp", "deviceDisconnectIp");
    markRemoteMethod(this, "deviceProcessPids", "deviceProcessPids");
    markRemoteMethod(this, "hilogList", "hilogList");
    markRemoteMethod(this, "hilogStreamStart", "hilogStreamStart");
    markRemoteMethod(this, "hilogStreamRead", "hilogStreamRead");
    markRemoteMethod(this, "hilogStreamStop", "hilogStreamStop");
    markRemoteMethod(this, "uiDump", "uiDump");
    markRemoteMethod(this, "uiDevEcoTree", "uiDevEcoTree");
    markRemoteMethod(this, "uiWindowList", "uiWindowList");
    markRemoteMethod(this, "uiScreenshot", "uiScreenshot");
    markRemoteMethod(this, "uiTap", "uiTap");
    markRemoteMethod(this, "uiSwipe", "uiSwipe");
    markRemoteMethod(this, "uiText", "uiText");
    markRemoteMethod(this, "listProjects", "listProjects");
    markRemoteMethod(this, "readTextFile", "readTextFile");

    // Agent 工具面：把 DevEco 调试源取树注册为 `harmony_ui_tree` 工具，
    // 让对话里的 agent 可直接调用（`ctx.tools`，dsh-tools 的 defineTool）。
    // 任何一环不可用都静默跳过——Remote/UI 面不受影响。
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      if (typeof defineTool === "function" && typeof this._ctx.inject === "function") {
        this._ctx.inject(["tools"], (injected) => {
          const tools = injected.get("tools");
          if (!tools || typeof tools.register !== "function") return;
          const disposers = [];
          const register = (tool, label) => {
            try {
              const off = tools.register(tool);
              if (typeof off === "function") disposers.push(off);
            } catch (_) {
              // 工具名冲突等：不阻断其它工具与 Remote 面
              void label;
            }
          };
          register(buildHarmonyUiTreeTool(defineTool, this), "harmony_ui_tree");
          // ArkTS 运行时调试器工具面（harmony_debug）。Host 只提供执行与设备
          // 传输；命令构造、解析与会话状态机都在 harmony-agent-tools.mjs。
          // 日志与应用管理不重复造轮子——agent 直接用 devecocli log / device app。
          try {
            const host = {
              sessions: this._debugSessions,
              hdc: (argv, timeoutMs) => this._hdcRun(argv, timeoutMs),
              shell: (command, device, timeoutMs) => this._deviceShell(command, device, timeoutMs),
            };
            for (const tool of buildHarmonyAgentTools({ defineTool, host })) {
              register(tool, tool && tool.name);
            }
          } catch (_) { /* 调试工具面不可用：保留 harmony_ui_tree */ }
          if (typeof this._ctx.effect === "function" && disposers.length > 0) {
            this._ctx.effect(() => () => {
              for (const off of disposers) {
                try { off(); } catch (_) { /* best effort */ }
              }
            });
          }
        });
      }
    } catch (_) { /* dsh-tools 不可用：仅 UI/Remote 面 */ }

    // Ensure the data directory exists, load the persisted config, then warm
    // the discovery cache.
    try {
      await mkdir(this._configDir, { recursive: true });
    } catch (e) {
      // Non-fatal: loadConfig/ensureDiscovery will surface IO errors later.
    }

    try {
      this._config = await loadConfig(this._configDir);
    } catch (_) {
      this._config = { schemaVersion: 1, studioPath: "", cltPath: "", updatedAt: 0 };
    }

    try {
      this._discovery = await ensureDiscovery(this._configDir);
    } catch (_) {
      this._discovery = null;
    }

    this._reloadResolved();

    // Best-effort cleanup of any leftover live-streams when the plugin fiber
    // is disposed (DSH shutdown, plugin reload). Each child process is killed
    // and the bookkeeping map is wiped so a restart starts clean.
    this.ctx.effect(() => () => {
      for (const [, s] of this._streams) {
        try { s.child.kill(); } catch (_) { /* */ }
      }
      this._streams.clear();
      // Close every ArkTS debugger session and drop its hdc forward rule; a
      // leaked `fport` rule would block the next attach on the same pid.
      for (const [, session] of this._debugSessions) {
        try { session.close(); } catch (_) { /* */ }
        try {
          this._hdcRun(buildDebuggerForwardRemoveArgs(session.port, session.pid), 8000).catch(() => {});
        } catch (_) { /* */ }
      }
      this._debugSessions.clear();
    });
  }

  // ---- internal helpers ----------------------------------------------------

  /**
   * Refresh `_resolved` from the current config. Re-runs on every config
   * write (setStudioPath / setCltPath) so the toolchain resolution always
   * matches the persisted paths.
   */
  _reloadResolved() {
    const c = this._getConfigSource() || {};
    this._resolved = resolveCli({
      studioPath: typeof c.studioPath === "string" ? c.studioPath : "",
      cltPath: typeof c.cltPath === "string" ? c.cltPath : "",
    });
    return this._resolved;
  }

  /**
   * Absolute path to a **usable** devecocli executable, or null.
   *
   * `devecocli` is a separate npm package (`@deveco/deveco-cli`); DevEco
   * Studio and Command Line Tools do NOT bundle it. `resolveCli` fills `exec`
   * only after probing the file, but the synthesized `<root>/bin/devecocli`
   * shape is re-checked here too — a missing CLI must never turn into a
   * spawn-ENOENT for every feature. null ⇒ hdc degradation path.
   */
  _cliExec() {
    const r = this._resolved;
    if (!r) return null;
    const candidate = devecoExec(r);
    if (!candidate) return null;
    try {
      return existsSync(candidate) ? candidate : null;
    } catch (_) {
      return null;
    }
  }

  /** Runtime capability snapshot (wire + degradation decisions). */
  _capabilities() {
    return {
      cliAvailable: !!this._cliExec(),
      hdcAvailable: !!this._resolveHdcPath(),
    };
  }

  /** Wire-shaped resolved record with the runtime capability flags attached. */
  _resolvedWire() {
    return toResolvedWire(this._resolved, this._capabilities());
  }

  /** Neither devecocli nor hdc is usable — every device/UI feature needs one. */
  _toolchainError() {
    const msg = (this._resolved && this._resolved.message) || "";
    return err(
      "no-toolchain",
      "未找到可用的 devecocli 或 hdc。devecocli 是独立安装的命令行工具（npm i -g @deveco/deveco-cli），"
      + "不随 DevEco Studio / Command Line Tools 一起安装；未安装时插件会降级到 SDK 自带的 hdc，"
      + "请在设置 → HarmonyOS Suite 配置 DevEco Studio 或 Command Line Tools 路径。"
      + (msg ? ` 当前状态：${msg}` : "")
    );
  }

  /** `-t <serial>` prefix for hdc target scoping. */
  _hdcTargetArgs(device) {
    return device ? ["-t", String(device)] : [];
  }

  /**
   * Run one devecocli command, normalizing failures to the standard error
   * envelope. The success envelope wraps `{stdout, stderr, code}` exactly as
   * execCli returns it; callers shape it into their own payload.
   *
   * Callers that have an hdc fallback MUST check `_cliExec()` first — this
   * method is the CLI-only branch.
   *
   * devecocli quirk: it prints `error: ...` yet still exits 0, so non-zero
   * exit alone can't detect failures — we also treat a leading `error:` line
   * in stdout/stderr as a failure.
   */
  async _execOrErr(args, opts) {
    if (!this._cliExec()) {
      return err("no-cli", (this._resolved && this._resolved.message) || "未安装 devecocli");
    }
    try {
      const r = await execCli(this._resolved, args, opts || {});
      const combined = `${r.stderr || ""}\n${r.stdout || ""}`;
      const m = /^error:\s*(.+)$/m.exec(combined);
      if (m) {
        return err("cli-failed", m[0].trim());
      }
      return ok(r);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      return err("cli-failed", msg);
    }
  }

  /**
   * Run one `hdc` invocation for the agent tools. Unlike `_runHdc` (which
   * normalizes `hdc tconn` semantics and treats exit-0-with-`[Fail]` as an
   * error), this returns the raw stdout/stderr and only normalizes hard
   * failures — tools decide what `[Fail]` means for their own command.
   *
   * @param {string[]} argv Arguments after the executable (no `-t` needed here).
   * @param {number} [timeoutMs]
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, error?: { code: string, message: string } }>}
   */
  async _hdcRun(argv, timeoutMs = 20000) {
    const hdc = this._resolveHdcPath();
    if (!hdc) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error: { code: "no-hdc", message: "未找到 hdc：请在设置 → HarmonyOS Suite 配置 DevEco Studio 或 Command Line Tools 路径。" },
      };
    }
    try {
      const r = await execHdc(hdc, argv, { timeout: timeoutMs });
      const stdout = r.stdout || "";
      const stderr = r.stderr || "";
      return { ok: true, stdout, stderr };
    } catch (e) {
      const stdout = (e && e.stdout) || "";
      const stderr = (e && e.stderr) || "";
      if (e && e.timedOut) {
        return {
          ok: false,
          stdout,
          stderr,
          error: { code: "hdc-timeout", message: `hdc ${argv[0] || ""} 超时（${Math.round(timeoutMs / 1000)}s）` },
        };
      }
      return {
        ok: false,
        stdout,
        stderr,
        error: {
          code: "hdc-failed",
          message: ((e && e.message) ? e.message : String(e)) || stderr.trim() || "hdc 执行失败",
        },
      };
    }
  }

  /**
   * Run one command inside the device shell (`hdc [-t <serial>] shell '<cmd>'`).
   *
   * @param {string} command Device shell command line (quote user text first).
   * @param {string} [device] Target serial; omit for the single connected target.
   * @param {number} [timeoutMs]
   */
  async _deviceShell(command, device, timeoutMs = 20000) {
    const argv = device ? ["-t", device, "shell", command] : ["shell", command];
    return this._hdcRun(argv, timeoutMs);
  }

  // ---- config / discovery --------------------------------------------------

  async getConfig() {
    const c = this._getConfigSource() || { studioPath: "", cltPath: "" };
    return ok({
      config: toConfigWire(c),
      resolved: this._resolvedWire(),
      discovery: this._discovery ? toDiscoveryWire(this._discovery) : null,
    });
  }

  /**
   * Persist a DevEco Studio path. Writing Studio clears cltPath (mutual
   * exclusion — see harmony-config.mjs). An empty string clears the field.
   */
  async setStudioPath(request) {
    const path = (request && typeof request.path === "string") ? request.path.trim() : "";
    try {
      this._config = path
        ? await persistStudioPath(this._configDir, path)
        : await saveConfig(this._configDir, { studioPath: "" });
    } catch (e) {
      return err("persist-failed", (e && e.message) ? e.message : String(e));
    }
    this._reloadResolved();
    return ok({ config: toConfigWire(this._config), resolved: this._resolvedWire() });
  }

  /**
   * Persist a HarmonyOS Command Line Tools path. Writing CLT clears
   * studioPath (mutual exclusion). An empty string clears the field.
   */
  async setCltPath(request) {
    const path = (request && typeof request.path === "string") ? request.path.trim() : "";
    try {
      this._config = path
        ? await persistCltPath(this._configDir, path)
        : await saveConfig(this._configDir, { cltPath: "" });
    } catch (e) {
      return err("persist-failed", (e && e.message) ? e.message : String(e));
    }
    this._reloadResolved();
    return ok({ config: toConfigWire(this._config), resolved: this._resolvedWire() });
  }

  async rescan() {
    this._discovery = await ensureDiscovery(this._configDir);
    return ok({ discovery: toDiscoveryWire(this._discovery) });
  }

  // ---- file viewer ----------------------------------------------------------

  /** Hard cap for the ArkTS viewer: files larger than 2 MiB are truncated. */
  static get READ_TEXT_FILE_MAX_BYTES() { return 2 * 1024 * 1024; }

  /**
   * Read a UTF-8 text file from an absolute host path for the `.ets` sidebar
   * viewer. The client parses the `dsh-resource://file/absolute/...` address
   * and sends the decoded absolute path here.
   */
  async readTextFile(request) {
    const path = (request && typeof request.path === "string") ? request.path : "";
    if (!path) return err("invalid-request", "path required");
    try {
      const raw = await readFile(path);
      const max = HarmonyDevEcoService.READ_TEXT_FILE_MAX_BYTES;
      const truncated = raw.length > max;
      const slice = truncated ? raw.subarray(0, max) : raw;
      return ok({
        path,
        content: slice.toString("utf8"),
        bytes: raw.length,
        truncated,
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const code = (e && e.code === "ENOENT") ? "not-found" : "read-failed";
      return err(code, msg);
    }
  }

  // ---- device commands -----------------------------------------------------

  async deviceList() {
    // devecocli is preferred when installed (richer rows: name / deviceType);
    // without it, enumerate the SDK's hdc targets. This is the difference
    // between an empty device dropdown ("plugin unusable") and a working UI.
    if (this._cliExec()) {
      const r = await this._execOrErr(["device", "list", "--format", "json"], { timeout: 15000 });
      if (r.ok === false) return r;
      let devices = [];
      try {
        devices = parseDeviceList(r.value && r.value.stdout);
      } catch (_) {
        // Parser failure is non-fatal — return an empty list, not an error.
        devices = [];
      }
      return ok({ devices });
    }
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    const out = await this._hdcRun(buildHdcListTargetsArgs(), 10000);
    const text = `${out.stdout || ""}\n${out.stderr || ""}`;
    if (!out.ok) {
      return err(
        (out.error && out.error.code) || "hdc-failed",
        (out.error && out.error.message) || text.trim() || "hdc list targets 失败"
      );
    }
    // hdc exits 0 on failure — `[Fail]…` is the only reliable marker.
    const fail = /\[Fail\]\s*([^\r\n]*)/i.exec(text);
    if (fail) return err("hdc-failed", (fail[1] || "").trim() || "hdc list targets 失败");
    return ok({ devices: parseHdcTargets(out.stdout || text) });
  }

  async deviceInfo(request) {
    const device = (request && typeof request.device === "string") ? request.device : "";
    if (!device) return err("invalid-request", "device required");
    if (this._cliExec()) {
      const r = await this._execOrErr(["device", "view", "-t", device], { timeout: 15000 });
      if (r.ok === false) return r;
      // devecocli device view prints key/value pairs; the client just gets the
      // raw text plus the parsed stdout/stderr/code so it can render whatever.
      const stdout = (r.value && r.value.stdout) || "";
      const stderr = (r.value && r.value.stderr) || "";
      return ok({ info: { serial: device, stdout, stderr, code: r.value ? r.value.code : 0 } });
    }
    // hdc fallback: read the same `const.*` system parameters DevEco CLI reads.
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    const lines = [];
    for (const key of HDC_DEVICE_PARAM_KEYS) {
      const out = await this._hdcRun(
        [...this._hdcTargetArgs(device), ...buildHdcParamArgs(key)],
        8000
      );
      // A broken target (no device / unauthorized) must be reported once,
      // not rendered as five "(读取失败)" rows.
      const text = `${out.stdout || ""}\n${out.stderr || ""}`;
      if (!out.ok || text.includes("[Fail]")) {
        if (lines.length === 0) {
          return err(
            (out.error && out.error.code) || "hdc-failed",
            (out.error && out.error.message) || text.trim() || `读取设备 ${device} 信息失败`
          );
        }
      }
      const value = out.ok ? String(out.stdout || "").trim() : "";
      lines.push(`${key}: ${value || "（读取失败）"}`);
    }
    return ok({ info: { serial: device, stdout: lines.join("\n"), stderr: "", code: 0 } });
  }

  // ---- IP 网络连接（hdc tconn） ---------------------------------------------
  // devecocli 没有 IP/TCP 连接命令（device 子命令只有 list/view/file/sqlite3），
  // 所以这里直接调用 SDK 自带的 hdc。hdc 位置按 devecocli 自身的解析顺序推导：
  // DEVECO_SDK_HOME → DEVECO_HOME → 已配置/已发现的 Studio|CLT → PATH。

  _resolveHdcPath() {
    const extraRoots = [];
    // Configured paths come FIRST: when devecocli is on PATH the resolver sets
    // source='devecocli' and drops `path`, so a custom Studio/CLT install
    // (e.g. D:\Application\Huawei\DevEco Studio) would otherwise never be
    // probed for its SDK-bundled hdc — breaking the DevEco tree / dump / IP
    // connect fallbacks even though the user configured the path.
    const cfg = this._getConfigSource() || {};
    if (typeof cfg.studioPath === "string" && cfg.studioPath) extraRoots.push(cfg.studioPath);
    if (typeof cfg.cltPath === "string" && cfg.cltPath) extraRoots.push(cfg.cltPath);
    const disc = this._discovery;
    if (disc && Array.isArray(disc.studios)) {
      for (const s of disc.studios) {
        if (s && typeof s.path === "string" && s.path) extraRoots.push(s.path);
      }
    }
    if (disc && Array.isArray(disc.clts)) {
      for (const c of disc.clts) {
        if (c && typeof c.path === "string" && c.path) extraRoots.push(c.path);
      }
    }
    return resolveHdc(this._resolved, { extraRoots });
  }

  _parseIpRequest(request) {
    const ip = (request && typeof request.ip === "string") ? request.ip.trim() : "";
    if (!ip) return err("invalid-request", "ip required");
    // HarmonyOS hdc has no default TCP port — port is mandatory and must
    // match the debug port the device exposes after enabling debugging in
    // 设置 → 开发者选项.
    const raw = request ? request.port : undefined;
    if (raw === undefined || raw === null || raw === "") {
      return err("invalid-request", "port required（hdc 无默认端口，请填写设备开启调试时使用的端口）");
    }
    const p = Number(raw);
    if (!Number.isFinite(p) || p <= 0 || p > 65535) {
      return err("invalid-request", "port must be an integer in 1..65535");
    }
    const port = Math.floor(p);
    return ok({ ip, port, address: `${ip}:${port}` });
  }

  /**
   * Run an hdc invocation, normalizing the exit-0-with-`[Fail]` quirk into the
   * standard error envelope. Success yields ok(<display message>).
   */
  async _runHdc(hdc, args) {
    let stdout = "";
    let stderr = "";
    try {
      const r = await execHdc(hdc, args, { timeout: 15000 });
      stdout = r.stdout || "";
      stderr = r.stderr || "";
    } catch (e) {
      stdout = (e && e.stdout) || "";
      stderr = (e && e.stderr) || "";
      const parsed = parseTconnResult(`${stdout}\n${stderr}`);
      if (parsed.ok) return ok(parsed.message);
      // hdc tconn to an unreachable host hangs until our timeout kills it, and
      // a killed process yields no output at all — say so instead of "无输出".
      if (e && e.timedOut) {
        return err("hdc-timeout", "连接超时（15s）：设备不可达或端口不正确。请确认设备与本机同网段、设备已开启调试，且端口填写正确。");
      }
      const fallback = (e && e.message) ? e.message : String(e);
      return err("hdc-failed", parsed.message || fallback);
    }
    const parsed = parseTconnResult(`${stdout}\n${stderr}`);
    if (!parsed.ok) return err("hdc-failed", parsed.message || "hdc 操作失败");
    return ok(parsed.message);
  }

  /**
   * Connect a device over TCP/IP: `hdc tconn <ip>:<port>`.
   * The device must already have debugging enabled (设置 → 开发者选项 on
   * HarmonyOS). hdc has no default port — `port` is mandatory and must match
   * the debug port the device exposes.
   */
  async deviceConnectIp(request) {
    const parsed = this._parseIpRequest(request);
    if (parsed.ok === false) return parsed;
    const hdc = this._resolveHdcPath();
    if (!hdc) {
      return err("no-hdc", "未找到 hdc 可执行文件（IP 连接依赖 SDK 自带的 hdc：请先配置 Studio/CLT 路径，或将 hdc 加入 PATH）");
    }
    const out = await this._runHdc(hdc, buildHdcConnectArgs(parsed.value));
    if (out.ok === false) return out;
    return ok({
      address: parsed.value.address,
      connected: true,
      message: out.value,
      hdc,
    });
  }

  /** Disconnect a TCP device target: `hdc tconn <ip>:<port> -remove`. */
  async deviceDisconnectIp(request) {
    const parsed = this._parseIpRequest(request);
    if (parsed.ok === false) return parsed;
    const hdc = this._resolveHdcPath();
    if (!hdc) {
      return err("no-hdc", "未找到 hdc 可执行文件（IP 连接依赖 SDK 自带的 hdc：请先配置 Studio/CLT 路径，或将 hdc 加入 PATH）");
    }
    const out = await this._runHdc(hdc, buildHdcDisconnectArgs(parsed.value));
    if (out.ok === false) return out;
    return ok({
      address: parsed.value.address,
      disconnected: true,
      message: out.value,
      hdc,
    });
  }

  /**
   * Resolve the PIDs of a bundle's processes on the device (`hdc shell ps -ef`
   * + host-side exact-match parse). HiLog lines carry no bundle name (only a
   * pid), so the client-side real-time bundle filter needs this mapping — it
   * lets the UI filter by bundle WITHOUT restarting the log stream.
   */
  async deviceProcessPids(request) {
    const bundle = request && typeof request.bundle === "string" ? request.bundle.trim() : "";
    if (!bundle) return err("invalid-request", "bundle required");
    const hdc = this._resolveHdcPath();
    if (!hdc) {
      return err("no-hdc", "未找到 hdc 可执行文件（包名过滤依赖 SDK 自带的 hdc：请先配置 Studio/CLT 路径，或将 hdc 加入 PATH）");
    }
    const targs = request && request.device ? ["-t", String(request.device)] : [];
    try {
      const r = await execHdc(hdc, [...targs, "shell", "ps -ef"], { timeout: 10000 });
      const pids = parseProcessPids(`${r.stdout || ""}\n${r.stderr || ""}`, bundle);
      return ok({ bundle, pids });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      return err("hdc-failed", `读取设备进程列表失败：${msg}`);
    }
  }

  // ---- HiLog ---------------------------------------------------------------

  /** Normalize raw HiLog text into wire lines (parsed records or `{raw}`). */
  _parseHilogText(text) {
    const lines = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line || !line.trim()) continue;
      const parsed = parseHilogLine(line);
      if (parsed) {
        lines.push({
          timestamp: parsed.timestamp,
          pid: parsed.pid,
          tid: parsed.tid,
          level: parsed.level,
          domain: parsed.domain,
          tag: parsed.tag,
          message: parsed.message,
        });
      } else {
        // Unparseable lines (banner / separators) still flow through so the
        // UI can decide to render or drop them.
        lines.push({ raw: line.trim() });
      }
    }
    return lines;
  }

  async hilogList(request) {
    const level = request && request.level;
    if (this._cliExec()) {
      const opts = {
        device: request && request.device,
        level,
        bundle: request && request.bundle,
        keyword: request && request.keyword,
        tail: request && request.tail,
        from: request && request.from,
        to: request && request.to,
      };
      const r = await this._execOrErr(buildHilogArgs(opts), { timeout: 30000 });
      if (r.ok === false) return r;
      return ok({ lines: this._parseHilogText((r.value && r.value.stdout) || "") });
    }
    // hdc fallback: `hilog -x` dumps the buffer and exits — the same snapshot
    // command DevEco CLI uses. `--tail` / `--from` / `--to` are devecocli-only
    // conveniences; tail is applied host-side and the others are ignored.
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    const out = await this._hdcRun(
      buildHdcHilogArgs({
        device: request && request.device,
        level: typeof level === "string" && /^[DIWEF]$/.test(level) ? level : undefined,
        keyword: request && request.keyword,
      }),
      30000
    );
    if (!out.ok) {
      return err((out.error && out.error.code) || "hdc-failed", (out.error && out.error.message) || "读取 hilog 失败");
    }
    const text = `${out.stdout || ""}\n${out.stderr || ""}`;
    if (/\[Fail\]/i.test(text)) return err("hdc-failed", text.trim());
    let lines = this._parseHilogText(out.stdout || "");
    const tail = request && Number.isFinite(Number(request.tail))
      ? Math.max(1, Math.floor(Number(request.tail)))
      : 500;
    if (lines.length > tail) lines = lines.slice(lines.length - tail);
    return ok({ lines });
  }

  async hilogStreamStart(request) {
    // Prefer devecocli (richer formatting) but degrade to `hdc shell hilog`
    // when the separate CLI is not installed. The client already filters
    // keyword / bundle / level in the view, so the hdc stream only needs the
    // device target — no filter snapshot that could starve the buffer.
    const cli = this._cliExec();
    const hdc = cli ? null : this._resolveHdcPath();
    if (!cli && !hdc) return this._toolchainError();

    const opts = {
      device: request && request.device,
      level: request && request.level,
      bundle: request && request.bundle,
      keyword: request && request.keyword,
    };
    const cmd = cli || hdc;
    const argv = cli ? buildHilogFollowArgs(opts) : buildHdcHilogFollowArgs({ device: opts.device });
    const useShell = !!cli && process.platform === "win32";

    const streamId = randomUUID();
    let child;
    try {
      // cmd.exe cannot resolve an unquoted executable path containing spaces
      // (e.g. "…\DevEco Studio\…") — quote a shell-launched .cmd shim.
      const file = useShell ? `"${cmd}"` : cmd;
      child = spawn(file, argv, {
        shell: useShell,
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      return err("cli-failed", "spawn failed: " + (e && e.message ? e.message : String(e)));
    }

    const stream = { child, buffer: [], closed: false, source: cli ? "devecocli" : "hdc", parsedLines: 0 };
    this._streams.set(streamId, stream);

    // Keep a small raw tail of both pipes so a connect failure (`[Fail]…`,
    // exit 0) can be surfaced after close — otherwise the UI waits forever on
    // "等待日志…" for a stream that never produced a single log line.
    let rawTail = "";
    const rememberRaw = (text) => {
      if (rawTail.length < 4000) rawTail += text;
    };

    child.stdout.on("data", (d) => {
      const text = d.toString("utf8");
      rememberRaw(text);
      // `[Fail]…` is an hdc connect error, not a log line — keep it out of the
      // buffer (it is surfaced through `stream.error` on close instead).
      const parsed = this._parseHilogText(text)
        .filter((l) => !(l && typeof l.raw === "string" && l.raw.startsWith("[Fail]")));
      if (parsed.length) {
        stream.parsedLines += parsed.filter((l) => l.level).length;
        stream.buffer.push(...parsed);
        // Bound the buffer to 5000 entries so an unattended stream cannot grow
        // unbounded and OOM the Host process.
        if (stream.buffer.length > 5000) {
          stream.buffer.splice(0, stream.buffer.length - 5000);
        }
      }
    });

    // `hilog` occasionally emits progress notifications on stderr; keep the
    // raw tail only (no UI output).
    child.stderr.on("data", (d) => { rememberRaw(d.toString("utf8")); });

    child.on("close", () => {
      stream.closed = true;
      if (!stream.error && stream.parsedLines === 0) {
        const fail = /\[Fail\][^\r\n]*/i.exec(rawTail);
        stream.error = fail ? fail[0].trim() : (rawTail.trim() || `${cli ? "devecocli log" : "hdc shell hilog"} 未产出日志`);
      }
    });
    child.on("error", (e) => {
      stream.closed = true;
      stream.error = (e && e.message) ? e.message : String(e);
    });

    return ok({ streamId });
  }

  async hilogStreamRead(request) {
    const sid = request && request.streamId;
    const stream = this._streams.get(sid);
    if (!stream) return err("stream-not-found", "stream not found: " + sid);
    const max = (request && Number.isFinite(Number(request.maxLines))) ? Math.max(1, Math.floor(Number(request.maxLines))) : 200;
    const lines = stream.buffer.splice(0, max);
    const out = { lines, closed: !!stream.closed };
    if (typeof stream.error === "string") out.error = stream.error;
    return ok(out);
  }

  async hilogStreamStop(request) {
    const sid = request && request.streamId;
    const stream = this._streams.get(sid);
    if (!stream) return err("stream-not-found", "stream not found: " + sid);
    try { stream.child.kill(); } catch (_) { /* */ }
    this._streams.delete(sid);
    return ok({ stopped: true });
  }

  // ---- ArkUI Inspector -----------------------------------------------------

  /**
   * Dump the ArkUI tree via the device-side `uitest dumpLayout` (through hdc)
   * so the payload keeps `origBounds` — the true layout rect — which
   * `devecocli ui layout` filters out and whose `bounds` counterpart is merely
   * the visible (clipped/occluded) rect. Falls back to the devecocli dump when
   * hdc is unavailable, so the Inspector still works without an SDK hdc.
   *
   * @param {string|undefined} device Serial/name forwarded to uitest via hdc.
   * @returns {Promise<Array<object>|null>} flat nodes, or null when unavailable.
   */
  async _dumpUiViaHdc(device) {
    const hdc = this._resolveHdcPath();
    if (!hdc) return null;
    const devicePath = `/data/local/tmp/dsh-deveco-${randomUUID()}.json`;
    const localPath = join(tmpdir(), `dsh-deveco-${randomUUID()}.json`);
    const cleanup = async () => {
      try { await unlink(localPath); } catch (_) { /* best effort */ }
      try { await execHdc(hdc, buildUiRawCleanArgs(devicePath), { timeout: 8000 }); } catch (_) { /* best effort */ }
    };
    try {
      // `-i` keeps windows unmerged so each node's hostWindowId is preserved.
      const args = buildUiRawDumpArgs(devicePath, { all: true });
      const argv = device ? ["-t", device, ...args] : args;
      const dumped = await execHdc(hdc, argv, { timeout: 30000 });
      const text = `${dumped.stdout || ""}\n${dumped.stderr || ""}`;
      // hdc exits 0 even on failure; the only reliable success marker is the
      // device-side line. Anything else (no target, unsupported command) → the
      // caller falls back to the devecocli dump.
      if (!/DumpLayout saved/i.test(text)) return null;
      const recvArgv = device
        ? ["-t", device, ...buildUiRawRecvArgs(devicePath, localPath)]
        : buildUiRawRecvArgs(devicePath, localPath);
      await execHdc(hdc, recvArgv, { timeout: 30000 });
      const json = await readFile(localPath, "utf8");
      const nodes = parseUiRawDump(json);
      return nodes.length ? nodes : null;
    } catch (_) {
      return null;
    } finally {
      await cleanup();
    }
  }

  /**
   * Dump the ArkUI tree. `windowId` restricts the dump to one window
   * (`--window`); `allWindows` asks for every window (`--all-windows`) and is
   * mutually exclusive with it. Nodes carry their owning `windowId` so the
   * client can switch windows without re-dumping.
   */
  async uiDump(request) {
    const device = request && typeof request.device === "string" && request.device ? request.device : undefined;
    let nodes = await this._dumpUiViaHdc(device);
    if (!nodes) {
      // No devecocli → there is no second tree source: report the failure
      // honestly instead of pretending the toolchain is missing.
      if (!this._cliExec()) {
        if (!this._resolveHdcPath()) return this._toolchainError();
        return err(
          "dump-failed",
          "uitest dumpLayout 未返回布局（设备未连接 / 当前无 UI / 目标应用不可见）；"
          + "未安装 devecocli，无法回退到 devecocli ui layout。"
        );
      }
      // Fallback: the devecocli dump (no origBounds, but it still works).
      const opts = {
        device: request && request.device,
        windowId: request && request.windowId,
        allWindows: request ? request.allWindows === true : false,
      };
      const args = buildUiDumpArgs(opts);
      const r = await this._execOrErr(args, { timeout: 30000 });
      if (r.ok === false) return r;
      try {
        nodes = parseUiLayoutJson((r.value && r.value.stdout) || "");
      } catch (_) {
        nodes = [];
      }
    }
    // 按窗口过滤：指定 windowId 用它；否则只保留**前台窗口**——全部窗口节点数量
    // 太多会让 UI 卡顿（用户要求）。`allWindows: true` 保留为逃生舱（不做过滤）。
    const wantId = request && request.windowId;
    const allWindows = request ? request.allWindows === true : false;
    if (!allWindows) {
      if (wantId !== undefined && wantId !== null && wantId !== "") {
        nodes = nodes.filter((n) => String(n.windowId) === String(wantId));
      } else {
        const r = await this.uiWindowList({ device, all: true });
        const focused = r.ok && r.value && Array.isArray(r.value.windows)
          ? (r.value.windows.find((w) => w.focused) || r.value.windows[0])
          : null;
        if (focused) nodes = nodes.filter((n) => String(n.windowId) === String(focused.id));
      }
    }
    return ok({ nodes });
  }

  /**
   * List the device's UI windows (`devecocli ui window list`). Each entry is
   * `{ id, name, pid, displayId, focused }`; the `id` is what `ui layout
   * --window <id>` and a layout node's `WindowScene` (`session<id>`) use.
   */
  async uiWindowList(request) {
    const all = request ? request.all === true : false;
    if (this._cliExec()) {
      const opts = {
        device: request && request.device,
        // System windows (status bar, gesture bar) are excluded by default, which
        // is what an inspector wants; the client can opt into `--all`.
        all,
      };
      const args = buildUiWindowListArgs(opts);
      const r = await this._execOrErr(args, { timeout: 15000 });
      if (r.ok === false) return r;
      let windows = [];
      try {
        windows = parseUiWindowListJson((r.value && r.value.stdout) || "");
      } catch (_) {
        windows = [];
      }
      return ok({ windows });
    }
    // hdc fallback: `hidumper -s WindowManagerService -a -a`, the same dump
    // DevEco CLI parses for `ui window list`. Without this the Inspector's
    // window dropdown stays empty and the client (which filters nodes by the
    // selected window id) renders an empty tree even when the dump succeeded.
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    const out = await this._hdcRun(
      [...this._hdcTargetArgs(request && request.device), ...buildHdcWindowListArgs()],
      15000
    );
    if (!out.ok) {
      return err((out.error && out.error.code) || "hdc-failed", (out.error && out.error.message) || "读取窗口列表失败");
    }
    const text = `${out.stdout || ""}\n${out.stderr || ""}`;
    if (/\[Fail\]/i.test(text)) return err("hdc-failed", text.trim() || "读取窗口列表失败");
    let windows = parseWindowManagerDump(out.stdout || "");
    // `type` is a local parse field (1 = app window); the wire schema has no
    // type, so drop it after the app-window filter.
    if (!all) windows = windows.filter((w) => w.type === 1);
    return ok({
      windows: windows.map((w) => ({
        id: w.id,
        name: w.name,
        pid: w.pid,
        displayId: w.displayId,
        focused: w.focused,
      })),
    });
  }

  /**
   * **DevEco 开发调试源**：走应用侧 inspector socket 拿真正的组件树
   * （反编译 `layout-inspector-server` 还原的链路）：
   * `hdc fport tcp:<本机> ark:<pid>@<pkg>` → `ws://127.0.0.1:<本机>`（裸 socket
   * 极简握手）→ `{"type":"connected"}` → `{"type":"inspectorAbilities"}` →
   * `{"type":"tree"}` → 收 `{"type":"root"}` → `parseDevEcoTree`。
   *
   * 与 uitest dump 的关键差别：这条源**能拿到 `$attrs.margin/padding/border`
   * 声明值**和 **`viewTag`/`$attrs.label` 组件/Builder 名**（`$type:"JsView"` /
   * `type:"custom"|"build-in"` 还能权威判定自定义组件），dump 里都没有。
   *
   * 前置条件：应用为 debug 包且已 `aa attach -b <pkg>`（本方法自动执行）；
   * DevEco Studio 的 Inspector 面板开着会占用应用侧唯一连接，需先关掉。
   *
   * 返回 `{ nodes, source, pid, packageName }`（rich，供 Remote 与 agent 工具共用）。
   */
  async _fetchDevEcoTree(request) {
    const hdc = this._resolveHdcPath();
    if (!hdc) return err("no-hdc", "未找到 hdc 可执行文件（DevEco 开发调试源依赖 SDK 自带的 hdc）");
    const device = request && typeof request.device === "string" && request.device ? request.device : undefined;
    const targs = device ? ["-t", device] : [];

    // 1) 解析 pid + 包名（DevEco 从 hdclib 的 DebugClient 拿；我们用 pid + /proc/<pid>/cmdline）
    let pid = request && request.pid ? String(request.pid) : "";
    let packageName = request && typeof request.packageName === "string" && request.packageName ? request.packageName : "";
    if (!pid) {
      const r = await this.uiWindowList({ device, all: true });
      const wins = (r.ok && r.value && Array.isArray(r.value.windows)) ? r.value.windows : [];
      const w = wins.find((x) => x.focused) || wins[0];
      if (!w || !w.pid) return err("no-pid", "找不到前台窗口的 pid（请先打开要调试的应用）");
      pid = String(w.pid);
    }
    if (!packageName) {
      const out = await execHdc(hdc, [...targs, "shell", `cat /proc/${pid}/cmdline`], { timeout: 10000 }).catch(() => null);
      packageName = String((out && `${out.stdout || ""}`) || "").replace(/\0/g, "").trim().split(/\r?\n/)[0].trim();
    }
    if (!packageName) return err("no-package", `无法从 /proc/${pid}/cmdline 解析应用包名`);

    // 2) `aa attach` —— DevEco 每次连 inspector 前都执行（反编译 closeAppfreeze），
    //    把应用绑定到调试模式并武装应用侧 inspector 服务。已绑定时幂等（不会重启应用）。
    await execHdc(hdc, [...targs, "shell", `aa attach -b ${packageName}`], { timeout: 10000 })
      .catch(() => { /* 某些版本不支持时忽略，靠后面的错误信息兜底 */ });

    // 3) 本机空闲端口 + 建立端口转发（新协议 ark:<pid>@<pkg>，失败退回旧协议 localabstract:）
    const localPort = await pickFreePort();
    const attempts = [
      { args: buildArkForwardArgs(localPort, pid, packageName), node: `ark:${pid}@${packageName}` },
      { args: buildLocalAbstractForwardArgs(localPort, pid, "", packageName), node: `localabstract:${pid}${packageName}` },
    ];
    let forwarded = null;
    for (const a of attempts) {
      const r = await execHdc(hdc, [...targs, ...a.args], { timeout: 15000 }).catch((e) => ({ stdout: "", stderr: e.message }));
      const text = `${(r && r.stdout) || ""}${(r && r.stderr) || ""}`;
      if (/forwardport result:\s*ok|^\s*ok\s*$/i.test(text.trim())) { forwarded = { ...a }; break; }
    }
    if (!forwarded) {
      return err("forward-failed", `hdc fport 建立转发失败（试过 ark:${pid}@${packageName} 与 localabstract: 变体）`);
    }

    // 3) 连 WS → 收 root → 解析；无论成败都解除转发
    try {
      const root = await devEcoWsRequestTree(localPort);
      const nodes = parseDevEcoTree(root);
      if (!nodes.length) return err("empty-tree", "应用回了 root 但解析不到节点");
      return ok({ nodes, source: "deveco", pid: Number(pid) || 0, packageName });
    } catch (e) {
      return err(
        "no-inspector-socket",
        `连不上应用的 ArkUI 调试 socket（${forwarded.node}）：${e.message}。`
        + ` 前置条件：① 应用是 debug 包（或 debuggable）；② 已执行 aa attach -b ${packageName}（本方法已自动执行）；`
        + ` ③ 若 DevEco Studio 的 ArkUI Inspector 面板开着，请先关掉它——应用侧 socket 单客户端，会被 IDE 占用。`
      );
    } finally {
      await execHdc(hdc, [...targs, ...buildForwardRemoveArgs(localPort, forwarded.node)], { timeout: 10000 }).catch(() => {});
    }
  }

  /**
   * Remote 面（`uiDevEcoTree`）：严格按 TYPERT 契约返回 `{ nodes, source }`。
   * agent 工具面走 `_fetchDevEcoTree` 拿 rich 结果（含 pid/packageName）。
   */
  async uiDevEcoTree(request) {
    const r = await this._fetchDevEcoTree(request);
    if (!r.ok) return r;
    return ok({ nodes: r.value.nodes, source: r.value.source });
  }

  /**
   * Read a captured screenshot back into the wire shape. The client renders
   * the inline data URL and needs the pixel size for overlay scaling; the file
   * is size-capped so a huge screen cannot blow up the Remote payload.
   */
  async _screenshotWire(absPath, stdout, stderr) {
    const MAX_INLINE_BYTES = 4 * 1024 * 1024;
    let dataUrl = "";
    let imageWidth = 0;
    let imageHeight = 0;
    let byteSize = 0;
    try {
      const buf = await readFile(absPath);
      byteSize = buf.length;
      if (byteSize <= MAX_INLINE_BYTES) {
        const mime = (buf[0] === 0xFF && buf[1] === 0xD8) ? "image/jpeg" : "image/png";
        dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        const size = readPngSize(buf);
        if (size) {
          imageWidth = size.width;
          imageHeight = size.height;
        }
      }
    } catch (_) {
      // Screenshot file missing/unreadable — still report savedTo; the client
      // falls back to the path hint.
    }
    return ok({ savedTo: absPath, stdout: stdout || "", stderr: stderr || "", dataUrl, imageWidth, imageHeight, byteSize });
  }

  async uiScreenshot(request) {
    const outPath = (request && typeof request.outPath === "string") ? request.outPath : "";
    if (!outPath) return err("invalid-request", "outPath required");
    // Expand a leading `~/` (the client composes `~/.dsh/...`) and make sure the
    // parent directory exists — both devecocli and `hdc file recv` write to
    // this exact path and will not create intermediate directories.
    let absPath = outPath;
    if (absPath.startsWith("~/")) absPath = join(homedir(), absPath.slice(2));
    try {
      await mkdir(dirname(absPath), { recursive: true });
    } catch (_) { /* best effort */ }

    if (this._cliExec()) {
      const argv = buildUiScreenshotArgs({ device: request && request.device, path: absPath });
      try {
        const r = await execCli(this._resolved, argv, { timeout: 30000 });
        return this._screenshotWire(absPath, r.stdout, r.stderr);
      } catch (e) {
        return err("cli-failed", (e && e.message) ? e.message : String(e));
      }
    }

    // hdc fallback: `uitest screenCap` first, then `snapshot_display` — the
    // exact pair DevEco CLI tries — pulled back with `hdc file recv`.
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    const devicePath = `/data/local/tmp/dsh-deveco-shot-${randomUUID()}.png`;
    const targs = this._hdcTargetArgs(request && request.device);
    let notes = "";
    try {
      for (const capture of [buildHdcScreenCapArgs, buildHdcSnapshotDisplayArgs]) {
        const cap = await this._hdcRun([...targs, ...capture(devicePath)], 20000);
        const capText = `${cap.stdout || ""}${cap.stderr || ""}`;
        notes += capText;
        // Per-attempt check: `[Fail]` from the first command must not poison
        // the second attempt.
        if (!cap.ok || capText.includes("[Fail]")) continue;
        const recv = await this._hdcRun([...targs, ...buildHdcFileRecvArgs(devicePath, absPath)], 30000);
        const recvText = `${recv.stdout || ""}${recv.stderr || ""}`;
        notes += recvText;
        if (recv.ok && !recvText.includes("[Fail]")) return this._screenshotWire(absPath, notes, "");
      }
      return err("screenshot-failed", notes.trim() || "设备截图失败（uitest screenCap / snapshot_display 均不可用）");
    } finally {
      await this._hdcRun([...targs, ...buildHdcFileRemoveArgs(devicePath)], 8000);
    }
  }

  /** Run one hdc UI action, normalizing `[Fail]`-with-exit-0 into an error. */
  async _hdcActionOk(argv, timeout, label) {
    const out = await this._hdcRun(argv, timeout);
    if (!out.ok) {
      return err((out.error && out.error.code) || "hdc-failed", (out.error && out.error.message) || `${label} 失败`);
    }
    const text = `${out.stdout || ""}\n${out.stderr || ""}`;
    if (text.includes("[Fail]")) return err("hdc-failed", text.trim() || `${label} 失败`);
    return ok({ stdout: out.stdout || "", stderr: out.stderr || "", code: 0 });
  }

  async uiTap(request) {
    const x = Number(request && request.x);
    const y = Number(request && request.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return err("invalid-request", "x, y must be finite numbers");
    }
    if (this._cliExec()) {
      return this._execOrErr(
        buildUiTapArgs({ device: request && request.device, x, y }),
        { timeout: 10000 }
      );
    }
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    return this._hdcActionOk(
      [...this._hdcTargetArgs(request && request.device), ...buildHdcTapArgs({ x, y })],
      10000,
      "tap"
    );
  }

  async uiSwipe(request) {
    const x1 = Number(request && request.x1);
    const y1 = Number(request && request.y1);
    const x2 = Number(request && request.x2);
    const y2 = Number(request && request.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      return err("invalid-request", "x1, y1, x2, y2 must be finite numbers");
    }
    if (this._cliExec()) {
      const argv = buildUiSwipeArgs({
        device: request && request.device,
        x1, y1, x2, y2,
        speed: request && request.speed,
      });
      return this._execOrErr(argv, { timeout: 15000 });
    }
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    return this._hdcActionOk(
      [...this._hdcTargetArgs(request && request.device),
        ...buildHdcSwipeArgs({ x1, y1, x2, y2, speed: request && request.speed })],
      15000,
      "swipe"
    );
  }

  async uiText(request) {
    const text = (request && typeof request.text === "string") ? request.text : "";
    if (!text) return err("invalid-request", "text required");
    if (this._cliExec()) {
      return this._execOrErr(
        buildUiTextArgs({ device: request && request.device, text }),
        { timeout: 10000 }
      );
    }
    const hdc = this._resolveHdcPath();
    if (!hdc) return this._toolchainError();
    return this._hdcActionOk(
      [...this._hdcTargetArgs(request && request.device), ...buildHdcTextArgs({ text })],
      10000,
      "text"
    );
  }

  // ---- project browser -----------------------------------------------------

  /**
   * List HarmonyOS projects visible to the plugin.
   *
   * Conservative v1: returns an empty array. The full implementation will scan
   * the current workspace root for `oh-package.json5` / `build-profile.json5`
   * and aggregate module lists, but that needs a workspaceRegistry contract
   * we don't depend on yet. Returning `{projects: []}` keeps the wire stable.
   */
  async listProjects() {
    return ok({ projects: [] });
  }
}

export default HarmonyDevEcoService;