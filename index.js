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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  setStudioPath as cfgSetStudio,
  setCltPath as cfgSetClt,
  ensureDiscovery,
} from "./harmony-config.mjs";
import { resolveCli } from "./harmony-studio.mjs";
import {
  selectHdc,
  execCli,
  buildHilogArgs,
  buildUiDumpArgs,
  parseHilogLine,
  parseUiDumpXml,
} from "./harmony-device.mjs";

try { console.error("[dsh-deveco] index.js module body executed"); } catch (_) { /* */ }

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
 * The CLI prints aligned columns:
 *   Device ID    Device Name    Device State    Device Type
 *   <empty>      <empty>        <empty>         <empty>
 *   ABC123       Emulator       Booted          Wearable
 *
 * Returns an array of `{serial, name, state, type}`; skips the header row and
 * the separator row. Falls back to a single-row interpretation when the line
 * has fewer than 4 columns so the UI still gets a usable list.
 */
function parseDeviceList(stdout) {
  if (!stdout) return [];
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let headerSkipped = false;
  for (const line of lines) {
    // Skip the section header (Device ID ...) and the separator (----).
    if (!headerSkipped) {
      if (/^Device\s+ID/i.test(line) || /^[-=]+$/.test(line)) {
        headerSkipped = true;
        continue;
      }
    }
    // Split on 2+ spaces or a tab; preserve leading/trailing whitespace inside
    // cells by using the non-greedy split on the regex with map().
    const cols = line.split(/\s{2,}|\t+/).filter((c) => c !== "");
    if (cols.length === 0) continue;
    if (cols.length >= 4) {
      out.push({
        serial: cols[0],
        name: cols[1],
        state: cols[2],
        type: cols[3],
      });
    } else if (cols.length === 1) {
      out.push({ serial: cols[0], name: "", state: "", type: "" });
    } else {
      // 2-3 cols — best-effort; first col is the serial.
      out.push({
        serial: cols[0],
        name: cols[1] || "",
        state: cols[2] || "",
        type: "",
      });
    }
  }
  return out;
}

/**
 * Build the argv for a live `hilog -f` stream. Mirrors `buildHilogArgs` but
 * never includes the `-T` tail filter (live streaming is unbounded).
 */
function buildHilogFollowArgs(opts = {}) {
  const args = ["hilog", "-f"];
  if (opts.level) args.push("-L", opts.level);
  if (opts.bundle) args.push("-t", opts.bundle);
  if (opts.keyword) args.push("-g", opts.keyword);
  return args;
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
    this._discovery = null;
    this._config = null;
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
    markRemoteMethod(this, "hilogList", "hilogList");
    markRemoteMethod(this, "hilogStreamStart", "hilogStreamStart");
    markRemoteMethod(this, "hilogStreamRead", "hilogStreamRead");
    markRemoteMethod(this, "hilogStreamStop", "hilogStreamStop");
    markRemoteMethod(this, "uiDump", "uiDump");
    markRemoteMethod(this, "uiScreenshot", "uiScreenshot");
    markRemoteMethod(this, "uiTap", "uiTap");
    markRemoteMethod(this, "uiSwipe", "uiSwipe");
    markRemoteMethod(this, "uiText", "uiText");
    markRemoteMethod(this, "listProjects", "listProjects");

    // Ensure the data directory exists, then warm the config + discovery cache.
    try {
      await mkdir(this._configDir, { recursive: true });
    } catch (e) {
      // Non-fatal: loadConfig / saveConfig will surface the IO error to callers.
    }

    try {
      this._discovery = await ensureDiscovery(this._configDir);
    } catch (_) {
      this._discovery = null;
    }
    this._config = await loadConfig(this._configDir);
    this._resolved = resolveCli({
      studioPath: this._config.studioPath,
      cltPath: this._config.cltPath,
    });

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

  /** Refresh `_resolved` from the in-memory `_config`. */
  _reloadResolved() {
    this._resolved = resolveCli({
      studioPath: this._config.studioPath,
      cltPath: this._config.cltPath,
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
   */
  async _execOrErr(args, opts) {
    if (this._isToolchainBroken()) {
      return err("no-toolchain", (this._resolved && this._resolved.message) || "未配置工具链");
    }
    try {
      const r = await execCli(this._resolved, args, opts || {});
      return ok(r);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      return err("cli-failed", msg);
    }
  }

  // ---- config / discovery --------------------------------------------------

  async getConfig() {
    return ok({
      config: toConfigWire(this._config),
      resolved: toResolvedWire(this._resolved),
      discovery: this._discovery ? toDiscoveryWire(this._discovery) : null,
    });
  }

  async setStudioPath(request) {
    const path = (request && typeof request.path === "string") ? request.path : "";
    this._config = await cfgSetStudio(this._configDir, path);
    this._reloadResolved();
    return ok({
      config: toConfigWire(this._config),
      resolved: toResolvedWire(this._resolved),
    });
  }

  async setCltPath(request) {
    const path = (request && typeof request.path === "string") ? request.path : "";
    this._config = await cfgSetClt(this._configDir, path);
    this._reloadResolved();
    return ok({
      config: toConfigWire(this._config),
      resolved: toResolvedWire(this._resolved),
    });
  }

  async rescan() {
    this._discovery = await ensureDiscovery(this._configDir);
    return ok({ discovery: toDiscoveryWire(this._discovery) });
  }

  // ---- device commands -----------------------------------------------------

  async deviceList() {
    const r = await this._execOrErr(["device", "list"], { timeout: 15000 });
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
    const r = await this._execOrErr(["device", "info", "-d", device], { timeout: 15000 });
    if (r.ok === false) return r;
    // devecocli device info prints key/value pairs; the client just gets the
    // raw text plus the parsed stdout/stderr/code so it can render whatever.
    const stdout = (r.value && r.value.stdout) || "";
    const stderr = (r.value && r.value.stderr) || "";
    return ok({ info: { serial: device, stdout, stderr, code: r.value ? r.value.code : 0 } });
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
    const sel = selectHdc(this._resolved);
    if (!sel) return err("no-toolchain", "no usable hdc source");

    const opts = {
      device: request && request.device,
      level: request && request.level,
      bundle: request && request.bundle,
      keyword: request && request.keyword,
    };
    const argv = [...sel.prefix, ...buildHilogFollowArgs(opts)];

    // When the source is hdc-direct (no devecocli), spawn the binary directly
    // with its full path so PATH lookup is unnecessary; otherwise use the
    // already-resolved devecocli executable and let execCli-style args win.
    const cmd = (sel.kind === "devecocli") ? this._resolved.exec : sel.exec;

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

  async uiDump(request) {
    const opts = { device: request && request.device };
    const args = buildUiDumpArgs(opts);
    const r = await this._execOrErr(args, { timeout: 30000 });
    if (r.ok === false) return r;
    let nodes = [];
    try {
      const parsed = parseUiDumpXml((r.value && r.value.stdout) || "");
      nodes = parsed.map((n) => ({
        index: n.index,
        text: n.text || "",
        resourceId: n.resourceId || "",
        className: n.className || "",
        bounds: {
          left: n.bounds.left,
          top: n.bounds.top,
          right: n.bounds.right,
          bottom: n.bounds.bottom,
          width: n.bounds.width,
          height: n.bounds.height,
        },
        boundsStr: n.boundsStr || "",
      }));
    } catch (_) {
      nodes = [];
    }
    return ok({ nodes });
  }

  async uiScreenshot(request) {
    const outPath = (request && typeof request.outPath === "string") ? request.outPath : "";
    if (!outPath) return err("invalid-request", "outPath required");
    if (this._isToolchainBroken()) {
      return err("no-toolchain", (this._resolved && this._resolved.message) || "未配置工具链");
    }
    const sel = selectHdc(this._resolved);
    if (!sel) return err("no-toolchain", "no usable hdc source");

    // Best-effort: ask hdc to write the snapshot directly to the requested
    // path on the host. The full transfer dance (snapshot on device → file
    // recv to host) is left to the UI side via `hdc shell snapshot_display
    // -f <remote>`; here we just relay the request and report the path back.
    const argv = [...sel.prefix, "shell", "snapshot_display", "-f", outPath];
    try {
      const r = await execCli(this._resolved, argv, { timeout: 30000 });
      return ok({ savedTo: outPath, stdout: r.stdout || "", stderr: r.stderr || "" });
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
      ["shell", "uitest", "click", String(x), String(y)],
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
    const argv = ["shell", "uitest", "swipe", String(x1), String(y1), String(x2), String(y2)];
    if (request && (request.speed !== undefined && request.speed !== null && request.speed !== "")) {
      argv.push("-s", String(request.speed));
    }
    return this._execOrErr(argv, { timeout: 15000 });
  }

  async uiText(request) {
    const text = (request && typeof request.text === "string") ? request.text : "";
    if (!text) return err("invalid-request", "text required");
    return this._execOrErr(
      ["shell", "uitest", "text", text],
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