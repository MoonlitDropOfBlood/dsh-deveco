/**
 * dsh-deveco — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes from
 * the package's `./typert` export). It describes the `harmonyDevEco` Remote
 * service the Host half publishes so the browser Client half can call it
 * through `ctx.remote.harmonyDevEco.{getConfig, deviceList, hilogStreamStart,
 * uiDump, ...}`.
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (HarmonyDevEcoService) and `client.js`.
 */

import { z } from "zod";

// ---- shared shapes ---------------------------------------------------------

const errorSchema = z
  .object({
    code: z.string().readonly(),
    message: z.string().readonly().optional(),
  })
  .readonly();

/** A successful response envelope: `{ ok: true, value }`. */
function okValue(valueSchema) {
  return z
    .object({
      ok: z.literal(true).readonly(),
      value: valueSchema,
    })
    .readonly();
}

/** A failed response envelope: `{ ok: false, error }`. */
function errValue() {
  return z
    .object({
      ok: z.literal(false).readonly(),
      error: errorSchema,
    })
    .readonly();
}

/** Either a successful or failed envelope — the standard Remote return. */
function unionResult(valueSchema) {
  return z.union([okValue(valueSchema), errValue()]);
}

// ---- toolchain / config / discovery schemas -------------------------------

const resolvedSchema = z
  .object({
    source: z.enum(["devecocli", "clt", "studio", "none"]).readonly(),
    exec: z.string().readonly().optional(),
    path: z.string().readonly().optional(),
    version: z.union([z.array(z.number()).readonly(), z.string().readonly()]).optional(),
    minVersionOk: z.boolean().readonly(),
    message: z.string().readonly(),
  })
  .readonly();

const configSchema = z
  .object({
    studioPath: z.string().readonly(),
    cltPath: z.string().readonly(),
    updatedAt: z.number().readonly(),
  })
  .readonly();

const discoveryStudioSchema = z
  .object({
    path: z.string().readonly(),
    kind: z.literal("studio").readonly(),
  })
  .readonly();

const discoveryCltSchema = z
  .object({
    path: z.string().readonly(),
    version: z.string().readonly(),
    kind: z.literal("clt").readonly(),
  })
  .readonly();

const discoverySchema = z
  .object({
    schemaVersion: z.number().readonly(),
    platform: z.enum(["win32", "darwin", "linux"]).readonly(),
    scannedAt: z.number().readonly(),
    studios: z.array(discoveryStudioSchema).readonly(),
    clts: z.array(discoveryCltSchema).readonly(),
  })
  .readonly();

// ---- device schemas --------------------------------------------------------

const deviceSchema = z
  .object({
    serial: z.string().readonly(),
    name: z.string().readonly(),
    state: z.string().readonly(),
    type: z.string().readonly(),
  })
  .readonly();

const deviceInfoSchema = z
  .object({
    serial: z.string().readonly(),
    stdout: z.string().readonly(),
    stderr: z.string().readonly(),
    code: z.union([z.number().readonly(), z.null()]),
  })
  .readonly();

// ---- HiLog schemas ---------------------------------------------------------

const hilogLineSchema = z
  .object({
    timestamp: z.string().readonly().optional(),
    pid: z.number().readonly().optional(),
    tid: z.number().readonly().optional(),
    level: z.string().readonly().optional(),
    domain: z.string().readonly().optional(),
    tag: z.string().readonly().optional(),
    message: z.string().readonly().optional(),
    raw: z.string().readonly().optional(),
  })
  .readonly();

const hilogReadSchema = z
  .object({
    lines: z.array(hilogLineSchema).readonly(),
    closed: z.boolean().readonly(),
    error: z.string().readonly().optional(),
  })
  .readonly();

const hilogStreamStartSchema = z
  .object({
    streamId: z.string().readonly(),
  })
  .readonly();

const hilogStreamStopSchema = z
  .object({
    stopped: z.boolean().readonly(),
  })
  .readonly();

const hilogListSchema = z
  .object({
    lines: z.array(hilogLineSchema).readonly(),
  })
  .readonly();

// ---- ArkUI Inspector schemas ----------------------------------------------

const boundsSchema = z
  .object({
    left: z.number().readonly(),
    top: z.number().readonly(),
    right: z.number().readonly(),
    bottom: z.number().readonly(),
    width: z.number().readonly(),
    height: z.number().readonly(),
  })
  .readonly();

const uiNodeSchema = z
  .object({
    index: z.number().readonly(),
    text: z.string().readonly(),
    resourceId: z.string().readonly(),
    className: z.string().readonly(),
    bounds: boundsSchema,
    boundsStr: z.string().readonly(),
  })
  .readonly();

const uiDumpSchema = z
  .object({
    nodes: z.array(uiNodeSchema).readonly(),
  })
  .readonly();

const uiScreenshotSchema = z
  .object({
    savedTo: z.string().readonly(),
    stdout: z.string().readonly(),
    stderr: z.string().readonly(),
  })
  .readonly();

const okFlagSchema = z
  .object({
    ok: z.literal(true).readonly(),
  })
  .readonly();

const stdoutExecSchema = z
  .object({
    stdout: z.string().readonly(),
    stderr: z.string().readonly(),
    code: z.union([z.number().readonly(), z.null()]),
  })
  .readonly();

// ---- project schemas -------------------------------------------------------

const projectSchema = z
  .object({
    path: z.string().readonly(),
    name: z.string().readonly(),
    bundleName: z.string().readonly().optional(),
    moduleCount: z.number().readonly().optional(),
  })
  .readonly();

const projectsSchema = z
  .object({
    projects: z.array(projectSchema).readonly(),
  })
  .readonly();

// ---- parameter schemas -----------------------------------------------------

const _harmonyDevEco_getConfig_parameter_0$schema = z.object({}).readonly();

const _harmonyDevEco_setStudioPath_parameter_0$schema = z
  .object({
    path: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_setCltPath_parameter_0$schema = z
  .object({
    path: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_rescan_parameter_0$schema = z.object({}).readonly();

const _harmonyDevEco_deviceList_parameter_0$schema = z.object({}).readonly();

const _harmonyDevEco_deviceInfo_parameter_0$schema = z
  .object({
    device: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_hilogList_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    level: z.string().optional().readonly(),
    bundle: z.string().optional().readonly(),
    keyword: z.string().optional().readonly(),
    tail: z.number().optional().readonly(),
    from: z.string().optional().readonly(),
    to: z.string().optional().readonly(),
  })
  .readonly();

const _harmonyDevEco_hilogStreamStart_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    level: z.string().optional().readonly(),
    bundle: z.string().optional().readonly(),
    keyword: z.string().optional().readonly(),
  })
  .readonly();

const _harmonyDevEco_hilogStreamRead_parameter_0$schema = z
  .object({
    streamId: z.string().readonly(),
    maxLines: z.number().optional().readonly(),
  })
  .readonly();

const _harmonyDevEco_hilogStreamStop_parameter_0$schema = z
  .object({
    streamId: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_uiDump_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
  })
  .readonly();

const _harmonyDevEco_uiScreenshot_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    outPath: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_uiTap_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    x: z.number().readonly(),
    y: z.number().readonly(),
  })
  .readonly();

const _harmonyDevEco_uiSwipe_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    x1: z.number().readonly(),
    y1: z.number().readonly(),
    x2: z.number().readonly(),
    y2: z.number().readonly(),
    speed: z.union([z.number().readonly(), z.string().readonly()]).optional(),
  })
  .readonly();

const _harmonyDevEco_uiText_parameter_0$schema = z
  .object({
    device: z.string().optional().readonly(),
    text: z.string().readonly(),
  })
  .readonly();

const _harmonyDevEco_listProjects_parameter_0$schema = z.object({}).readonly();

// ---- composite result schemas ---------------------------------------------

const getConfigValueSchema = z
  .object({
    config: configSchema,
    resolved: resolvedSchema,
    discovery: discoverySchema.nullable(),
  })
  .readonly();

const setPathValueSchema = z
  .object({
    config: configSchema,
    resolved: resolvedSchema,
  })
  .readonly();

const rescanValueSchema = z
  .object({
    discovery: discoverySchema,
  })
  .readonly();

const deviceListValueSchema = z
  .object({
    devices: z.array(deviceSchema).readonly(),
  })
  .readonly();

const deviceInfoValueSchema = z
  .object({
    info: deviceInfoSchema,
  })
  .readonly();

// ---- helper to build invocation entries -----------------------------------

/**
 * Build an invocation entry for the given method. Mirrors the layout used in
 * dsh-memory-manager/typert.host.js and dsh-token-stats/typert.host.js so the
 * typert-loader accepts it without surprises.
 */
function iv(method, paramSchema, resultValueSchema, summary, jsDoc) {
  return {
    id: "dsh-deveco#harmonyDevEco/" + method,
    service: "harmonyDevEco",
    namespace: "harmonyDevEco",
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-deveco#HarmonyDevEco" + method[0].toUpperCase() + method.slice(1) + "Request",
          schema: paramSchema,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-deveco#HarmonyDevEco" + method[0].toUpperCase() + method.slice(1) + "Result",
      schema: unionResult(resultValueSchema),
    },
    sourceLocation: { file: "index.js", line: 1, column: 1 },
  };
}

// ---- export ----------------------------------------------------------------

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-deveco",
  face: "host",
  schemas: [],
  invocations: [
    iv("getConfig", _harmonyDevEco_getConfig_parameter_0$schema, getConfigValueSchema,
      "Read the current toolchain config, the resolved CLI source, and the latest discovery snapshot.",
      "/**\n * Read the current toolchain config, the resolved CLI source, and the latest discovery snapshot.\n */"),

    iv("setStudioPath", _harmonyDevEco_setStudioPath_parameter_0$schema, setPathValueSchema,
      "Set the DevEco Studio path (clears the CLT path because the two are mutually exclusive).",
      "/**\n * Set the DevEco Studio path (clears the CLT path because the two are mutually exclusive).\n * @param request - `{ path }`.\n * @returns the updated config + resolved source.\n */"),

    iv("setCltPath", _harmonyDevEco_setCltPath_parameter_0$schema, setPathValueSchema,
      "Set the Command Line Tools path (clears the Studio path because the two are mutually exclusive).",
      "/**\n * Set the Command Line Tools path (clears the Studio path because the two are mutually exclusive).\n * @param request - `{ path }`.\n * @returns the updated config + resolved source.\n */"),

    iv("rescan", _harmonyDevEco_rescan_parameter_0$schema, rescanValueSchema,
      "Re-run toolchain auto-discovery and persist the result to disk.",
      "/**\n * Re-run toolchain auto-discovery and persist the result to disk.\n */"),

    iv("deviceList", _harmonyDevEco_deviceList_parameter_0$schema, deviceListValueSchema,
      "Enumerate devices and emulators currently known to the toolchain.",
      "/**\n * Enumerate devices and emulators currently known to the toolchain.\n */"),

    iv("deviceInfo", _harmonyDevEco_deviceInfo_parameter_0$schema, deviceInfoValueSchema,
      "Fetch detailed metadata for a single device.",
      "/**\n * Fetch detailed metadata for a single device.\n * @param request - `{ device }` the device serial / id.\n */"),

    iv("hilogList", _harmonyDevEco_hilogList_parameter_0$schema, hilogListSchema,
      "Read a one-shot snapshot of HiLog lines matching the given filters.",
      "/**\n * Read a one-shot snapshot of HiLog lines matching the given filters.\n * @param request - optional device/level/bundle/keyword/tail/from/to filters.\n */"),

    iv("hilogStreamStart", _harmonyDevEco_hilogStreamStart_parameter_0$schema, hilogStreamStartSchema,
      "Start a live HiLog stream and return an opaque streamId for later reads.",
      "/**\n * Start a live HiLog stream and return an opaque streamId for later reads.\n * @param request - optional device/level/bundle/keyword filters.\n */"),

    iv("hilogStreamRead", _harmonyDevEco_hilogStreamRead_parameter_0$schema, hilogReadSchema,
      "Drain up to `maxLines` buffered HiLog lines from a live stream.",
      "/**\n * Drain up to `maxLines` buffered HiLog lines from a live stream.\n * @param request - `{ streamId, maxLines? }`.\n */"),

    iv("hilogStreamStop", _harmonyDevEco_hilogStreamStop_parameter_0$schema, hilogStreamStopSchema,
      "Stop and dispose a live HiLog stream.",
      "/**\n * Stop and dispose a live HiLog stream.\n * @param request - `{ streamId }`.\n */"),

    iv("uiDump", _harmonyDevEco_uiDump_parameter_0$schema, uiDumpSchema,
      "Dump the current UI tree of a device or emulator into a flat node list.",
      "/**\n * Dump the current UI tree of a device or emulator into a flat node list.\n * @param request - optional `{ device }` filter.\n */"),

    iv("uiScreenshot", _harmonyDevEco_uiScreenshot_parameter_0$schema, uiScreenshotSchema,
      "Capture a screenshot to the given host-side path.",
      "/**\n * Capture a screenshot to the given host-side path.\n * @param request - `{ outPath }` absolute host path; optional `device` filter.\n */"),

    iv("uiTap", _harmonyDevEco_uiTap_parameter_0$schema, stdoutExecSchema,
      "Tap an absolute coordinate on the device's screen.",
      "/**\n * Tap an absolute coordinate on the device's screen.\n * @param request - `{ x, y }` plus optional `device`.\n */"),

    iv("uiSwipe", _harmonyDevEco_uiSwipe_parameter_0$schema, stdoutExecSchema,
      "Swipe from (x1,y1) to (x2,y2) on the device's screen.",
      "/**\n * Swipe from (x1,y1) to (x2,y2) on the device's screen.\n * @param request - `{ x1, y1, x2, y2, speed? }` plus optional `device`.\n */"),

    iv("uiText", _harmonyDevEco_uiText_parameter_0$schema, stdoutExecSchema,
      "Type the given text into the focused input field on the device.",
      "/**\n * Type the given text into the focused input field on the device.\n * @param request - `{ text }` plus optional `device`.\n */"),

    iv("listProjects", _harmonyDevEco_listProjects_parameter_0$schema, projectsSchema,
      "List HarmonyOS projects visible to the plugin (empty list v1).",
      "/**\n * List HarmonyOS projects visible to the plugin (empty list v1).\n */"),
  ],
  model: {
    services: [
      {
        description:
          "HarmonyOS development suite: DevEco Studio / Command Line Tools / PATH-devecocli toolchain resolution with auto-discovery and mutually exclusive configuration, device enumeration, HiLog batch + live streaming, ArkUI Inspector (UI dump / screenshot / tap / swipe / text), and project browsing.",
        summary: "HarmonyOS development suite service.",
        tags: [],
        jsDoc:
          "/**\n * HarmonyOS Suite — DevEco Studio / Command Line Tools path resolution, HiLog, ArkUI Inspector.\n */",
        key: "harmonyDevEco",
        exportName: "HarmonyDevEcoService",
        members: [
          {
            kind: "method",
            name: "getConfig",
            signature: "@Remote('getConfig') async getConfig(): Promise<HarmonyDevEcoGetConfigResult>",
            summary: "Read the current toolchain config + resolved CLI source + latest discovery.",
            jsDoc:
              "/**\n * Read the current toolchain config + resolved CLI source + latest discovery.\n * @returns the config, resolved source, and discovery snapshot.\n */",
          },
          {
            kind: "method",
            name: "setStudioPath",
            signature: "@Remote('setStudioPath') async setStudioPath(request: HarmonyDevEcoSetStudioPathRequest): Promise<HarmonyDevEcoSetStudioPathResult>",
            summary: "Set the DevEco Studio path (clears the CLT path because the two are mutually exclusive).",
            jsDoc:
              "/**\n * Set the DevEco Studio path; clears cltPath per the mutex rule.\n * @param request - `{ path }`.\n * @returns the updated config + resolved source.\n */",
          },
          {
            kind: "method",
            name: "setCltPath",
            signature: "@Remote('setCltPath') async setCltPath(request: HarmonyDevEcoSetCltPathRequest): Promise<HarmonyDevEcoSetCltPathResult>",
            summary: "Set the Command Line Tools path (clears the Studio path because the two are mutually exclusive).",
            jsDoc:
              "/**\n * Set the Command Line Tools path; clears studioPath per the mutex rule.\n * @param request - `{ path }`.\n * @returns the updated config + resolved source.\n */",
          },
          {
            kind: "method",
            name: "rescan",
            signature: "@Remote('rescan') async rescan(): Promise<HarmonyDevEcoRescanResult>",
            summary: "Re-run toolchain auto-discovery and persist the result.",
            jsDoc:
              "/**\n * Re-run toolchain auto-discovery and persist the result.\n * @returns the fresh discovery snapshot.\n */",
          },
          {
            kind: "method",
            name: "deviceList",
            signature: "@Remote('deviceList') async deviceList(): Promise<HarmonyDevEcoDeviceListResult>",
            summary: "Enumerate devices and emulators currently known to the toolchain.",
            jsDoc:
              "/**\n * Enumerate devices and emulators currently known to the toolchain.\n * @returns the parsed device list (serial / name / state / type).\n */",
          },
          {
            kind: "method",
            name: "deviceInfo",
            signature: "@Remote('deviceInfo') async deviceInfo(request: HarmonyDevEcoDeviceInfoRequest): Promise<HarmonyDevEcoDeviceInfoResult>",
            summary: "Fetch detailed metadata for a single device.",
            jsDoc:
              "/**\n * Fetch detailed metadata for a single device.\n * @param request - `{ device }` serial / id.\n */",
          },
          {
            kind: "method",
            name: "hilogList",
            signature: "@Remote('hilogList') async hilogList(request?: HarmonyDevEcoHilogListRequest): Promise<HarmonyDevEcoHilogListResult>",
            summary: "Read a one-shot snapshot of HiLog lines matching the given filters.",
            jsDoc:
              "/**\n * Read a one-shot snapshot of HiLog lines matching the given filters.\n * @param request - optional device/level/bundle/keyword/tail/from/to filters.\n */",
          },
          {
            kind: "method",
            name: "hilogStreamStart",
            signature: "@Remote('hilogStreamStart') async hilogStreamStart(request?: HarmonyDevEcoHilogStreamStartRequest): Promise<HarmonyDevEcoHilogStreamStartResult>",
            summary: "Start a live HiLog stream and return an opaque streamId for later reads.",
            jsDoc:
              "/**\n * Start a live HiLog stream and return an opaque streamId for later reads.\n * @param request - optional device/level/bundle/keyword filters.\n */",
          },
          {
            kind: "method",
            name: "hilogStreamRead",
            signature: "@Remote('hilogStreamRead') async hilogStreamRead(request: HarmonyDevEcoHilogStreamReadRequest): Promise<HarmonyDevEcoHilogStreamReadResult>",
            summary: "Drain up to `maxLines` buffered HiLog lines from a live stream.",
            jsDoc:
              "/**\n * Drain up to `maxLines` buffered HiLog lines from a live stream.\n * @param request - `{ streamId, maxLines? }`.\n */",
          },
          {
            kind: "method",
            name: "hilogStreamStop",
            signature: "@Remote('hilogStreamStop') async hilogStreamStop(request: HarmonyDevEcoHilogStreamStopRequest): Promise<HarmonyDevEcoHilogStreamStopResult>",
            summary: "Stop and dispose a live HiLog stream.",
            jsDoc:
              "/**\n * Stop and dispose a live HiLog stream.\n * @param request - `{ streamId }`.\n */",
          },
          {
            kind: "method",
            name: "uiDump",
            signature: "@Remote('uiDump') async uiDump(request?: HarmonyDevEcoUiDumpRequest): Promise<HarmonyDevEcoUiDumpResult>",
            summary: "Dump the current UI tree of a device or emulator into a flat node list.",
            jsDoc:
              "/**\n * Dump the current UI tree of a device or emulator into a flat node list.\n * @param request - optional `{ device }` filter.\n */",
          },
          {
            kind: "method",
            name: "uiScreenshot",
            signature: "@Remote('uiScreenshot') async uiScreenshot(request: HarmonyDevEcoUiScreenshotRequest): Promise<HarmonyDevEcoUiScreenshotResult>",
            summary: "Capture a screenshot to the given host-side path.",
            jsDoc:
              "/**\n * Capture a screenshot to the given host-side path.\n * @param request - `{ outPath }` plus optional `device`.\n */",
          },
          {
            kind: "method",
            name: "uiTap",
            signature: "@Remote('uiTap') async uiTap(request: HarmonyDevEcoUiTapRequest): Promise<HarmonyDevEcoUiTapResult>",
            summary: "Tap an absolute coordinate on the device's screen.",
            jsDoc:
              "/**\n * Tap an absolute coordinate on the device's screen.\n * @param request - `{ x, y }` plus optional `device`.\n */",
          },
          {
            kind: "method",
            name: "uiSwipe",
            signature: "@Remote('uiSwipe') async uiSwipe(request: HarmonyDevEcoUiSwipeRequest): Promise<HarmonyDevEcoUiSwipeResult>",
            summary: "Swipe from (x1,y1) to (x2,y2) on the device's screen.",
            jsDoc:
              "/**\n * Swipe from (x1,y1) to (x2,y2) on the device's screen.\n * @param request - `{ x1, y1, x2, y2, speed? }` plus optional `device`.\n */",
          },
          {
            kind: "method",
            name: "uiText",
            signature: "@Remote('uiText') async uiText(request: HarmonyDevEcoUiTextRequest): Promise<HarmonyDevEcoUiTextResult>",
            summary: "Type the given text into the focused input field on the device.",
            jsDoc:
              "/**\n * Type the given text into the focused input field on the device.\n * @param request - `{ text }` plus optional `device`.\n */",
          },
          {
            kind: "method",
            name: "listProjects",
            signature: "@Remote('listProjects') async listProjects(): Promise<HarmonyDevEcoListProjectsResult>",
            summary: "List HarmonyOS projects visible to the plugin (empty list v1).",
            jsDoc:
              "/**\n * List HarmonyOS projects visible to the plugin (empty list v1).\n */",
          },
        ],
        types: [
          {
            name: "HarmonyDevEcoGetConfigRequest",
            declaration: "export interface HarmonyDevEcoGetConfigRequest {}",
          },
          {
            name: "HarmonyDevEcoGetConfigResult",
            declaration:
              "export type HarmonyDevEcoGetConfigResult = { ok: true; value: { config: { studioPath: string; cltPath: string; updatedAt: number }; resolved: { source: 'devecocli'|'clt'|'studio'|'none'; exec?: string; path?: string; version?: readonly number[] | string; minVersionOk: boolean; message: string }; discovery: HarmonyDevEcoDiscovery | null } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoSetStudioPathRequest",
            declaration: "export interface HarmonyDevEcoSetStudioPathRequest {\n    readonly path: string;\n}",
          },
          {
            name: "HarmonyDevEcoSetStudioPathResult",
            declaration:
              "export type HarmonyDevEcoSetStudioPathResult = { ok: true; value: { config: { studioPath: string; cltPath: string; updatedAt: number }; resolved: HarmonyDevEcoResolved } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoSetCltPathRequest",
            declaration: "export interface HarmonyDevEcoSetCltPathRequest {\n    readonly path: string;\n}",
          },
          {
            name: "HarmonyDevEcoSetCltPathResult",
            declaration:
              "export type HarmonyDevEcoSetCltPathResult = { ok: true; value: { config: { studioPath: string; cltPath: string; updatedAt: number }; resolved: HarmonyDevEcoResolved } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoRescanRequest",
            declaration: "export interface HarmonyDevEcoRescanRequest {}",
          },
          {
            name: "HarmonyDevEcoRescanResult",
            declaration:
              "export type HarmonyDevEcoRescanResult = { ok: true; value: { discovery: HarmonyDevEcoDiscovery } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoDeviceListRequest",
            declaration: "export interface HarmonyDevEcoDeviceListRequest {}",
          },
          {
            name: "HarmonyDevEcoDeviceListResult",
            declaration:
              "export type HarmonyDevEcoDeviceListResult = { ok: true; value: { devices: readonly HarmonyDevEcoDevice[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoDeviceInfoRequest",
            declaration: "export interface HarmonyDevEcoDeviceInfoRequest {\n    readonly device: string;\n}",
          },
          {
            name: "HarmonyDevEcoDeviceInfoResult",
            declaration:
              "export type HarmonyDevEcoDeviceInfoResult = { ok: true; value: { info: { serial: string; stdout: string; stderr: string; code: number | null } } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoHilogListRequest",
            declaration:
              "export interface HarmonyDevEcoHilogListRequest {\n    readonly device?: string;\n    readonly level?: string;\n    readonly bundle?: string;\n    readonly keyword?: string;\n    readonly tail?: number;\n    readonly from?: string;\n    readonly to?: string;\n}",
          },
          {
            name: "HarmonyDevEcoHilogListResult",
            declaration:
              "export type HarmonyDevEcoHilogListResult = { ok: true; value: { lines: readonly HarmonyDevEcoHilogLine[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoHilogStreamStartRequest",
            declaration:
              "export interface HarmonyDevEcoHilogStreamStartRequest {\n    readonly device?: string;\n    readonly level?: string;\n    readonly bundle?: string;\n    readonly keyword?: string;\n}",
          },
          {
            name: "HarmonyDevEcoHilogStreamStartResult",
            declaration:
              "export type HarmonyDevEcoHilogStreamStartResult = { ok: true; value: { streamId: string } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoHilogStreamReadRequest",
            declaration:
              "export interface HarmonyDevEcoHilogStreamReadRequest {\n    readonly streamId: string;\n    readonly maxLines?: number;\n}",
          },
          {
            name: "HarmonyDevEcoHilogStreamReadResult",
            declaration:
              "export type HarmonyDevEcoHilogStreamReadResult = { ok: true; value: { lines: readonly HarmonyDevEcoHilogLine[]; closed: boolean; error?: string } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoHilogStreamStopRequest",
            declaration:
              "export interface HarmonyDevEcoHilogStreamStopRequest {\n    readonly streamId: string;\n}",
          },
          {
            name: "HarmonyDevEcoHilogStreamStopResult",
            declaration:
              "export type HarmonyDevEcoHilogStreamStopResult = { ok: true; value: { stopped: boolean } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoUiDumpRequest",
            declaration: "export interface HarmonyDevEcoUiDumpRequest {\n    readonly device?: string;\n}",
          },
          {
            name: "HarmonyDevEcoUiDumpResult",
            declaration:
              "export type HarmonyDevEcoUiDumpResult = { ok: true; value: { nodes: readonly HarmonyDevEcoUiNode[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoUiScreenshotRequest",
            declaration:
              "export interface HarmonyDevEcoUiScreenshotRequest {\n    readonly device?: string;\n    readonly outPath: string;\n}",
          },
          {
            name: "HarmonyDevEcoUiScreenshotResult",
            declaration:
              "export type HarmonyDevEcoUiScreenshotResult = { ok: true; value: { savedTo: string; stdout: string; stderr: string } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoUiTapRequest",
            declaration:
              "export interface HarmonyDevEcoUiTapRequest {\n    readonly device?: string;\n    readonly x: number;\n    readonly y: number;\n}",
          },
          {
            name: "HarmonyDevEcoUiTapResult",
            declaration:
              "export type HarmonyDevEcoUiTapResult = { ok: true; value: { stdout: string; stderr: string; code: number | null } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoUiSwipeRequest",
            declaration:
              "export interface HarmonyDevEcoUiSwipeRequest {\n    readonly device?: string;\n    readonly x1: number;\n    readonly y1: number;\n    readonly x2: number;\n    readonly y2: number;\n    readonly speed?: number | string;\n}",
          },
          {
            name: "HarmonyDevEcoUiSwipeResult",
            declaration:
              "export type HarmonyDevEcoUiSwipeResult = { ok: true; value: { stdout: string; stderr: string; code: number | null } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoUiTextRequest",
            declaration:
              "export interface HarmonyDevEcoUiTextRequest {\n    readonly device?: string;\n    readonly text: string;\n}",
          },
          {
            name: "HarmonyDevEcoUiTextResult",
            declaration:
              "export type HarmonyDevEcoUiTextResult = { ok: true; value: { stdout: string; stderr: string; code: number | null } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoListProjectsRequest",
            declaration: "export interface HarmonyDevEcoListProjectsRequest {}",
          },
          {
            name: "HarmonyDevEcoListProjectsResult",
            declaration:
              "export type HarmonyDevEcoListProjectsResult = { ok: true; value: { projects: readonly { path: string; name: string; bundleName?: string; moduleCount?: number }[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "HarmonyDevEcoConfig",
            declaration:
              "export interface HarmonyDevEcoConfig {\n    readonly studioPath: string;\n    readonly cltPath: string;\n    readonly updatedAt: number;\n}",
          },
          {
            name: "HarmonyDevEcoResolved",
            declaration:
              "export interface HarmonyDevEcoResolved {\n    readonly source: 'devecocli'|'clt'|'studio'|'none';\n    readonly exec?: string;\n    readonly path?: string;\n    readonly version?: readonly number[] | string;\n    readonly minVersionOk: boolean;\n    readonly message: string;\n}",
          },
          {
            name: "HarmonyDevEcoDiscovery",
            declaration:
              "export interface HarmonyDevEcoDiscovery {\n    readonly schemaVersion: number;\n    readonly platform: 'win32'|'darwin'|'linux';\n    readonly scannedAt: number;\n    readonly studios: readonly { readonly path: string; readonly kind: 'studio' }[];\n    readonly clts: readonly { readonly path: string; readonly version: string; readonly kind: 'clt' }[];\n}",
          },
          {
            name: "HarmonyDevEcoDevice",
            declaration:
              "export interface HarmonyDevEcoDevice {\n    readonly serial: string;\n    readonly name: string;\n    readonly state: string;\n    readonly type: string;\n}",
          },
          {
            name: "HarmonyDevEcoHilogLine",
            declaration:
              "export interface HarmonyDevEcoHilogLine {\n    readonly timestamp?: string;\n    readonly pid?: number;\n    readonly tid?: number;\n    readonly level?: string;\n    readonly domain?: string;\n    readonly tag?: string;\n    readonly message?: string;\n    readonly raw?: string;\n}",
          },
          {
            name: "HarmonyDevEcoUiNode",
            declaration:
              "export interface HarmonyDevEcoUiNode {\n    readonly index: number;\n    readonly text: string;\n    readonly resourceId: string;\n    readonly className: string;\n    readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number };\n    readonly boundsStr: string;\n}",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};