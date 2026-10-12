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
  devEcoNodeSummary,
  devEcoTreeLines,
  buildHdcConnectArgs,
  buildHdcDisconnectArgs,
  parseHilogLine,
  parseUiLayoutJson,
  parseUiRawDump,
  parseUiWindowListJson,
  parseTconnResult,
  readPngSize,
} from "./harmony-device.mjs";

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

/** Owned wire object — converts a resolved toolchain record into JSON-safe form. */
function toResolvedWire(resolved) {
  if (!resolved) {
    return {
      source: "none",
      minVersionOk: false,
      message: "未配置工具链",
    };
  }
  const wire = {
    source: resolved.source || "none",
    minVersionOk: !!resolved.minVersionOk,
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
 * Parse `devecocli device list` output.
 *
 * Preferred input is `--format json`:
 *   [ { "name": "HUAWEI Mate 70", "serial": "55K0...", "kind": "device", "deviceType": "phone" } ]
 *
 * Fallback: the human table layout (column order is Name, Serial, Kind, Type —
 * NOT serial-first), which looks like:
 *   - Querying connected devices…      ← spinner line, skipped
 *   Name            Serial            Kind    Device Type
 *   --------------  ----------------  ------  -----------
 *   HUAWEI Mate 70  55K0225509025604  device  phone
 *
 * Returns an array of `{serial, name, state, type}`; skips spinner, header and
 * separator rows. Falls back to a single-column interpretation so the UI still
 * gets a usable list on unexpected layouts.
 */
function parseDeviceList(stdout) {
  if (!stdout) return [];
  const text = String(stdout).trim();
  // JSON fast-path (`device list --format json`).
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        return arr
          .filter((d) => d && typeof d === "object" && d.serial)
          .map((d) => ({
            serial: String(d.serial),
            name: typeof d.name === "string" ? d.name : "",
            state: typeof d.kind === "string" ? d.kind : "",
            type: typeof d.deviceType === "string" ? d.deviceType : "",
          }));
      }
    } catch (_) { /* fall through to table parsing */ }
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^[-\\|/]\s/.test(line)) continue;          // spinner/progress rows
    if (/^[-=\s]+$/.test(line)) continue;           // separator rows (incl. spaced dashes)
    if (/^Name\s+Serial/i.test(line)) continue;     // header (new CLI)
    if (/^Device\s+ID/i.test(line)) continue;       // header (legacy CLI)
    const cols = line.split(/\s{2,}|\t+/).filter((c) => c !== "");
    if (cols.length === 0) continue;
    if (cols.length >= 2) {
      // Real table order: Name, Serial, Kind, Device Type.
      out.push({
        serial: cols[1],
        name: cols[0],
        state: cols[2] || "",
        type: cols[3] || "",
      });
    } else {
      out.push({ serial: cols[0], name: "", state: "", type: "" });
    }
  }
  return out.filter((d) => d.serial);
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
    markRemoteMethod(this, "hilogList", "hilogList");
    markRemoteMethod(this, "hilogStreamStart", "hilogStreamStart");
    markRemoteMethod(this, "hilogStreamRead", "hilogStreamRead");
    markRemoteMethod(this, "hilogStreamStop", "hilogStreamStop");
    markRemoteMethod(this, "uiDump", "uiDump");
    markRemoteMethod(this, "uiWindowList", "uiWindowList");
    markRemoteMethod(this, "uiScreenshot", "uiScreenshot");
    markRemoteMethod(this, "uiTap", "uiTap");
    markRemoteMethod(this, "uiSwipe", "uiSwipe");
    markRemoteMethod(this, "uiText", "uiText");
    markRemoteMethod(this, "listProjects", "listProjects");
    markRemoteMethod(this, "readTextFile", "readTextFile");


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

  /** True when the toolchain is unusable (no source or clt below min). */
  _isToolchainBroken() {
    if (!this._resolved) return true;
    if (this._resolved.source === "none") return true;
    return false;
  }

  /**
   * Run an exec via execCli, normalizing failures to the standard error
   * envelope. The success envelope wraps `{stdout, stderr, code}` exactly as
   * execCli returns it; callers shape it into their own payload.
   *
   * devecocli quirk: it prints `error: ...` yet still exits 0, so non-zero
   * exit alone can't detect failures — we also treat a leading `error:` line
   * in stdout/stderr as a failure.
   */
  async _execOrErr(args, opts) {
    if (this._isToolchainBroken()) {
      return err("no-toolchain", (this._resolved && this._resolved.message) || "未配置工具链");
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

  // ---- config / discovery --------------------------------------------------

  async getConfig() {
    const c = this._getConfigSource() || { studioPath: "", cltPath: "" };
    return ok({
      config: toConfigWire(c),
      resolved: toResolvedWire(this._resolved),
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
    return ok({ config: toConfigWire(this._config), resolved: toResolvedWire(this._resolved) });
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
    return ok({ config: toConfigWire(this._config), resolved: toResolvedWire(this._resolved) });
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

  async deviceInfo(request) {
    const device = (request && typeof request.device === "string") ? request.device : "";
    if (!device) return err("invalid-request", "device required");
    const r = await this._execOrErr(["device", "view", "-t", device], { timeout: 15000 });
    if (r.ok === false) return r;
    // devecocli device view prints key/value pairs; the client just gets the
    // raw text plus the parsed stdout/stderr/code so it can render whatever.
    const stdout = (r.value && r.value.stdout) || "";
    const stderr = (r.value && r.value.stderr) || "";
    return ok({ info: { serial: device, stdout, stderr, code: r.value ? r.value.code : 0 } });
  }

  // ---- IP 网络连接（hdc tconn） ---------------------------------------------
  // devecocli 没有 IP/TCP 连接命令（device 子命令只有 list/view/file/sqlite3），
  // 所以这里直接调用 SDK 自带的 hdc。hdc 位置按 devecocli 自身的解析顺序推导：
  // DEVECO_SDK_HOME → DEVECO_HOME → 已配置/已发现的 Studio|CLT → PATH。

  _resolveHdcPath() {
    const extraRoots = [];
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

  // ---- HiLog ---------------------------------------------------------------

  async hilogList(request) {
    const opts = {
      device: request && request.device,
      level: request && request.level,
      bundle: request && request.bundle,
      keyword: request && request.keyword,
      tail: request && request.tail,
      from: request && request.from,
      to: request && request.to,
    };
    const args = buildHilogArgs(opts);
    const r = await this._execOrErr(args, { timeout: 30000 });
    if (r.ok === false) return r;
    const lines = [];
    const raw = (r.value && r.value.stdout) || "";
    for (const line of raw.split(/\r?\n/)) {
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
    return ok({ lines });
  }

  async hilogStreamStart(request) {
    if (this._isToolchainBroken()) {
      return err("no-toolchain", (this._resolved && this._resolved.message) || "未配置工具链");
    }
    const cmd = devecoExec(this._resolved);
    if (!cmd) return err("no-toolchain", "no usable devecocli executable");

    const opts = {
      device: request && request.device,
      level: request && request.level,
      bundle: request && request.bundle,
      keyword: request && request.keyword,
    };
    const argv = buildHilogFollowArgs(opts);

    const streamId = randomUUID();
    let child;
    try {
      child = spawn(cmd, argv, {
        shell: process.platform === "win32",
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      return err("cli-failed", "spawn failed: " + (e && e.message ? e.message : String(e)));
    }

    const stream = { child, buffer: [], closed: false };
    this._streams.set(streamId, stream);

    child.stdout.on("data", (d) => {
      const text = d.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line || !line.trim()) continue;
        const parsed = parseHilogLine(line);
        if (parsed) {
          stream.buffer.push({
            timestamp: parsed.timestamp,
            pid: parsed.pid,
            tid: parsed.tid,
            level: parsed.level,
            domain: parsed.domain,
            tag: parsed.tag,
            message: parsed.message,
          });
        } else {
          stream.buffer.push({ raw: line.trim() });
        }
      }
      // Bound the buffer to 5000 entries so an unattended stream cannot grow
      // unbounded and OOM the Host process.
      if (stream.buffer.length > 5000) {
        stream.buffer.splice(0, stream.buffer.length - 5000);
      }
    });

    // Swallow stderr — `hilog` occasionally emits progress notifications.
    child.stderr.on("data", () => { /* */ });

    child.on("close", () => {
      stream.closed = true;
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
    const opts = {
      device: request && request.device,
      // System windows (status bar, gesture bar) are excluded by default, which
      // is what an inspector wants; the client can opt into `--all`.
      all: request ? request.all === true : false,
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

  async uiScreenshot(request) {
    const outPath = (request && typeof request.outPath === "string") ? request.outPath : "";
    if (!outPath) return err("invalid-request", "outPath required");
    if (this._isToolchainBroken()) {
      return err("no-toolchain", (this._resolved && this._resolved.message) || "未配置工具链");
    }
    // Expand a leading `~/` (the client composes `~/.dsh/...`) and make sure the
    // parent directory exists — devecocli writes the PNG straight to this path
    // and will not create intermediate directories.
    let absPath = outPath.replace(/^~(?=[/\\])/, homedir());
    try {
      await mkdir(dirname(absPath), { recursive: true });
    } catch (_) { /* best effort */ }
    const argv = buildUiScreenshotArgs({ device: request && request.device, path: absPath });
    try {
      const r = await execCli(this._resolved, argv, { timeout: 30000 });
      // Read the captured PNG back so the client can render it inline (and know
      // its pixel size for overlay scaling / click→device coordinate mapping).
      // Size-capped so a huge screen shot cannot blow up the Remote payload.
      const MAX_INLINE_BYTES = 4 * 1024 * 1024;
      let dataUrl = "";
      let imageWidth = 0;
      let imageHeight = 0;
      let byteSize = 0;
      try {
        const buf = await readFile(absPath);
        byteSize = buf.length;
        if (byteSize <= MAX_INLINE_BYTES) {
          dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
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
      return ok({ savedTo: absPath, stdout: r.stdout || "", stderr: r.stderr || "", dataUrl, imageWidth, imageHeight, byteSize });
    } catch (e) {
      return err("cli-failed", (e && e.message) ? e.message : String(e));
    }
  }

  async uiTap(request) {
    const x = Number(request && request.x);
    const y = Number(request && request.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return err("invalid-request", "x, y must be finite numbers");
    }
    return this._execOrErr(
      buildUiTapArgs({ device: request && request.device, x, y }),
      { timeout: 10000 }
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
    const argv = buildUiSwipeArgs({
      device: request && request.device,
      x1, y1, x2, y2,
      speed: request && request.speed,
    });
    return this._execOrErr(argv, { timeout: 15000 });
  }

  async uiText(request) {
    const text = (request && typeof request.text === "string") ? request.text : "";
    if (!text) return err("invalid-request", "text required");
    return this._execOrErr(
      buildUiTextArgs({ device: request && request.device, text }),
      { timeout: 10000 }
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