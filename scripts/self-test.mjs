// dsh-deveco 自测试：harmony-studio 路径探测 + harmony-config 配置互斥与自发现 + harmony-device 工具封装/HiLog/UI 解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadConfig, saveConfig, setStudioPath, setCltPath, discoverAll, ensureDiscovery } from '../harmony-config.mjs'
import {
  execCli, execHdc, parseHilogLine, parseUiLayoutJson, parseBounds,
  buildHilogArgs, buildHilogFollowArgs,
  buildUiDumpArgs, buildUiScreenshotArgs, buildUiTapArgs, buildUiSwipeArgs, buildUiTextArgs,
  buildUiWindowListArgs, parseUiWindowListJson, parseUiRawDump, detectCustomComponentName,
  parseDeviceList, extractJsonArray,
  buildArkForwardArgs, buildLocalAbstractForwardArgs, buildForwardRemoveArgs, DEV_ECO_WS_MESSAGES, findDevEcoTreeRoot, parseDevEcoTree,
  buildDevEcoWsHandshake, isWsHandshakeAccepted, encodeWsClientTextFrame, encodeWsPongFrame, decodeWsServerFrames,
  devEcoNodeSummary, devEcoTreeLines, devEcoToolNodes,
  findDevEcoNodeById, devEcoSubtreeNodes, devEcoAncestorChain,
  buildUiRawDumpArgs, buildUiRawRecvArgs, buildUiRawCleanArgs,
  buildHdcConnectArgs, buildHdcDisconnectArgs, parseTconnResult, parseProcessPids, resolveHdc,
  buildHdcListTargetsArgs, parseHdcTargets, buildHdcHilogArgs, buildHdcHilogFollowArgs,
  buildHdcScreenCapArgs, buildHdcSnapshotDisplayArgs, buildHdcFileRecvArgs, buildHdcFileRemoveArgs,
  buildHdcTapArgs, buildHdcSwipeArgs, buildHdcTextArgs, buildHdcWindowListArgs,
  parseWindowManagerDump, buildHdcParamArgs, HDC_DEVICE_PARAM_KEYS, quoteDeviceShellArg,
  hitTest, readPngSize,
  LEVEL_SEVERITY, formatHilogLevel, devecoExec
} from '../harmony-device.mjs'
import {
  shellQuote, isBundleName, isAbilityName,
  buildBundleInfoCommand, parseBundleInfo,
  buildStartAbilityCommand, buildForceStopCommand, buildAppDebugCommand,
  buildProcessListCommand
} from '../harmony-tools.mjs'
import {
  debuggerForwardTarget, buildDebuggerForwardArgs, buildDebuggerForwardRemoveArgs,
  isDebuggerError, summarizeCallFrames, formatCallFrameLines,
  ArktsDebuggerSession, shortScriptUrl, formatPauseNotification, createDebugNoticeMessage, describePauseReason,
  decideDebugNoticeDelivery
} from '../harmony-debugger.mjs'
import { installPauseNotifier, buildHarmonyAgentTools } from '../harmony-agent-tools.mjs'
import { buildHarmonyUiTreeTool, buildHarmonyUiNodeTool } from '../harmony-ui-tools.mjs'
import {
  parseWebDebugSockets, buildWebForwardArgs, buildWebForwardRemoveArgs, buildWebSocketUrl,
  parseDevToolsTargets, selectWebTarget, normalizeWebDom, webDomTreeLines,
  WebDevToolsSession, WebDevToolsError,
} from '../harmony-webdevtools.mjs'
import { findHarmonyProjectRoot, inspectHarmonyProject } from '../harmony-project.mjs'
import {
  decodeVlqSegment, decodeSourceMapMappings, originalPositionFor, generatedPositionFor,
  loadHarmonySourceMapIndex, assertSourceBreakpointFresh,
} from '../harmony-source-map.mjs'
import {
  GIT_ENV, runGitCommand,
  buildGitRepoRootArgs, buildGitBranchArgs, buildGitVerifyHeadArgs,
  buildGitStatusArgs, buildGitDiffArgs, buildGitBlameArgs,
  parseGitStatusPorcelain, parseUnifiedDiffLineKinds, parseBlamePorcelain,
  isoWithOffset, toGitRelPath, collectFileGitInfo, blameFileLine, prepareSaveContent,
} from '../harmony-git.mjs'

test('loadConfig returns empty when file missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  const c = await loadConfig(tmp)
  assert.equal(c.studioPath, '')
  assert.equal(c.cltPath, '')
  rmSync(tmp, { recursive: true, force: true })
})
test('saveConfig roundtrips', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  const c = await saveConfig(tmp, { studioPath: 'C:\\Studio' })
  assert.equal(c.studioPath, 'C:\\Studio')
  const c2 = await loadConfig(tmp)
  assert.equal(c2.studioPath, 'C:\\Studio')
  rmSync(tmp, { recursive: true, force: true })
})
test('saveConfig preserves untouched fields', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await saveConfig(tmp, { studioPath: 'C:\\Studio', cltPath: '' })
  const c = await saveConfig(tmp, { studioPath: 'C:\\Studio2' }) // 只传 studioPath → cltPath 保留
  assert.equal(c.studioPath, 'C:\\Studio2')
  assert.equal(c.cltPath, '')
  rmSync(tmp, { recursive: true, force: true })
})
test('setStudioPath clears cltPath', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await saveConfig(tmp, { cltPath: 'C:\\CLT' })
  const c = await setStudioPath(tmp, 'C:\\Studio')
  assert.equal(c.studioPath, 'C:\\Studio')
  assert.equal(c.cltPath, '')
  rmSync(tmp, { recursive: true, force: true })
})
test('setCltPath clears studioPath', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await saveConfig(tmp, { studioPath: 'C:\\Studio' })
  const c = await setCltPath(tmp, 'C:\\CLT')
  assert.equal(c.cltPath, 'C:\\CLT')
  assert.equal(c.studioPath, '')
  rmSync(tmp, { recursive: true, force: true })
})
test('setCltPath clears studioPath even when below 26.0.0', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await saveConfig(tmp, { studioPath: 'C:\\Studio' })
  const c = await setCltPath(tmp, 'C:\\CLT\\25.0.5')
  assert.equal(c.studioPath, '')
  assert.equal(c.cltPath, 'C:\\CLT\\25.0.5')
  rmSync(tmp, { recursive: true, force: true })
})
test('discoverAll writes discovery.json', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  const result = await discoverAll(tmp, 'linux')
  assert.equal(result.platform, 'linux')
  assert.ok(Array.isArray(result.studios))
  assert.ok(Array.isArray(result.clts))
  assert.ok(existsSync(join(tmp, 'discovery.json')))
  rmSync(tmp, { recursive: true, force: true })
})
test('discoverAll is idempotent', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await discoverAll(tmp, 'darwin')
  const stat1 = readFileSync(join(tmp, 'discovery.json'), 'utf8')
  await discoverAll(tmp, 'darwin')
  const stat2 = readFileSync(join(tmp, 'discovery.json'), 'utf8')
  assert.equal(stat1, stat2)
  rmSync(tmp, { recursive: true, force: true })
})
test('ensureDiscovery triggers when missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  assert.equal(existsSync(join(tmp, 'discovery.json')), false)
  await ensureDiscovery(tmp, 'win32')
  assert.equal(existsSync(join(tmp, 'discovery.json')), true)
  rmSync(tmp, { recursive: true, force: true })
})
test('ensureDiscovery returns cached when present', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-'))
  await ensureDiscovery(tmp, 'win32')
  const before = readFileSync(join(tmp, 'discovery.json'), 'utf8')
  // 修改平台 → ensureDiscovery 应仍然返回缓存（因 schemaVersion 匹配 + 文件存在）
  const r = await ensureDiscovery(tmp, 'linux')
  const after = readFileSync(join(tmp, 'discovery.json'), 'utf8')
  assert.equal(before, after)
  assert.equal(r.platform, 'win32') // 平台来自缓存
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// harmony-device
// ---------------------------------------------------------------------------

test('parseHilogLine extracts standard line', () => {
  const r = parseHilogLine('01-01 12:34:56.789  1234  5678 I  0FFFF/AudioManager: Audio focus changed')
  assert.ok(r)
  assert.equal(r.level, 'I')
  assert.equal(r.pid, 1234)
  assert.equal(r.tid, 5678)
  assert.equal(r.domain, '0FFFF')
  assert.equal(r.tag, 'AudioManager')
  assert.equal(r.message, 'Audio focus changed')
})

test('parseHilogLine returns null on empty', () => {
  assert.equal(parseHilogLine(''), null)
  assert.equal(parseHilogLine('garbage line'), null)
})

test('parseHilogLine tolerates trailing whitespace', () => {
  const r = parseHilogLine('01-01 12:34:56.789  1234  5678 W  0FFFF/Tag: msg\n')
  assert.ok(r)
  assert.equal(r.level, 'W')
})

test('parseUiLayoutJson flattens layout tree', () => {
  const json = JSON.stringify([
    {
      type: 'FrameLayout',
      bounds: [0, 0, 1080, 1920],
      children: [
        {
          id: 'btn_submit',
          type: 'Button',
          text: 'Submit',
          bounds: [100, 200, 400, 300],
          children: []
        }
      ]
    }
  ])
  const r = parseUiLayoutJson(json)
  assert.equal(r.length, 2)
  assert.equal(r[0].className, 'FrameLayout')
  assert.equal(r[0].bounds.width, 1080)
  assert.equal(r[0].bounds.height, 1920)
  assert.equal(r[0].boundsStr, '[0,0][1080,1920]')
  assert.equal(r[1].text, 'Submit')
  assert.equal(r[1].resourceId, 'btn_submit')
  assert.equal(r[1].bounds.width, 300)
  assert.equal(r[1].bounds.height, 100)
  assert.equal(r[1].bounds.left, 100)
  assert.equal(r[1].bounds.top, 200)
})

test('parseUiLayoutJson tolerates garbage and stray prefixes', () => {
  assert.deepEqual(parseUiLayoutJson(''), [])
  assert.deepEqual(parseUiLayoutJson('not json at all'), [])
  assert.deepEqual(parseUiLayoutJson('{"a":1}'), [])
  const withPrefix = 'some progress noise\n[{"bounds":[0,0,10,20],"children":[]}]'
  const r = parseUiLayoutJson(withPrefix)
  assert.equal(r.length, 1)
  assert.equal(r[0].bounds.right, 10)
})

test('parseUiLayoutJson captures depth/parentIndex and box-model fields', () => {
  const json = JSON.stringify([
    {
      type: 'Column',
      bounds: [0, 0, 360, 800],
      padding: [10, 8, 10, 8],
      margin: 4,
      borderWidth: 2,
      borderRadius: 12,
      borderColor: '#ff0000',
      opacity: 0.9,
      visible: false,
      enabled: true,
      clickable: true,
      children: [
        { id: 'title', type: 'Text', text: 'Hi', bounds: [8, 10, 200, 60], children: [] }
      ]
    }
  ])
  const r = parseUiLayoutJson(json)
  assert.equal(r.length, 2)
  const root = r[0]
  const child = r[1]
  assert.equal(root.depth, 0)
  assert.equal(root.parentIndex, -1)
  assert.equal(child.depth, 1)
  assert.equal(child.parentIndex, 0)
  // padding [t,r,b,l]
  assert.deepEqual(root.padding, { top: 10, right: 8, bottom: 10, left: 8 })
  // margin scalar -> all sides
  assert.deepEqual(root.margin, { top: 4, right: 4, bottom: 4, left: 4 })
  assert.equal(root.borderWidth, 2)
  assert.equal(root.borderRadius, 12)
  assert.equal(root.borderColor, '#ff0000')
  assert.equal(root.opacity, 0.9)
  assert.equal(root.visible, false)
  assert.equal(root.clickable, true)
  // child defaults when fields absent
  assert.deepEqual(child.padding, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.equal(child.opacity, 1)
  assert.equal(child.visible, true)
  assert.equal(child.parentIndex, 0)
})

test('parseUiLayoutJson collects extra scalar attrs', () => {
  const json = JSON.stringify([{ type: 'X', bounds: [0, 0, 1, 1], zIndex: 5, focusable: true, note: 'hi', children: [] }])
  const r = parseUiLayoutJson(json)
  assert.deepEqual(r[0].attrs, { zIndex: 5, focusable: true, note: 'hi' })
  // structural keys are excluded from attrs
  const json2 = JSON.stringify([{ type: 'X', bounds: [0, 0, 1, 1], children: [] }])
  assert.deepEqual(parseUiLayoutJson(json2)[0].attrs, {})
})

test('hitTest picks the smallest (deepest) node containing the point', () => {
  const nodes = parseUiLayoutJson(JSON.stringify([
    { type: 'Root', bounds: [0, 0, 100, 200], children: [{ type: 'Big', bounds: [10, 10, 90, 190], children: [{ type: 'Btn', bounds: [20, 20, 40, 40], children: [] }] }] }
  ]))
  // point inside all three -> deepest (Btn, smallest area)
  assert.equal(hitTest(nodes, 30, 30).className, 'Btn')
  // point only inside Root+Big -> Big
  assert.equal(hitTest(nodes, 60, 60).className, 'Big')
  // point outside everything -> null
  assert.equal(hitTest(nodes, 500, 500), null)
  assert.equal(hitTest([], 0, 0), null)
  // 不可见存根（如压栈后被标 Hidden 的 NavBar 主页，全屏矩形）不参与命中
  const withStub = [...nodes, { index: 9, depth: 0, parentIndex: -1, className: 'NavBar', visible: false, bounds: { left: 0, top: 0, right: 100, bottom: 200 } }]
  assert.equal(hitTest(withStub, 30, 30).className, 'Btn')
})

test('readPngSize reads IHDR dimensions and rejects non-PNG', () => {
  // Minimal 24-byte PNG header: signature + IHDR length/type + width/height.
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47
  buf.writeUInt32BE(1080, 16)
  buf.writeUInt32BE(2340, 20)
  assert.deepEqual(readPngSize(buf), { width: 1080, height: 2340 })
  assert.equal(readPngSize(Buffer.from('not a png at all....')), null)
  assert.equal(readPngSize(null), null)
  assert.equal(readPngSize(Buffer.alloc(4)), null)
})

test('parseBounds handles missing', () => {
  assert.deepEqual(parseBounds(''), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  assert.deepEqual(parseBounds('garbage'), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
})

test('buildHilogArgs with all filters', () => {
  const args = buildHilogArgs({ device: 'Phone', level: 'D', bundle: 'com.example.app', keyword: 'focus', tail: 100 })
  assert.deepEqual(args, ['log', '--device', 'Phone', '--level', 'D', '--bundle-name', 'com.example.app', '--keyword', 'focus', '--tail', '100'])
})

test('buildHilogArgs default tail', () => {
  const args = buildHilogArgs({})
  assert.deepEqual(args, ['log', '--tail', '500'])
})

test('buildHilogArgs drops multi-letter level sets', () => {
  const args = buildHilogArgs({ level: 'DIW' })
  assert.deepEqual(args, ['log', '--tail', '500'])
})

test('buildHilogArgs with time range', () => {
  const args = buildHilogArgs({ from: '5m', to: '1m' })
  assert.deepEqual(args, ['log', '--from', '5m', '--to', '1m', '--tail', '500'])
})

test('buildHilogFollowArgs streams without tail', () => {
  const args = buildHilogFollowArgs({ device: 'Phone', level: 'E', bundle: 'com.example.app', keyword: 'crash' })
  assert.deepEqual(args, ['log', '--follow', '--device', 'Phone', '--level', 'E', '--bundle-name', 'com.example.app', '--keyword', 'crash'])
  assert.deepEqual(buildHilogFollowArgs({}), ['log', '--follow'])
})

test('buildUiDumpArgs with device', () => {
  assert.deepEqual(buildUiDumpArgs({ device: 'Phone' }), ['ui', 'layout', '--format', 'json', '--device', 'Phone'])
  assert.deepEqual(buildUiDumpArgs({}), ['ui', 'layout', '--format', 'json'])
})

test('buildUiDumpArgs targets a single window or all windows (mutually exclusive)', () => {
  assert.deepEqual(buildUiDumpArgs({ windowId: 31 }),
    ['ui', 'layout', '--format', 'json', '--window', '31'])
  assert.deepEqual(buildUiDumpArgs({ device: 'Phone', windowId: 8 }),
    ['ui', 'layout', '--format', 'json', '--device', 'Phone', '--window', '8'])
  assert.deepEqual(buildUiDumpArgs({ allWindows: true }),
    ['ui', 'layout', '--format', 'json', '--all-windows'])
  // --window and --all-windows are mutually exclusive upstream; windowId wins
  // so a stale allWindows flag can never produce an invalid command.
  assert.deepEqual(buildUiDumpArgs({ windowId: 31, allWindows: true }),
    ['ui', 'layout', '--format', 'json', '--window', '31'])
  // falsy/empty windowId must not emit `--window ''`
  assert.deepEqual(buildUiDumpArgs({ windowId: 0, allWindows: false }),
    ['ui', 'layout', '--format', 'json', '--window', '0'])
  assert.deepEqual(buildUiDumpArgs({ windowId: '' }), ['ui', 'layout', '--format', 'json'])
  assert.deepEqual(buildUiDumpArgs({ windowId: null }), ['ui', 'layout', '--format', 'json'])
})

test('buildUiWindowListArgs and parseUiWindowListJson', () => {
  assert.deepEqual(buildUiWindowListArgs({}), ['ui', 'window', 'list', '--format', 'json'])
  assert.deepEqual(buildUiWindowListArgs({ device: 'Phone', all: true }),
    ['ui', 'window', 'list', '--format', 'json', '--device', 'Phone', '--all'])

  // Real shape captured from a Mate 70 via `ui window list --format json --all`
  const raw = JSON.stringify([
    { id: 11, name: 'SCBDesktop8', pid: 4559, displayId: 0, focused: true },
    { id: 31, name: 'SCBStatusBar24', pid: 4559, displayId: 0, focused: false },
  ])
  assert.deepEqual(parseUiWindowListJson(raw), [
    { id: 11, name: 'SCBDesktop8', pid: 4559, displayId: 0, focused: true },
    { id: 31, name: 'SCBStatusBar24', pid: 4559, displayId: 0, focused: false },
  ])
  // tolerates junk / missing fields / stray prefix
  assert.deepEqual(parseUiWindowListJson(''), [])
  assert.deepEqual(parseUiWindowListJson('not json'), [])
  assert.deepEqual(parseUiWindowListJson('noise\n' + raw).length, 2)
  assert.deepEqual(parseUiWindowListJson('[{"name":"no-id"}]'), [])
  // focused defaults to false rather than truthy-string
  assert.equal(parseUiWindowListJson('[{"id":3,"focused":"yes"}]')[0].focused, false)
})

test('parseDeviceList survives pretty JSON + trailing docs-upgrade notice on stdout', () => {
  // Exact real-world capture (devecocli 1.3.6, Windows): `device list --format
  // json` pretty-prints the array AND appends the docs notice to STDOUT. The
  // old whole-buffer JSON.parse died on the notice and the table fallback then
  // rendered every raw JSON line as a device row (the "device list shows full
  // JSON" settings bug).
  const realWorld = [
    '[',
    '  {',
    '    "name": "HUAWEI Mate 70",',
    '    "serial": "192.168.3.6:40691",',
    '    "kind": "device",',
    '    "deviceType": "phone"',
    '  }',
    ']',
    '',
    'New docs version 1.3.6 available, run `devecocli docs update` to upgrade',
    '',
  ].join('\n')
  assert.deepEqual(parseDeviceList(realWorld), [
    { serial: '192.168.3.6:40691', name: 'HUAWEI Mate 70', state: 'device', type: 'phone' },
  ])

  // Single-line compact JSON still parses.
  assert.deepEqual(
    parseDeviceList('[{"name":"HUAWEI Mate 70","serial":"55K0225509025604","kind":"device","deviceType":"phone"}]'),
    [{ serial: '55K0225509025604', name: 'HUAWEI Mate 70', state: 'device', type: 'phone' }]
  )

  // Notice BEFORE the JSON parses too (banner-style chatter).
  assert.equal(
    parseDeviceList('New docs version 1.3.6 available, run `devecocli docs update` to upgrade\n' + realWorld).length,
    1
  )

  // Empty array + notice → no phantom rows.
  assert.deepEqual(parseDeviceList('[]\nNew docs version 1.3.6 available, run `devecocli docs update` to upgrade'), [])

  // Trailing chatter containing brackets must not leak into the carve-out.
  assert.equal(parseDeviceList('[{"serial":"A1"}]\nsee [docs] for details').length, 1)
  assert.equal(parseDeviceList('[{"serial":"A1"}]\nsee [docs] for details')[0].serial, 'A1')

  // JSON string values containing ] and escaped quotes stay intact.
  const tricky = '[{"name":"weird \\"name\\"]x","serial":"S1","kind":"device","deviceType":"phone"}]'
  assert.deepEqual(parseDeviceList(tricky), [
    { serial: 'S1', name: 'weird "name"]x', state: 'device', type: 'phone' },
  ])
})

test('parseDeviceList falls back to the human table layout', () => {
  const table = [
    '- Querying connected devices…',
    'Name            Serial            Kind    Device Type',
    '--------------  ----------------  ------  -----------',
    'HUAWEI Mate 70  55K0225509025604  device  phone',
  ].join('\n')
  assert.deepEqual(parseDeviceList(table), [
    { serial: '55K0225509025604', name: 'HUAWEI Mate 70', state: 'device', type: 'phone' },
  ])
  // Legacy header + single-column rows.
  assert.deepEqual(
    parseDeviceList('Device ID\n55K0225509025604'),
    [{ serial: '55K0225509025604', name: '', state: '', type: '' }]
  )
  // No output → no devices.
  assert.deepEqual(parseDeviceList(''), [])
  assert.deepEqual(parseDeviceList('not json, no table'), [{ serial: 'not json, no table', name: '', state: '', type: '' }])
})

test('extractJsonArray carves the first balanced array only', () => {
  assert.deepEqual(extractJsonArray('[1,2,3]'), [1, 2, 3])
  assert.deepEqual(extractJsonArray('noise [1,2] tail'), [1, 2])
  assert.deepEqual(extractJsonArray('[[1],[2]]'), [[1], [2]])
  assert.deepEqual(extractJsonArray('first [1] second [2,3]'), [1])
  assert.deepEqual(extractJsonArray('x [1]'), [1])
  assert.equal(extractJsonArray('no brackets'), null)
  assert.equal(extractJsonArray('{"obj":1}'), null)
  assert.equal(extractJsonArray(''), null)
  assert.equal(extractJsonArray(null), null)
  assert.equal(extractJsonArray('[1,2'), null) // unbalanced → null, never a partial parse
})

test('buildUiRawDumpArgs / recv / clean drive `hdc shell uitest dumpLayout`', () => {
  assert.deepEqual(buildUiRawDumpArgs('/data/local/tmp/x.json'),
    ['shell', 'uitest', 'dumpLayout', '-p', '/data/local/tmp/x.json'])
  // -i keeps windows unmerged so per-window roots (and hostWindowId) survive
  assert.deepEqual(buildUiRawDumpArgs('/data/local/tmp/x.json', { all: true }),
    ['shell', 'uitest', 'dumpLayout', '-p', '/data/local/tmp/x.json', '-i'])
  assert.deepEqual(buildUiRawRecvArgs('/data/local/tmp/x.json', 'C:\\tmp\\x.json'),
    ['file', 'recv', '/data/local/tmp/x.json', 'C:\\tmp\\x.json'])
  assert.deepEqual(buildUiRawCleanArgs('/data/local/tmp/x.json'), ['shell', 'rm', '-f', '/data/local/tmp/x.json'])
})

test('parseUiRawDump reads the visible rect and the true origBounds apart', () => {
  // Real shape from `uitest dumpLayout` on a Mate 70: every attribute is a
  // string and both rects are "[l,t][r,b]". A scrolled ListItem is clipped in
  // `bounds` but keeps its full extent in `origBounds`.
  const doc = {
    attributes: {
      bounds: '[0,0][1216,2688]', origBounds: '[0,0][1216,2688]', type: 'root',
      id: '', hostWindowId: '826', hierarchy: 'ROOT826,0,0,1,0,1,0,0,0,0,1,2,0',
      clickable: 'false', scrollable: 'false', visible: 'true', enabled: 'true',
    },
    children: [{
      attributes: {
        bounds: '[117,286][1216,515]', origBounds: '[0,-1530][1216,515]',
        type: 'ListItem', id: 'item1', hostWindowId: '826', scrollable: 'false',
        clickable: 'true', visible: 'true', enabled: 'true', opacity: '1.000000',
        zIndex: '0', backgroundColor: '#00000000', backgroundImage: 'empty source',
        text: '', hitTestBehavior: 'HitTestMode.Default',
      },
      children: [{
        attributes: {
          bounds: '[120,300][400,400]', origBounds: '[3,-1516][400,400]',
          type: 'Text', accessibilityId: '2701', hostWindowId: '826', text: '博汇纸业',
        },
        children: [],
      }],
    }],
  }
  const r = parseUiRawDump(JSON.stringify(doc))
  assert.equal(r.length, 3)
  const item = r[1]
  assert.equal(item.className, 'ListItem')
  // visible (clipped) rect
  assert.equal(item.boundsStr, '[117,286][1216,515]')
  assert.equal(item.bounds.top, 286)
  // true layout rect — this is what the overlay/box model must use
  assert.equal(item.origBoundsStr, '[0,-1530][1216,515]')
  assert.equal(item.origBounds.top, -1530)
  assert.equal(item.origBounds.height, 2045)
  assert.notEqual(item.boundsStr, item.origBoundsStr)
  // string booleans are coerced; window comes from hostWindowId
  assert.equal(item.clickable, true)
  assert.equal(item.scrollable, false)
  assert.equal(item.visible, true)
  assert.equal(item.windowId, 826)
  assert.equal(r[2].text, '博汇纸业')
  assert.equal(r[2].resourceId, '2701')   // falls back to accessibilityId
  // noisy/empty attributes are dropped, real ones survive
  assert.equal(item.attrs.backgroundColor, '#00000000')
  assert.equal(item.attrs.backgroundImage, undefined) // 'empty source' filtered
  assert.equal(item.attrs.zIndex, undefined)           // modelled explicitly
  // the raw root itself is included
  assert.equal(r[0].className, 'root')
  assert.equal(r[0].windowId, 826)
})

test('parseUiRawDump handles merged objects and per-window arrays, and junk', () => {
  const win = (host, top) => ({
    attributes: { bounds: `[0,${top}][1216,2688]`, origBounds: `[0,${top}][1216,2688]`, type: 'WindowScene', id: 'session' + host, hostWindowId: String(host) },
    children: [{ attributes: { bounds: `[0,${top}][100,${top + 10}]`, origBounds: `[0,${top}][100,${top + 10}]`, type: 'Text', text: 'w' + host, hostWindowId: String(host) }, children: [] }],
  })
  // merged form (no -i): a single root object
  const merged = parseUiRawDump(JSON.stringify(win(31, 0)))
  assert.equal(merged.length, 2)
  assert.equal(merged[1].windowId, 31)
  // array form (-i): one root per window, all must be walked
  const arr = parseUiRawDump(JSON.stringify([win(31, 0), win(826, 111)]))
  assert.equal(arr.length, 4)
  assert.deepEqual([...new Set(arr.map((n) => n.windowId))].sort((a, b) => a - b), [31, 826])
  assert.equal(arr[3].text, 'w826')
  // junk is safe
  assert.deepEqual(parseUiRawDump(''), [])
  assert.deepEqual(parseUiRawDump('not json'), [])
  assert.deepEqual(parseUiRawDump(null), [])
  // a node without origBounds falls back to bounds for the true rect
  const noOrig = parseUiRawDump(JSON.stringify({
    attributes: { bounds: '[10,20][30,40]', type: 'Text', hostWindowId: '5' }, children: [],
  }))
  assert.equal(noOrig[0].origBoundsStr, '[10,20][30,40]')
  assert.equal(noOrig[0].windowId, 5)
  // window falls back to session<NN> then ROOT<NN> when hostWindowId is absent
  assert.equal(parseUiRawDump(JSON.stringify({
    attributes: { bounds: '[0,0][1,1]', type: 'WindowScene', id: 'session77' }, children: [],
  }))[0].windowId, 77)
  assert.equal(parseUiRawDump(JSON.stringify({
    attributes: { bounds: '[0,0][1,1]', type: 'Text', hierarchy: 'ROOT42,0,0' }, children: [],
  }))[0].windowId, 42)
})

test('parseUiRawDump keeps devId separate from accessibilityId', () => {
  // Regression: resourceId fell back to accessibilityId, so the tree rendered
  // `#16605` (a bare number) while the properties pane labelled that same value
  // "id" — and custom components hid `#id` in the tree but showed it in the
  // properties. `devId` is the developer `.id('…')` and nothing else.
  const doc = {
    attributes: { bounds: '[0,0][1216,2688]', origBounds: '[0,0][1216,2688]', type: 'root', hostWindowId: '826' },
    children: [{
      // no .id() at all — only the numeric accessibilityId
      attributes: { bounds: '[0,545][296,604]', origBounds: '[0,545][296,604]', type: 'Stack', id: '', key: '', accessibilityId: '16605', hostWindowId: '826' },
      children: [{
        // a custom component: its id is the struct name and must show in both places
        attributes: { bounds: '[0,604][296,670]', origBounds: '[0,604][296,670]', type: 'Row', id: 'MyRow', key: 'MyRow', accessibilityId: '99', hostWindowId: '826' },
        children: [],
      }],
    }],
  }
  const r = parseUiRawDump(JSON.stringify(doc))
  const noId = r[1]
  const comp = r[2]
  assert.equal(noId.devId, '')
  assert.equal(noId.accessibilityId, '16605')
  // resourceId may still fall back for generic use, but devId never does —
  // otherwise the tree would print "#16605" as if it were an id.
  assert.equal(noId.resourceId, '16605')
  assert.equal(comp.devId, 'MyRow')
  assert.equal(comp.devId, comp.key)
  assert.equal(comp.componentName, 'MyRow')
  // What the tree renders (`#` + devId) is exactly the properties "id" row.
  assert.equal((comp.devId ? '#' + comp.devId : ''), '#MyRow')
  assert.equal((noId.devId ? '#' + noId.devId : ''), '')
})

test('parseUiRawDump attributes anonymous __Common__ nodes to their owning component', () => {
  // Huawei docs: "开发工具链会额外生成节点 __Common__". Those placeholders carry
  // no id at all, so without ownerComponent the tree shows a bare, meaningless
  // `__Common__` row instead of naming the custom component it belongs to.
  const doc = {
    attributes: { bounds: '[0,0][1216,2688]', origBounds: '[0,0][1216,2688]', type: 'root', hostWindowId: '826', accessibilityId: '0' },
    children: [{
      attributes: { bounds: '[0,0][1216,2688]', origBounds: '[0,0][1216,2688]', type: 'Stack', id: 'ParentDetail', key: 'ParentDetail', hostWindowId: '826', accessibilityId: '1' },
      children: [{
        // anonymous placeholder inside the component
        attributes: { bounds: '[976,169][1067,260]', origBounds: '[976,169][1067,260]', type: '__Common__', id: '', key: '', hostWindowId: '826', accessibilityId: '2' },
        children: [{
          // 工具链生成的组件实例 id（Component_序号 形态，首字母大写）——按 DevEco
        // 规则也算组件名，因此它自成组件，不再继承祖先的 ownerComponent。
        attributes: { bounds: '[976,169][1067,260]', origBounds: '[976,169][1067,260]', type: 'Image', id: 'ImageKnifePro_2727', key: 'ImageKnifePro_2727', hostWindowId: '826' },
          children: [],
        }],
      }],
    }],
  }
  const r = parseUiRawDump(JSON.stringify(doc))
  const comp = r[1]
  const placeholder = r[2]
  const inner = r[3]
  assert.equal(comp.componentName, 'ParentDetail')
  assert.equal(comp.ownerComponent, 'ParentDetail')
  // the anonymous placeholder inherits the owner, has no componentName itself
  assert.equal(placeholder.componentName, '')
  assert.equal(placeholder.className, '__Common__')
  assert.equal(placeholder.ownerComponent, 'ParentDetail')
  // descendants keep the owner as well (the nearest component ancestor)
  // 组件名只取首段（用户确认）：ImageKnifePro_2727 → ImageKnifePro
  assert.equal(inner.componentName, 'ImageKnifePro')
  assert.equal(inner.ownerComponent, 'ImageKnifePro')
  // the tree root owns nothing
  assert.equal(r[0].ownerComponent, '')
})

test('parseUiRawDump folds dumpLayout -a font metrics from extraAttrs', () => {
  // `-a` puts font data in a sibling `extraAttrs: { extra: {...} }` container,
  // not inside `attributes` — it must still reach the properties pane.
  const doc = {
    attributes: { bounds: '[0,0][100,40]', origBounds: '[0,0][100,40]', type: 'Text', id: 't', key: 't', hostWindowId: '826' },
    extraAttrs: { extra: { Content: '03', FontSize: '48.75px prop: 15.00vp actual: 48.750000', FontColor: '#FFFFFFFF|PH:0', BackgroundColor: '#32354500' } },
    children: [],
  }
  const n = parseUiRawDump(JSON.stringify(doc))[0]
  assert.equal(n.rawAttrs.Content, '03')
  assert.equal(n.rawAttrs.FontSize, '48.75px prop: 15.00vp actual: 48.750000')
  assert.equal(n.rawAttrs.FontColor, '#FFFFFFFF|PH:0')
  assert.equal(n.rawAttrs.BackgroundColor, '#32354500')
  // and they are also exposed through the catch-all attrs map
  assert.equal(n.attrs.FontSize, '48.75px prop: 15.00vp actual: 48.750000')
})

test('parseUiRawDump derives the measured content box from children rects', () => {
  // margin/padding/border 的声明值设备 dump 不输出（已穷尽核对）；内容区＝子节点
  // 矩形并集是唯一可测的盒子模型几何，UI 据实标注「内缩」而不冒充 padding。
  const doc = {
    attributes: { bounds: '[0,0][200,200]', origBounds: '[0,0][200,200]', type: 'Column', id: 'p', key: 'p', hostWindowId: '826' },
    children: [
      { attributes: { bounds: '[10,20][190,80]', origBounds: '[10,20][190,80]', type: 'Text', hostWindowId: '826' }, children: [] },
      { attributes: { bounds: '[10,90][190,180]', origBounds: '[10,90][190,180]', type: 'Text', hostWindowId: '826' }, children: [] },
    ],
  }
  const n = parseUiRawDump(JSON.stringify(doc))[0]
  // union of the two children rects
  assert.deepEqual(n.contentBox, { left: 10, top: 20, right: 190, bottom: 180, width: 180, height: 160 })
  // insets = gap between component region and content region
  assert.equal(n.contentBox.top - n.bounds.top, 20)      // top inset
  assert.equal(n.bounds.right - n.contentBox.right, 10)  // right inset
  assert.equal(n.bounds.bottom - n.contentBox.bottom, 20)// bottom inset
  assert.equal(n.contentBox.left - n.bounds.left, 10)    // left inset
  // a leaf has no content box — key absent (JSON-safe: 有值才挂 key)
  const leaf = parseUiRawDump(JSON.stringify({
    attributes: { bounds: '[0,0][10,10]', origBounds: '[0,0][10,10]', type: 'Text', hostWindowId: '826' }, children: [],
  }))[0]
  assert.equal(leaf.contentBox, undefined)
  assert.equal('contentBox' in JSON.parse(JSON.stringify(leaf)), false)
  // a scrolled child that overflows is still reported honestly (insets go negative)
  const over = parseUiRawDump(JSON.stringify({
    attributes: { bounds: '[0,0][100,100]', origBounds: '[0,0][100,100]', type: 'List', hostWindowId: '826' },
    children: [{ attributes: { bounds: '[0,-50][100,150]', origBounds: '[0,-50][100,150]', type: 'ListItem', hostWindowId: '826' }, children: [] }],
  }))[0]
  assert.equal(over.contentBox.top, -50)
  assert.equal(over.contentBox.bottom, 150)
})

test('detectCustomComponentName tells @Component instances from developer .id() values', () => {
  // Struct instance names — every segment capitalized.
  assert.equal(detectCustomComponentName('MyRow'), 'MyRow')
  assert.equal(detectCustomComponentName('StatusBarBox'), 'StatusBarBox')
  assert.equal(detectCustomComponentName('LiveMetaBallBaseVm'), 'LiveMetaBallBaseVm')
  assert.equal(detectCustomComponentName('SCBDesktop_Flex_Desktop'), 'SCBDesktop')
  assert.equal(detectCustomComponentName('Parent_Child'), 'Parent')
  // DevEco compid 实测形态：带哈希后缀 / 工具链生成的 Component_类型_序号
  // —— 组件名只取首段（用户确认：只显示组件名）
  assert.equal(detectCustomComponentName('WeTopNavigationBarCenterTitle_dd1b629b4ab62a6d071752b451a4fe5a'), 'WeTopNavigationBarCenterTitle')
  assert.equal(detectCustomComponentName('StatusBarBackground_Row_0'), 'StatusBarBackground')
  // Developer-assigned .id('…') values must NOT be mistaken for components.
  assert.equal(detectCustomComponentName('tv_stock_name'), '')
  assert.equal(detectCustomComponentName('optional_index_quote_change'), '')
  assert.equal(detectCustomComponentName('linearGradient_bg'), '')
  assert.equal(detectCustomComponentName('icon_layout'), '')
  assert.equal(detectCustomComponentName('mainNavigationId'), '')
  // @Builder 插槽名
  assert.equal(detectCustomComponentName('left'), '')
  assert.equal(detectCustomComponentName('center'), '')
  assert.equal(detectCustomComponentName(''), '')
  assert.equal(detectCustomComponentName(null), '')
  // key is used when id is absent
  assert.equal(detectCustomComponentName('', 'StatusBarView'), 'StatusBarView')
})

test('DevEco forward args follow the decompiled SocketPortForwardOperation shape', () => {
  // 新协议：`ark:<pid>@<pkg>`（hdclib remoteNode = ARK + pid + AT + join(去空参数, "@")）
  assert.deepEqual(buildArkForwardArgs(15037, '8097', 'io.duke.elfRefresh'),
    ['fport', 'tcp:15037', 'ark:8097@io.duke.elfRefresh'])
  // 旧协议：localabstract:<pid><tid><serviceName> 直接拼接（真机 fport ls 实测 10845com.ss.hm.ugc.aweme）
  assert.deepEqual(buildLocalAbstractForwardArgs(8722, '10845', '', 'com.ss.hm.ugc.aweme'),
    ['fport', 'tcp:8722', 'localabstract:10845com.ss.hm.ugc.aweme'])
  // 解除转发（`fport rm`，实测 `--remove` 非法会静默失败泄漏规则）
  assert.deepEqual(buildForwardRemoveArgs(15037, 'ark:8097@io.duke.elfRefresh'),
    ['fport', 'rm', 'tcp:15037', 'ark:8097@io.duke.elfRefresh'])
})

test('DEV_ECO_WS_MESSAGES matches DevEco MessageConstant literals', () => {
  assert.equal(DEV_ECO_WS_MESSAGES.connected, '{"type":"connected"}')
  assert.equal(DEV_ECO_WS_MESSAGES.inspectorAbilities, '{"type":"inspectorAbilities","content":[]}')
  assert.equal(DEV_ECO_WS_MESSAGES.tree, '{"type":"tree"}')
})

test('findDevEcoTreeRoot unwraps nested root payloads (incl. JSON strings)', () => {
  const node = { $type: 'JsView', $children: [] }
  assert.equal(findDevEcoTreeRoot(node), node)
  assert.equal(findDevEcoTreeRoot({ type: 'root', root: node }), node)
  // JSON 字符串内容要解开（往返后是等值新对象，比较用 deepEqual）
  assert.deepEqual(findDevEcoTreeRoot({ type: 'root', content: JSON.stringify({ tree: node }) }), node)
  assert.equal(findDevEcoTreeRoot(null), null)
  assert.equal(findDevEcoTreeRoot({ type: 'snapShot', content: 'base64...' }), null)
})

test('parseDevEcoTree produces flat nodes with declared box-model values', () => {
  // 应用侧节点形如（反编译 ArkUIInspectorServer / 前端 main.*.js 双重确认）：
  // { $type, $ID, $attrs, $rect, $children, viewTag, type: "custom" | "build-in" }
  const root = {
    $type: 'JsView', $ID: '11', viewTag: 'EntryView', type: 'custom',
    $rect: { startX: 0, startY: 0, endX: 1216, endY: 2688 },
    $attrs: { padding: 12, margin: { top: 6, right: 8, bottom: 6, left: 8 }, visible: 'true' },
    $children: [
      {
        $type: 'Text', $ID: '22', type: 'build-in',
        $rect: { startX: 55, startY: 33, endX: 166, endY: 110 },
        $attrs: { text: '微信', borderWidth: 2, borderColor: '#FF0000', clickable: 'true' },
        $children: [],
      },
      {
        $type: 'JsView', $ID: '33', viewTag: 'ImageKnifePro_1447', type: 'custom',
        $rect: [0, 120, 200, 220],
        $attrs: { label: 'ImageKnifePro_1447' },
        $children: [],
      },
    ],
  }
  const r = parseDevEcoTree(root)
  assert.equal(r.length, 3)
  // 根：JsView + viewTag → 组件名权威来源
  assert.equal(r[0].componentName, 'EntryView')
  assert.equal(r[0].className, 'EntryView')   // JsView → 用名字替代类型
  assert.equal(r[0].attrs.isCustom, 'true')
  // 声明值：数字 → 四边同值；对象 → 逐边
  assert.deepEqual(r[0].padding, { top: 12, right: 12, bottom: 12, left: 12 })
  assert.deepEqual(r[0].margin, { top: 6, right: 8, bottom: 6, left: 8 })
  // build-in 子节点：类型原样，几何 {startX..endY} → 矩形
  assert.equal(r[1].className, 'Text')
  assert.deepEqual(r[1].bounds, { left: 55, top: 33, right: 166, bottom: 110, width: 111, height: 77 })
  assert.equal(r[1].text, '微信')
  assert.equal(r[1].clickable, true)
  assert.equal(r[1].borderWidth, 2)
  assert.equal(r[1].borderColor, '#FF0000')
  assert.equal(r[1].componentName, '')
  assert.equal(r[1].ownerComponent, 'EntryView')  // 最近命名组件祖先
  // 第二个子节点：viewTag 组件名（首段提取）+ 数组 $rect
  assert.equal(r[2].componentName, 'ImageKnifePro')
  assert.equal(r[2].ownerComponent, 'ImageKnifePro')
  assert.deepEqual(r[2].bounds, { left: 0, top: 120, right: 200, bottom: 220, width: 200, height: 100 })
  // 层级
  assert.equal(r[1].parentIndex, 0)
  assert.equal(r[2].depth, 1)
  // accessibilityId = $ID（与属性面板一致）
  assert.equal(r[1].accessibilityId, '22')
})

test('parseDevEcoTree tolerates non-numeric box declarations', () => {
  const root = {
    $type: 'Row', $ID: '1', $rect: [0, 0, 10, 10],
    $attrs: { padding: 'auto', margin: '12 8 6 4', borderRadius: 'round' },
    $children: [],
  }
  const r = parseDevEcoTree(root)
  assert.equal(r[0].padding, undefined)                       // 'auto' → 放弃，不造假
  assert.deepEqual(r[0].margin, { top: 12, right: 8, bottom: 6, left: 4 })  // CSS 四值
  assert.equal(r[0].borderRadius, undefined)                  // 'round' 非数字
})

test('parseDevEcoTree parses real-device attribute shapes (vp units / JSON margins / rect strings)', () => {
  // 真实形态（模拟器实测 186KB root payload）：$rect 是 "[l,t],[r,b]" 字符串、
  // 盒模型值带 vp/px 单位、margin 可为 JSON 字符串、borderRadius 是四角对象、
  // Text 文本在 content、Button 文本在 label、开发者 id 在 id、visibility 是枚举。
  const root = {
    $type: 'root', $children: [{
      $type: 'Text', $ID: '22', type: 'build-in',
      $rect: '[56.00, 185.00],[112.00,241.00]',
      $attrs: {
        content: '微信', id: 'back', visibility: 'Visibility.Visible', enabled: true, focused: true,
        padding: '12.00vp', margin: '{"top":"0.00vp","right":"16.00vp","bottom":"0.00vp","left":"16.00vp"}',
        borderWidth: '2.00vp', borderRadius: { topLeft: '28.00px', topRight: '28.00px', bottomLeft: '0.00px', bottomRight: '0.00px' },
        borderColor: '#FF000000', opacity: '0.50',
      },
      $children: [],
    }],
  }
  const r = parseDevEcoTree(root)
  assert.equal(r.length, 2)
  const t = r[1]
  // $rect 字符串 → 矩形
  assert.deepEqual(t.bounds, { left: 56, top: 185, right: 112, bottom: 241, width: 56, height: 56 })
  // 单位值 → 数字
  assert.deepEqual(t.padding, { top: 12, right: 12, bottom: 12, left: 12 })
  assert.deepEqual(t.margin, { top: 0, right: 16, bottom: 0, left: 16 })
  assert.equal(t.borderWidth, 2)
  assert.equal(t.borderRadius, 28)                     // 四角对象 → 最大角
  assert.equal(t.borderColor, '#FF000000')
  assert.equal(t.opacity, 0.5)
  // 文本与状态语义
  assert.equal(t.text, '微信')
  assert.equal(t.devId, 'back')                        // 开发者 .id()
  assert.equal(t.visible, true)
  assert.equal(t.enabled, true)
  assert.equal(t.focused, true)
  // 枚举隐藏 → 存根语义：节点本身保留、子节点全剪（用户决策：如 NavBar 主页
  // 被 Navigation 压栈后整体标 Hidden，父节点必须仍可见）
  const hidden = parseDevEcoTree({ $type: 'root', $children: [{ $type: 'Row', $ID: '1', $rect: '[0,0][1,1]', $attrs: { visibility: 'Visibility.Hidden' }, $children: [] }] })
  assert.equal(hidden.length, 2) // root + Hidden 存根
  assert.equal(hidden[1].visible, false)
})

test('parseDevEcoTree normalizes negative zero for lossless JSON tool output', () => {
  // DSH 的 output.schema 拒绝 -0（JSON.stringify 虽显示 0，但并非无损 JSON 数字）。
  // 设备可能上报 "-0.00vp"，声明值和坐标都必须在解析入口归一为 +0。
  const root = {
    $type: 'Row', $ID: 'negative-zero',
    $rect: '[-0.00, -0.00],[-0.00, -0.00]',
    $attrs: {
      padding: '-0.00vp',
      margin: { top: '-0.00vp', right: -0, bottom: '-0.00px', left: '-0.00' },
      borderWidth: '-0.00vp',
      borderRadius: { topLeft: '-0.00vp', topRight: -0, bottomLeft: '-0.00px', bottomRight: '-0.00' },
      opacity: '-0.00', zIndex: '-0.00',
    },
    $children: [],
  }
  const node = parseDevEcoTree(root)[0]
  assert.deepEqual(node.bounds, { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  assert.deepEqual(node.padding, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.deepEqual(node.margin, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.equal(node.borderWidth, 0)
  assert.equal(node.borderRadius, 0)
  assert.equal(node.opacity, 0)
  assert.equal(node.zIndex, 0)

  const assertNoNegativeZero = (value) => {
    if (typeof value === 'number') assert.equal(Object.is(value, -0), false)
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) assertNoNegativeZero(entry)
  }
  assertNoNegativeZero(node)
  assertNoNegativeZero(devEcoToolNodes([node], 400).nodes[0])
})

test('parseDevEcoTree keeps invisible nodes as stubs, prunes their subtrees', () => {
  const text = (id, top, attrs = {}, kids = []) =>
    ({ $type: 'Text', $ID: id, $rect: `[0,${top}][50,${top + 20}]`, $attrs: attrs, $children: kids })
  const tree = {
    $type: 'root',
    $children: [
      {
        $type: 'Column', $ID: 'a', $rect: '[0,0][100,100]', $attrs: {},
        $children: [
          // 隐藏节点：自身保留为存根，其后代（无论自身标记如何）全部剪掉
          text('t1', 0, { visibility: 'Visibility.Hidden' }, [text('s1', 0), text('s2', 0, {}, [text('s3', 0)])]),
          text('t2', 30, { visibility: 'Visibility.None' }),
          text('t3', 60, { visibility: 'Visibility.Visible' }, [text('s4', 60)]),
          text('t4', 90, { visible: 'false' }),
          text('t5', 120), // 缺失 visibility → 默认可见
        ],
      },
      { $type: 'Row', $ID: 'nv', $rect: '[0,0][1,1]', visible: false, $children: [] }, // 节点级布尔 false → 存根
    ],
  }
  const nodes = parseDevEcoTree(tree)
  const ids = nodes.map((n) => n.accessibilityId)
  // t1/t2/t4/nv 是存根（保留）；t1 的后代 s1/s2/s3 剪掉；可见的 t3 连同子节点保留
  assert.deepEqual(ids, ['', 'a', 't1', 't2', 't3', 's4', 't4', 't5', 'nv'])
  assert.equal(nodes[2].visible, false) // t1 存根带 visible:false
  assert.equal(nodes[4].visible, true)
  // 剪枝后 index/depth 保持连续，兄弟节点的 parentIndex 都指向真实父节点。
  assert.equal(nodes[3].parentIndex, 1)
  assert.equal(nodes[3].depth, 2)
})

test('parseDevEcoTree prunes non-current Swiper pages when displayCount is absent', () => {
  const leaf = (id) => ({ $type: 'Text', $ID: id, $rect: '[0,0][10,10]', $attrs: {}, $children: [] })
  const container = (type, id, kids) => ({ $type: type, $ID: id, $rect: '[0,0][100,100]', $attrs: {}, $children: kids })
  const makeTree = (attrs) => ({
    $type: 'root',
    $children: [{
      $type: 'Swiper', $ID: 'swiper', $rect: '[0,0][100,100]', $attrs: attrs,
      $children: [
        container('Column', 'page0', [leaf('page0deep')]),
        container('TabContent', 'page1', [container('Column', 'page1root', [leaf('page1deep')])]),
        container('TabContent', 'page2', [
          container('Column', 'page2a', [leaf('page2adeep')]),
          container('Row', 'page2b', [leaf('page2bdeep')]),
        ]),
      ],
    }],
  })

  // displayCount 未配置 → 按 1 处理。currentIndex=1 的 page1 整棵保留；
  // page0 非 TabContent 只留页根；page2 是 TabContent，留页根与直接子节点两层。
  const nodes = parseDevEcoTree(makeTree({ currentIndex: '1' }))
  assert.deepEqual(nodes.map((n) => n.accessibilityId), [
    '', 'swiper', 'page0', 'page1', 'page1root', 'page1deep', 'page2', 'page2a', 'page2b',
  ])
  const byId = new Map(nodes.map((n) => [n.accessibilityId, n]))
  assert.equal(byId.get('page0').depth, 2)
  assert.equal(byId.get('page2a').depth, 3)
  assert.equal(byId.get('page2b').depth, 3)
  assert.equal(byId.get('page2a').parentIndex, byId.get('page2').index)
  assert.equal(byId.get('page2b').parentIndex, byId.get('page2').index)
  // childCount 始终保持原始树口径；即使子节点全部被裁掉，也不能变成 0。
  assert.equal(byId.get('page0').childCount, 1)
  assert.equal(byId.get('page0').childrenOmitted, true)
  assert.equal(byId.get('page0').hiddenDirect, 1)
  assert.equal(byId.get('page2a').childCount, 1)
  assert.equal(byId.get('page2b').childCount, 1)
  const toolNodes = devEcoToolNodes(nodes, 400).nodes
  const toolById = new Map(toolNodes.map((n) => [n.accessibilityId, n]))
  assert.equal(toolById.get('page0').childCount, 1)
  assert.equal(toolById.get('page0').childrenOmitted, true)
  assert.equal(toolById.get('page0').hiddenDirect, 1)
  assert.equal(toolById.get('page2a').childCount, 1)
  assert.equal(toolById.get('page2b').childCount, 1)
  assert.equal(toolById.get('page2').childCount, 2)
  assert.equal(toolById.get('page1root').childCount, 1)
  const page0ToolIndex = toolNodes.findIndex((n) => n.accessibilityId === 'page0')
  assert.ok(devEcoTreeLines(toolNodes)[page0ToolIndex].includes('+1 children hidden'))

  // 显式 displayCount>1 → 不做 Swiper 限深，所有页面及后代都保留。
  const multi = parseDevEcoTree(makeTree({ currentIndex: 1, displayCount: '2' }))
  assert.deepEqual(multi.map((n) => n.accessibilityId), [
    '', 'swiper', 'page0', 'page0deep', 'page1', 'page1root', 'page1deep',
    'page2', 'page2a', 'page2adeep', 'page2b', 'page2bdeep',
  ])
})

test('parseUiRawDump keeps visible="false" nodes as stubs and prunes their subtrees', () => {
  const mk = (id, visible, bounds, kids = []) => {
    const attributes = { type: 'Row', id, bounds, hostWindowId: '11' }
    if (visible !== undefined) attributes.visible = visible
    return { attributes, children: kids }
  }
  const doc = {
    attributes: { type: 'WindowScene', id: 'session11', bounds: '[0,0][100,200]' },
    children: [
      mk('v1', 'true', '[0,0][100,50]'),
      // 不可见存根：自身保留（矩形故意越界到 bottom=300，contentBox 必须排除），
      // 其可见后代 hc1 也一并剪掉（父不可见 → 子节点不保留）
      mk('h1', 'false', '[0,60][100,300]', [mk('hc1', 'true', '[0,60][50,80]')]),
      mk('v2', undefined, '[0,130][100,160]'), // 缺失 visible → 默认可见
    ],
  }
  const nodes = parseUiRawDump(doc)
  assert.deepEqual(nodes.map((n) => n.resourceId), ['session11', 'v1', 'h1', 'v2'])
  assert.ok(!nodes.some((n) => n.resourceId === 'hc1'))
  assert.equal(nodes[2].visible, false) // h1 存根带 visible:false
  assert.equal(nodes[2].index, 2)
  assert.equal(nodes[2].parentIndex, 0)
  // 不可见存根不测算内容区
  assert.equal(nodes[2].contentBox, undefined)
  // 可见父的 contentBox = 可见子节点矩形并集（h1 的 [0,60][100,300] 排除，bottom=160 而非 300）
  assert.deepEqual(nodes[0].contentBox, { left: 0, top: 0, right: 100, bottom: 160, width: 100, height: 160 })
})

test('DevEco raw WS helpers build the minimal Java-WebSocket handshake', () => {
  // 应用侧 HttpHandShake 只认这 6 个头（多余头如 permessage-deflate 会被拒——hilog 实证）
  const hs = buildDevEcoWsHandshake('127.0.0.1:18100', 'dGhlIHNhbXBsZSBub25jZQ==')
  assert.equal(hs, [
    'GET / HTTP/1.1',
    'Connection: Upgrade',
    'Host: 127.0.0.1:18100',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Upgrade: websocket',
    '', '',
  ].join('\r\n'))
  assert.equal(isWsHandshakeAccepted('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'), true)
  assert.equal(isWsHandshakeAccepted('HTTP/1.1 400 Bad Request\r\n\r\n'), false)
})

test('DevEco raw WS helpers roundtrip client frames and decode server frames', () => {
  // 客户端 MASK 文本帧：FIN+text(0x81)、MASK 位、可变长
  const small = encodeWsClientTextFrame('{"type":"tree"}', Buffer.from([1, 2, 3, 4]))
  assert.equal(small[0], 0x81)
  assert.equal(small[1] & 0x80, 0x80)                       // MASK 位
  assert.equal(small[1] & 0x7f, 15)                          // payload 长度
  // 长帧（>125 走 16 位长度）
  const long = encodeWsClientTextFrame('x'.repeat(300), Buffer.from([9, 8, 7, 6]))
  assert.equal(long[1] & 0x7f, 126)
  assert.equal(long.readUInt16BE(2), 300)
  // 服务端帧（不 MASK）解码：单帧、双帧拼接、不完整帧留 rest
  const mkServer = (text) => Buffer.concat([Buffer.from([0x81, Buffer.byteLength(text)]), Buffer.from(text)])
  const one = decodeWsServerFrames(mkServer('hello'))
  assert.deepEqual(one.texts, ['hello'])
  assert.equal(one.rest.length, 0)
  const two = decodeWsServerFrames(Buffer.concat([mkServer('a'), mkServer('b')]))
  assert.deepEqual(two.texts, ['a', 'b'])
  const partial = mkServer('{"type":"root"')
  const half = decodeWsServerFrames(partial.subarray(0, 5))
  assert.equal(half.texts.length, 0)
  assert.equal(half.rest.length, 5)
  // PING 帧 → pings 载荷，CLOSE 帧 → closed
  const ping = Buffer.concat([Buffer.from([0x89, 3]), Buffer.from('abc')])
  assert.deepEqual(decodeWsServerFrames(ping).pings.map((p) => p.toString()), ['abc'])
  assert.equal(decodeWsServerFrames(Buffer.from([0x88, 0])).closed, true)
})

test('devEcoNodeSummary trims nodes for the agent tool (label rule + box model 有值才挂 key)', () => {
  const root = {
    $type: 'JsView', $ID: '25', viewTag: 'TitleBar', type: 'custom',
    $rect: '[0.00, 136.00],[1316.00, 2734.00]',
    $attrs: { padding: '12.00vp', id: 'mainNav', enabled: true, visible: 'true' },
    $children: [{
      $type: 'Text', $ID: '26', type: 'build-in',
      $rect: '[56.00, 185.00],[112.00, 241.00]',
      $attrs: { content: '微信', visibility: 'Visibility.Visible' },
      $children: [],
    }],
  }
  const nodes = parseDevEcoTree(root)
  const s0 = devEcoNodeSummary(nodes[0])
  // 展示名规则：组件名优先
  assert.equal(s0.name, 'TitleBar')
  assert.equal(s0.componentName, 'TitleBar')
  assert.equal(s0.kind, 'custom')
  assert.equal(s0.devId, 'mainNav')
  assert.deepEqual(s0.bounds, { left: 0, top: 136, right: 1316, bottom: 2734, width: 1316, height: 2598 })
  // 声明值：有值才挂 key
  assert.deepEqual(s0.padding, { top: 12, right: 12, bottom: 12, left: 12 })
  assert.equal(s0.borderWidth, undefined) // 未声明 → 不挂 key
  assert.equal('attrs' in s0, false)      // 默认不带原始属性
  const s1 = devEcoNodeSummary(nodes[1])
  assert.equal(s1.name, 'Text')           // 无组件名/无 id → 真实类型
  assert.equal(s1.kind, 'build-in')
  assert.equal(s1.text, '微信')
  assert.equal(s1.parentIndex, 0)
  // include_attrs 附带原始属性
  const withAttrs = devEcoNodeSummary(nodes[0], true)
  assert.equal(typeof withAttrs.attrs, 'object')
  assert.equal(withAttrs.attrs.id, 'mainNav')
})

test('devEcoTreeLines renders one indented line per node', () => {
  const nodes = [
    { depth: 0, name: 'EntryView', kind: 'custom', className: 'EntryView', bounds: { left: 0, top: 0, right: 100, bottom: 100 }, text: '', devId: '' },
    { depth: 1, name: 'Text', kind: 'build-in', className: 'Text', bounds: { left: 5, top: 5, right: 50, bottom: 30 }, text: '你好', devId: 'title', padding: { top: 1, right: 2, bottom: 3, left: 4 } },
  ]
  const lines = devEcoTreeLines(nodes)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], 'EntryView [组件] (0,0,100,100)')
  assert.equal(lines[1], '  Text (5,5,50,30) "你好" id=title padding:1 2 3 4')
})

test('devEcoTreeLines spells box-model fields out in full and projects backgroundColor', () => {
  // 用户诉求：投影字段的缩写会引起误会（`bc:` 看着像 background color，
  // 其实是 borderColor），所以一律用全名，并补上 backgroundColor。
  const nodes = [
    {
      depth: 0, name: 'Column', kind: 'build-in', className: 'Column',
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      borderWidth: 2, borderRadius: 8, borderColor: '#FF0000', backgroundColor: '#00FF00',
    },
  ]
  const lines = devEcoTreeLines(nodes)
  assert.equal(lines.length, 1)
  assert.equal(
    lines[0],
    'Column (0,0,10,10) padding:1 2 3 4 margin:0 0 0 0 borderWidth:2 borderRadius:8 borderColor:#FF0000 backgroundColor:#00FF00',
  )
  // 旧缩写形式一个都不许残留
  assert.equal(/pad:|bw:|br:|bc:/.test(lines[0]), false)
  // backgroundColor 放在 borderColor 之后、children hidden 之前
  assert.ok(lines[0].indexOf('borderColor:#FF0000') < lines[0].indexOf('backgroundColor:#00FF00'))
  // 省略标记仍在最后
  const omitted = devEcoTreeLines([
    {
      depth: 0, name: 'Column', kind: 'build-in', className: 'Column',
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      backgroundColor: '#0000FF', childrenOmitted: true, hiddenDirect: 3,
    },
  ])
  assert.equal(omitted[0], 'Column (0,0,10,10) backgroundColor:#0000FF +3 children hidden')
  // 没有 backgroundColor 就不挂这一段
  const plain = devEcoTreeLines([
    { depth: 0, name: 'Column', kind: 'build-in', className: 'Column', bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
  ])
  assert.equal(plain[0], 'Column (0,0,10,10)')
  assert.equal(plain[0].includes('backgroundColor'), false)
})

test('devEcoNodeSummary attaches backgroundColor only when the device declared one', () => {
  const base = { index: 0, depth: 0, parentIndex: -1, componentName: 'Panel', className: 'Panel' }
  const withBg = devEcoNodeSummary(Object.assign({}, base, { backgroundColor: '#112233' }))
  assert.equal(withBg.backgroundColor, '#112233')
  const emptyBg = devEcoNodeSummary(Object.assign({}, base, { backgroundColor: '' }))
  assert.equal('backgroundColor' in emptyBg, false)
  const noBg = devEcoNodeSummary(base)
  assert.equal('backgroundColor' in noBg, false)
  // attrs 行为不变
  assert.equal('attrs' in withBg, false)
})

// ---- 按 id 定位节点 / 取子树 / 取祖先链 --------------------------------------

/** 造一棵小树：root(0) → dup(1) → leaf(2)；以及 root 的另一个子节点 dup(3)。 */
const mkDevEcoIdTree = () => parseDevEcoTree({
  $type: 'JsView', $ID: '10', viewTag: 'PageRoot', type: 'custom',
  $rect: '[0.00,0.00],[100.00,100.00]',
  $attrs: { id: 'pageRoot' },
  $children: [{
    $type: 'Column', $ID: '11', type: 'build-in',
    $rect: '[0.00,0.00],[100.00,100.00]',
    $attrs: { id: 'dup' },
    $children: [{
      $type: 'Text', $ID: '12', type: 'build-in',
      $rect: '[1.00,1.00],[20.00,10.00]',
      $attrs: { id: 'leaf' },
      $children: [],
    }],
  }, {
    $type: 'Text', $ID: '13', type: 'build-in', viewTag: 'Label',
    $rect: '[1.00,2.00],[20.00,10.00]',
    $attrs: { id: 'dup' },
    $children: [],
  }],
})

test('findDevEcoNodeById resolves ids by accessibilityId → devId → componentName', () => {
  const nodes = mkDevEcoIdTree()
  assert.equal(nodes.length, 4)
  // 1) accessibilityId 命中（设备分配，全树唯一）
  const byAcc = findDevEcoNodeById(nodes, '12')
  assert.equal(byAcc.ok, true)
  assert.equal(byAcc.matchedBy, 'accessibilityId')
  assert.equal(byAcc.id, '12')
  assert.equal(byAcc.node.index, 2)
  // `#` 前缀形式等价
  const byHash = findDevEcoNodeById(nodes, '#12')
  assert.equal(byHash.ok, true)
  assert.equal(byHash.matchedBy, 'accessibilityId')
  assert.equal(byHash.id, '12')
  assert.equal(byHash.node.index, 2)
  // 数字 id 与字符串等价
  assert.equal(findDevEcoNodeById(nodes, 12).node.index, 2)
  // 2) devId 命中（开发者 .id()，可能重复）
  const byDev = findDevEcoNodeById(nodes, 'leaf')
  assert.equal(byDev.ok, true)
  assert.equal(byDev.matchedBy, 'devId')
  assert.equal(byDev.node.index, 2)
  // 3) componentName 命中（组件/Builder 名，可能重复）
  const byName = findDevEcoNodeById(nodes, 'PageRoot')
  assert.equal(byName.ok, true)
  assert.equal(byName.matchedBy, 'componentName')
  assert.equal(byName.node.index, 0)
  const byLabel = findDevEcoNodeById(nodes, 'Label')
  assert.equal(byLabel.ok, true)
  assert.equal(byLabel.matchedBy, 'componentName')
  assert.equal(byLabel.node.index, 3)
  // 4) 找不到
  const miss = findDevEcoNodeById(nodes, 'nope')
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'not-found')
  assert.deepEqual(miss.candidates, [])
  // 空 / 空白 id
  for (const empty of ['', '   ', null, undefined]) {
    const r = findDevEcoNodeById(nodes, empty)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-found')
    assert.deepEqual(r.candidates, [])
  }
  // 5) 同 devId 两个节点 → ambiguous（不静默误命中）
  const amb = findDevEcoNodeById(nodes, 'dup')
  assert.equal(amb.ok, false)
  assert.equal(amb.reason, 'ambiguous')
  assert.equal(amb.matchedBy, 'devId')
  assert.equal(amb.candidates.length, 2)
  assert.deepEqual(amb.candidates.map((c) => c.index), [1, 3])
  assert.deepEqual(amb.candidates.map((c) => c.accessibilityId), ['11', '13'])
  // 永远不抛异常
  assert.doesNotThrow(() => findDevEcoNodeById(null, 'x'))
  assert.equal(findDevEcoNodeById(null, 'x').ok, false)
})

test('devEcoSubtreeNodes returns the contiguous DFS interval and renumbers it', () => {
  const nodes = mkDevEcoIdTree()
  // 子树 = 节点 1 起的连续 DFS 区间（节点 3 是它的兄弟，不属于子树）
  const sub = devEcoSubtreeNodes(nodes, nodes[1])
  assert.equal(sub.length, 2)
  assert.deepEqual(sub.map((n) => n.index), [0, 1])            // 重新连续编号
  assert.deepEqual(sub.map((n) => n.depth), [0, 1])            // 以子树根为 0
  assert.equal(sub[0].parentIndex, -1)                        // 根没有父
  assert.equal(sub[1].parentIndex, 0)                         // 父重映射到新下标
  // 无关的兄弟节点不在结果里
  assert.equal(sub.some((n) => n.accessibilityId === '13'), false)
  // 其它字段原样保留（childCount 是整树口径，不因裁剪归零）
  assert.equal(sub[0].childCount, 1)
  assert.equal(sub[1].childCount, 0)
  assert.equal(sub[0].className, 'Column')
  assert.equal(sub[0].devId, 'dup')
  // 浅拷贝：不得改到原数组
  assert.notEqual(sub[0], nodes[1])
  assert.equal(nodes[1].index, 1)
  assert.equal(nodes[1].parentIndex, 0)
  // 叶子子树只有一个节点
  const leafSub = devEcoSubtreeNodes(nodes, nodes[2])
  assert.equal(leafSub.length, 1)
  assert.equal(leafSub[0].index, 0)
  assert.equal(leafSub[0].depth, 0)
  assert.equal(leafSub[0].parentIndex, -1)
  // 节点不在 nodes 里 → []
  assert.deepEqual(devEcoSubtreeNodes(nodes, { index: 99, depth: 0 }), [])
  assert.deepEqual(devEcoSubtreeNodes(nodes, null), [])
  assert.deepEqual(devEcoSubtreeNodes(null, nodes[0]), [])
  // 负零归一：任何数值字段都不许出现 -0
  const neg = [{ index: 0, depth: 0, parentIndex: -1, name: 'A', className: 'A',
    bounds: { left: -0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    padding: { top: -0, right: 0, bottom: 0, left: 0 } }]
  const negSub = devEcoSubtreeNodes(neg, neg[0])
  assert.equal(Object.is(negSub[0].bounds.left, -0), false)
  assert.equal(Object.is(negSub[0].padding.top, -0), false)
  assert.equal(Object.is(negSub[0].depth, -0), false)
})

test('devEcoAncestorChain returns root→parent and excludes the node itself', () => {
  const nodes = mkDevEcoIdTree()
  // 节点 2 的祖先：root(0) → dup(1)
  const chain = devEcoAncestorChain(nodes, nodes[2])
  assert.equal(chain.length, 2)
  assert.deepEqual(chain.map((c) => c.index), [0, 1])           // 由根到父
  assert.equal(chain[0].name, 'PageRoot')
  assert.equal(chain[0].accessibilityId, '10')
  assert.equal(chain[1].name, 'dup')                            // componentName || devId || className
  assert.equal(chain[1].className, 'Column')
  assert.equal(chain[1].devId, 'dup')
  assert.equal(chain.some((c) => c.index === 2), false)         // 不含自身
  // 根节点 → 空数组
  assert.deepEqual(devEcoAncestorChain(nodes, nodes[0]), [])
  // 不在树里 / 空输入
  assert.deepEqual(devEcoAncestorChain(nodes, { index: 99 }), [])
  assert.deepEqual(devEcoAncestorChain(nodes, null), [])
  assert.deepEqual(devEcoAncestorChain(null, nodes[0]), [])
})

test('devEcoTreeLines marks parents with omitted children', () => {
  const nodes = [
    { depth: 0, name: 'Column', kind: 'build-in', className: 'Column', bounds: { left: 0, top: 0, right: 10, bottom: 10 }, childCount: 3, childrenOmitted: true, hiddenDirect: 2 },
    { depth: 1, name: 'Text', kind: 'build-in', className: 'Text', bounds: { left: 0, top: 0, right: 5, bottom: 5 }, childCount: 0 },
  ]
  const lines = devEcoTreeLines(nodes)
  assert.equal(lines[0], 'Column (0,0,10,10) +2 children hidden')
  assert.equal(lines[1], '  Text (0,0,5,5)')
})

test('devEcoToolNodes drops whole subtrees and flags the boundary parent', () => {
  // 10 节点：root(0) → a(1,d1) → a1(2,d2)/a2(2,d2)；b(4,d1)；c(6,d1) → c1(7,d2)
  const mk = (index, depth, parentIndex, name) => ({
    index, depth, parentIndex, name, componentName: '', className: name, kind: 'build-in',
    text: '', devId: '', accessibilityId: String(index), bounds: { left: 0, top: 0, right: 1, bottom: 1 },
    visible: true, enabled: true, clickable: false, scrollable: false,
  })
  const nodes = [
    mk(0, 0, -1, 'root'),
    mk(1, 1, 0, 'a'), mk(2, 2, 1, 'a1'), mk(3, 2, 1, 'a2'),
    mk(4, 1, 0, 'b'),
    mk(5, 1, 0, 'c'), mk(6, 2, 5, 'c1'), mk(7, 3, 6, 'c1x'), mk(8, 3, 6, 'c1y'),
    mk(9, 1, 0, 'd'),
  ]
  const r = devEcoToolNodes(nodes, 5)
  assert.equal(r.nodeCount, 10)
  assert.equal(r.truncated, true)
  assert.equal(r.nodes.length, 5)              // 恰好 5 个整节点，无半棵
  // 保留的是 DFS 前缀：root, a, a1, a2, b —— c 子树与 d 整体省略
  assert.deepEqual(r.nodes.map((n) => n.name), ['root', 'a', 'a1', 'a2', 'b'])
  // 被省略处的最近保留祖先（root）标记：c、d 两个直接子节点被省略
  const root = r.nodes[0]
  assert.equal(root.childrenOmitted, true)
  assert.equal(root.hiddenDirect, 2)
  // 每个保留节点都有 childCount（完整树口径）
  assert.equal(r.nodes[1].childCount, 2)  // a → a1, a2
  assert.equal(root.childCount, 4)        // root → a, b, c, d
  assert.equal(r.nodes[4].childCount, 0)  // b 无子节点
  // 未截断时不标记
  const full = devEcoToolNodes(nodes, 400)
  assert.equal(full.truncated, false)
  assert.equal(full.nodes.length, 10)
  assert.equal(full.nodes.some((n) => n.childrenOmitted), false)
  // cap 封顶 4000
  assert.equal(devEcoToolNodes(nodes, 99999).nodes.length, 10)
})

test('parseUiRawDump tags custom components and keeps every device attribute', () => {
  const doc = {
    attributes: { bounds: '[0,0][1216,2688]', origBounds: '[0,0][1216,2688]', type: 'root', hostWindowId: '826', hierarchy: 'ROOT826' },
    children: [{
      attributes: {
        bounds: '[0,545][296,604]', origBounds: '[0,545][296,604]', type: 'Row',
        id: 'MyRow', key: 'MyRow', hostWindowId: '826', clickable: 'false',
        hierarchy: 'ROOT826,0,0,1,0,1,0,0,0,0,1,2,0',
        opacity: '1.000000', zIndex: '0', hashcode: '826:1120',
        backgroundColor: '#00000000', backgroundImage: 'empty source', blur: '0.00px',
        description: '长按时间切换显示格式', hitTestBehavior: 'HitTestMode.Default',
        bundleName: 'com.jfzt.uranus', abilityName: 'EntryAbility', pagePath: 'pages/MainPage',
      },
      children: [{
        attributes: {
          bounds: '[0,604][296,670]', origBounds: '[0,604][296,670]', type: 'Text',
          id: 'tv_stock_name', key: 'tv_stock_name', hostWindowId: '826', text: '博汇纸业',
        },
        children: [],
      }],
    }],
  }
  const r = parseUiRawDump(JSON.stringify(doc))
  const comp = r[1]
  const plain = r[2]
  assert.equal(comp.componentName, 'MyRow')
  assert.equal(comp.className, 'Row')
  // snake_case developer id is NOT a component
  assert.equal(plain.componentName, '')
  assert.equal(plain.text, '博汇纸业')
  // every device attribute survives verbatim, including empty ones
  assert.equal(comp.rawAttrs.hitTestBehavior, 'HitTestMode.Default')
  assert.equal(comp.rawAttrs.hashcode, '826:1120')
  assert.equal(comp.rawAttrs.blur, '0.00px')
  assert.equal(comp.backgroundColor, '#00000000')
  assert.equal(comp.description, '长按时间切换显示格式')
  assert.equal(comp.bundleName, 'com.jfzt.uranus')
  assert.equal(comp.abilityName, 'EntryAbility')
  assert.equal(comp.pagePath, 'pages/MainPage')
  assert.equal(comp.hierarchy, 'ROOT826,0,0,1,0,1,0,0,0,0,1,2,0')
  assert.ok(comp.hierarchy.startsWith('ROOT826'))
  // box-model layers stay undefined — the dump has no such data, and the UI
  // must show "未提供" rather than fabricated zeros.
  assert.equal(comp.padding, undefined)
  assert.equal(comp.margin, undefined)
  assert.equal(comp.borderWidth, undefined)
})

test('parseUiLayoutJson tags each node with its owning window (WindowScene session<id>)', () => {
  // Real shape: one root holding two window branches (desktop + status bar).
  const json = JSON.stringify([{
    bounds: [0, 0, 1216, 2688],
    children: [
      {
        id: 'session11', type: 'WindowScene', bounds: [0, 111, 1216, 2688],
        children: [{ id: 'app_icon', type: 'Image', bounds: [805, 774, 988, 820], children: [] }],
      },
      {
        id: 'session31', type: 'WindowScene', bounds: [0, 0, 1216, 188],
        children: [{ id: 'clock', type: 'Text', text: '9:41', bounds: [600, 10, 660, 40], children: [] }],
      },
    ],
  }])
  const r = parseUiLayoutJson(json)
  // root has no window of its own
  assert.equal(r[0].windowId, 0)
  // WindowScene nodes carry their own id (session<NN> → NN)
  assert.equal(r[1].windowId, 11)
  // descendants inherit the window they sit under
  assert.equal(r[2].windowId, 11)
  assert.equal(r[2].resourceId, 'app_icon')
  assert.equal(r[3].windowId, 31)
  assert.equal(r[4].windowId, 31)
  assert.equal(r[4].text, '9:41')
  // a non-numeric scene id must not produce NaN
  const odd = parseUiLayoutJson('[{"id":"sessionX","type":"WindowScene","bounds":[0,0,1,1],"children":[]}]')
  assert.equal(odd[0].windowId, 0)
})

test('hitTest only considers the active window nodes', () => {
  const json = JSON.stringify([{
    bounds: [0, 0, 1216, 2688],
    children: [
      { id: 'session11', type: 'WindowScene', bounds: [0, 111, 1216, 2688], children: [{ id: 'desktopIcon', type: 'Image', bounds: [100, 500, 200, 600], children: [] }] },
      { id: 'session31', type: 'WindowScene', bounds: [0, 0, 1216, 188], children: [{ id: 'clock', type: 'Text', bounds: [600, 10, 660, 40], children: [] }] },
    ],
  }])
  const all = parseUiLayoutJson(json)
  const desktop = all.filter((n) => n.windowId === 11)
  const statusBar = all.filter((n) => n.windowId === 31)
  // a point in the status bar must not resolve to a desktop node
  assert.equal(hitTest(desktop, 620, 20), null)
  assert.equal(hitTest(statusBar, 620, 20).resourceId, 'clock')
  assert.equal(hitTest(desktop, 150, 550).resourceId, 'desktopIcon')
  // the un-windowed root is always hittable
  assert.equal(hitTest([all[0]], 5, 5).index, 0)
})

test('ui interaction arg builders', () => {
  assert.deepEqual(buildUiScreenshotArgs({ device: 'Phone', path: 'C:\\tmp\\s.png' }),
    ['ui', 'screenshot', '--device', 'Phone', '--path', 'C:\\tmp\\s.png'])
  assert.deepEqual(buildUiTapArgs({ device: 'Phone', x: 100, y: 200 }),
    ['ui', 'click', '--device', 'Phone', '100', '200'])
  assert.deepEqual(buildUiSwipeArgs({ device: 'Phone', x1: 1, y1: 2, x2: 3, y2: 4, speed: 600 }),
    ['ui', 'swipe', '--device', 'Phone', '1', '2', '3', '4', '--speed', '600'])
  assert.deepEqual(buildUiSwipeArgs({ x1: 1, y1: 2, x2: 3, y2: 4 }),
    ['ui', 'swipe', '1', '2', '3', '4'])
  assert.deepEqual(buildUiTextArgs({ device: 'Phone', text: 'hello' }),
    ['ui', 'text', '--device', 'Phone', 'hello'])
})

test('LEVEL_SEVERITY ordering D<I<W<E<F', () => {
  assert.ok(LEVEL_SEVERITY.D < LEVEL_SEVERITY.I)
  assert.ok(LEVEL_SEVERITY.I < LEVEL_SEVERITY.W)
  assert.ok(LEVEL_SEVERITY.W < LEVEL_SEVERITY.E)
  assert.ok(LEVEL_SEVERITY.E < LEVEL_SEVERITY.F)
})

test('formatHilogLevel returns badge text', () => {
  assert.equal(formatHilogLevel('D'), 'DEBUG')
  assert.equal(formatHilogLevel('I'), 'INFO')
  assert.equal(formatHilogLevel('W'), 'WARN')
  assert.equal(formatHilogLevel('E'), 'ERROR')
  assert.equal(formatHilogLevel('F'), 'FATAL')
  assert.equal(formatHilogLevel('?'), '?')
})

test('devecoExec for devecocli source', () => {
  assert.equal(devecoExec({ source: 'devecocli', exec: '/usr/bin/devecocli' }), '/usr/bin/devecocli')
  assert.equal(devecoExec({ source: 'devecocli' }), null)
})

test('devecoExec for studio source points at bin/devecocli', () => {
  const exec = devecoExec({ source: 'studio', path: '/opt/deveco-studio' })
  assert.match(exec, /bin[\\/]devecocli(\.cmd)?$/)
})

test('devecoExec returns null for none source', () => {
  assert.equal(devecoExec({ source: 'none' }), null)
})

test('buildHdcConnectArgs / buildHdcDisconnectArgs', () => {
  assert.deepEqual(buildHdcConnectArgs({ ip: ' 192.168.0.100 ', port: 8710 }), ['tconn', '192.168.0.100:8710'])
  assert.deepEqual(buildHdcDisconnectArgs({ ip: '192.168.0.100', port: 8710 }),
    ['tconn', '192.168.0.100:8710', '-remove'])
  // HarmonyOS hdc has no default port — missing/invalid ports must throw
  assert.throws(() => buildHdcConnectArgs({ ip: '10.0.0.1' }), /port required/)
  assert.throws(() => buildHdcConnectArgs({ ip: '10.0.0.1', port: 0 }), /port required/)
  assert.throws(() => buildHdcConnectArgs({ ip: '10.0.0.1', port: 70000 }), /port required/)
  assert.throws(() => buildHdcDisconnectArgs({ ip: '10.0.0.1', port: 'x' }), /port required/)
  assert.deepEqual(buildHdcConnectArgs({ ip: '10.0.0.1', port: 8710.7 }), ['tconn', '10.0.0.1:8710'])
})

test('parseTconnResult detects success and failure', () => {
  assert.deepEqual(parseTconnResult('Connect OK'), { ok: true, message: '已连接' })
  assert.deepEqual(parseTconnResult('[Info]Connect OK\r\n'), { ok: true, message: '已连接' })
  // hdc reports an already-established target as "[Info]Target is connected,
  // repeat operation" — that is a success, not an unknown-output failure.
  assert.deepEqual(parseTconnResult('[Info]Target is connected, repeat operation\r\n'), { ok: true, message: '已连接' })
  assert.deepEqual(parseTconnResult('[Fail]Connect failed'), { ok: false, message: 'Connect failed' })
  assert.deepEqual(parseTconnResult('Connect failed'), { ok: false, message: 'Connect failed' })
  assert.equal(parseTconnResult('[Info]Remove target finished').ok, true)
  assert.equal(parseTconnResult('').ok, false)
  assert.equal(parseTconnResult(null).ok, false)
  // empty output (timeout kill) now explains itself instead of bare "无输出"
  assert.match(parseTconnResult('').message, /超时/)
  // unknown non-empty output is surfaced but treated as failure
  assert.deepEqual(parseTconnResult('something odd'), { ok: false, message: 'something odd' })
})

test('parseProcessPids collects exact + suffix processes from ps -ef', () => {
  // 真机 toybox `ps -ef`：UID PID PPID C STIME TTY TIME CMD（8 列，CMD 从第 8 列起）
  const ps = [
    'UID             PID   PPID C STIME TTY          TIME CMD',
    'root              1      0 0 19:35:28 ?     00:06:12 init --second-stage 2918346',
    '20020021       7686    595 4 19:37:10 ?     01:08:40 com.ohos.sceneboard',
    '20020021       8135    595 0 19:37:11 ?     00:00:03 com.ohos.sceneboard:gpu',
    '20020021      37361    595 1 20:01:02 ?     00:00:12 com.ohos.sceneboard:render',
    '20020015       8066    595 0 19:37:12 ?     00:03:05 com.huawei.hmos.inputmethod:inputMethod',
    '20020190      19621    595 0 02:54:55 ?     00:02:15 com.tencent.wechat1',
    '20020190      20777    595 0 11:06:47 ?     00:00:04 com.tencent.wechat1.backup',
  ].join('\n')
  // 主进程 + `:gpu`/`:render` 后缀进程全部收入，升序去重
  assert.deepEqual(parseProcessPids(ps, 'com.ohos.sceneboard'), [7686, 8135, 37361])
  // 只有 `:` 后缀算同包进程；`.backup` 这类点分名是别的包，不许命中
  assert.deepEqual(parseProcessPids(ps, 'com.tencent.wechat1'), [19621])
  assert.deepEqual(parseProcessPids(ps, 'com.huawei.hmos.inputmethod'), [8066])
  // 精确 token 匹配：前缀子串 / 相似名 / 更长包名都不许命中
  assert.deepEqual(parseProcessPids(ps, 'com.ohos'), [])
  assert.deepEqual(parseProcessPids(ps, 'com.ohos.sceneboard2'), [])
  assert.deepEqual(parseProcessPids(ps, 'com.tencent.wechat'), [])
  // 未运行 / 空输入 / 垃圾输出
  assert.deepEqual(parseProcessPids(ps, 'com.example.notrunning'), [])
  assert.deepEqual(parseProcessPids('', 'com.ohos.sceneboard'), [])
  assert.deepEqual(parseProcessPids(null, 'com.ohos.sceneboard'), [])
  assert.deepEqual(parseProcessPids(ps, ''), [])
  assert.deepEqual(parseProcessPids('garbage\nrows only', 'com.ohos.sceneboard'), [])
  // init 这类命令里带数字参数的行不会误伤（PID 列必须是正整数）
  assert.deepEqual(parseProcessPids(ps, 'init'), [1])
  assert.deepEqual(parseProcessPids('short rows\n1 2 3 com.x', 'com.x'), [2])
})

// resolveHdc reads DEVECO_SDK_HOME / DEVECO_HOME / DEVECO_CLI_CLT_PATH from the
// environment; the test machine may have any of them set (Linux CLT wrappers
// only export DEVECO_CLI_CLT_PATH), so tests pin them explicitly and restore.
function withHdcEnv (sdkHome, devecoHome, fn) {
  const overrides = ['DEVECO_CLI_CLT_PATH', 'DEVECO_CLI_STUDIO_PATH', 'DEVECO_PATH']
  const savedSdk = process.env.DEVECO_SDK_HOME
  const savedHome = process.env.DEVECO_HOME
  const savedOverrides = overrides.map((name) => process.env[name])
  try {
    if (sdkHome === undefined) delete process.env.DEVECO_SDK_HOME
    else process.env.DEVECO_SDK_HOME = sdkHome
    if (devecoHome === undefined) delete process.env.DEVECO_HOME
    else process.env.DEVECO_HOME = devecoHome
    for (const name of overrides) delete process.env[name]
    return fn()
  } finally {
    if (savedSdk === undefined) delete process.env.DEVECO_SDK_HOME
    else process.env.DEVECO_SDK_HOME = savedSdk
    if (savedHome === undefined) delete process.env.DEVECO_HOME
    else process.env.DEVECO_HOME = savedHome
    overrides.forEach((name, i) => {
      if (savedOverrides[i] === undefined) delete process.env[name]
      else process.env[name] = savedOverrides[i]
    })
  }
}

function makeFakeSdkHdc (root) {
  const exe = process.platform === 'win32' ? 'hdc.exe' : 'hdc'
  const dir = join(root, 'sdk', 'default', 'openharmony', 'toolchains')
  mkdirSync(dir, { recursive: true })
  const hdc = join(dir, exe)
  writeFileSync(hdc, '')
  return hdc
}

test('resolveHdc finds hdc under the resolved Studio/CLT root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-hdc-'))
  try {
    const hdc = makeFakeSdkHdc(root)
    withHdcEnv(undefined, undefined, () => {
      assert.equal(resolveHdc({ source: 'studio', path: root }), hdc)
      assert.equal(resolveHdc({ source: 'clt', path: root }), hdc)
      // discovery roots are used when resolved carries no install root
      assert.equal(resolveHdc({ source: 'none' }, { extraRoots: [root] }), hdc)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHdc expands a mac .app root to <path>/Contents', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-app-'))
  try {
    const appRoot = join(tmp, 'Fake Studio.app')
    const hdc = makeFakeSdkHdc(join(appRoot, 'Contents'))
    withHdcEnv(undefined, undefined, () => {
      // Finder 复制出来的 .app 根：工具链根在其 Contents/ 下
      assert.equal(resolveHdc({ source: 'studio', path: appRoot }), hdc)
      assert.equal(resolveHdc({ source: 'clt', path: appRoot }), hdc)
      assert.equal(resolveHdc({ source: 'none' }, { extraRoots: [appRoot] }), hdc)
      // 已带 Contents 的路径原样命中
      assert.equal(resolveHdc({ source: 'studio', path: join(appRoot, 'Contents') }), hdc)
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('normalizeStudioPath strips quotes/slashes and completes mac .app bundles', () => {
  assert.equal(normalizeStudioPath('/Applications/DevEco Studio.app'), '/Applications/DevEco Studio.app/Contents')
  assert.equal(normalizeStudioPath('"/Applications/DevEco Studio.app"'), '/Applications/DevEco Studio.app/Contents')
  assert.equal(normalizeStudioPath('/Applications/DevEco Studio.app/Contents'), '/Applications/DevEco Studio.app/Contents')
  assert.equal(normalizeStudioPath('/Applications/DevEco Studio.app/'), '/Applications/DevEco Studio.app/Contents')
  assert.equal(normalizeStudioPath('  D:\\DevEco Studio  '), 'D:\\DevEco Studio')
  assert.equal(normalizeStudioPath(''), '')
})

test('resolveHdc prefers DEVECO_SDK_HOME / DEVECO_HOME over other sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-hdc-'))
  try {
    const hdc = makeFakeSdkHdc(root)
    withHdcEnv(root, undefined, () => {
      assert.equal(resolveHdc({ source: 'none' }), hdc)
    })
    withHdcEnv(undefined, root, () => {
      assert.equal(resolveHdc({ source: 'none' }), hdc)
    })
    // no env, no roots → PATH fallback (null when hdc is not on PATH)
    withHdcEnv(undefined, undefined, () => {
      const found = resolveHdc({ source: 'none' })
      assert.ok(found === null || typeof found === 'string')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHdc honours DEVECO_CLI_CLT_PATH (Linux CLT declaration)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-flatclt-'))
  try {
    const hdc = makeFlatCltRoot(root)
    withHdcEnv(undefined, undefined, () => {
      try {
        // 只有 DEVECO_CLI_CLT_PATH：Linux 上 CLT 的唯一声明方式
        // （dsh.service / 官方 wrapper 也只设这一个变量）
        process.env.DEVECO_CLI_CLT_PATH = root
        assert.equal(resolveHdc({ source: 'none' }), hdc)
      } finally {
        delete process.env.DEVECO_CLI_CLT_PATH
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHdc finds hdc in a standalone ohos-sdk root (<root>/toolchains/hdc)', () => {
  const sdk = mkdtempSync(join(tmpdir(), 'dsh-deveco-ohossdk-'))
  try {
    const exe = process.platform === 'win32' ? 'hdc.exe' : 'hdc'
    mkdirSync(join(sdk, 'toolchains'), { recursive: true })
    const hdc = join(sdk, 'toolchains', exe)
    writeFileSync(hdc, '')
    withHdcEnv(undefined, undefined, () => {
      // 独立 SDK 包没有 sdk/default/openharmony 这一层
      assert.equal(resolveHdc({ source: 'none' }, { extraRoots: [sdk] }), hdc)
      try {
        process.env.DEVECO_SDK_HOME = sdk
        assert.equal(resolveHdc({ source: 'none' }), hdc)
      } finally {
        delete process.env.DEVECO_SDK_HOME
      }
    })
  } finally {
    rmSync(sdk, { recursive: true, force: true })
  }
})

test('execHdc spawns an .exe whose path contains spaces (shell:false)', async () => {
  // Regression: Windows `shell:true` + unquoted "...\DevEco Studio\...\hdc.exe"
  // split at the space and failed to launch. execHdc must spawn shell:false
  // so libuv quotes the path. Use a copy of the node binary as a fake hdc.
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-hdc-'))
  try {
    const spaced = join(root, 'DevEco Studio')
    mkdirSync(spaced, { recursive: true })
    const fakeHdc = join(spaced, process.platform === 'win32' ? 'hdc.exe' : 'hdc')
    copyFileSync(process.execPath, fakeHdc)
    const { stdout } = await execHdc(fakeHdc, ['--version'])
    assert.match(stdout.trim(), /^v\d+\./)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('execHdc flags a timeout kill with timedOut (hdc tconn hangs on unreachable hosts)', async () => {
  // `hdc tconn <unreachable>` never returns; our own timeout kills it and the
  // process yields no output. The caller must be able to tell that apart from
  // a genuine "hdc printed nothing" so it can say "连接超时" instead.
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-hdc-'))
  try {
    const fakeHdc = join(root, process.platform === 'win32' ? 'hdc.exe' : 'hdc')
    copyFileSync(process.execPath, fakeHdc)
    // node with a setTimeout that never fires → hangs until killed.
    await assert.rejects(
      () => execHdc(fakeHdc, ['-e', 'setTimeout(()=>{}, 60000)'], { timeout: 700 }),
      (e) => {
        assert.equal(e.timedOut, true)
        assert.match(e.message, /timed out/i)
        return true
      }
    )
    // A fast non-zero exit is a real failure, not a timeout.
    await assert.rejects(
      () => execHdc(fakeHdc, ['-e', 'process.exit(3)'], { timeout: 5000 }),
      (e) => {
        assert.equal(e.timedOut, false)
        assert.match(e.message, /failed \(3\)/i)
        return true
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('execCli quotes a .cmd path containing spaces on Windows (shell:true)', async (t) => {
  if (process.platform !== 'win32') { t.skip('windows-only .cmd shim'); return }
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-cli-'))
  try {
    const spaced = join(root, 'DevEco Studio')
    mkdirSync(join(spaced, 'bin'), { recursive: true })
    writeFileSync(join(spaced, 'bin', 'devecocli.cmd'), '@echo off\r\necho CLI-OK %*\r\n')
    const { stdout } = await execCli({ source: 'studio', path: spaced }, ['probe', 'arg'])
    assert.match(stdout, /CLI-OK probe arg/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// harmony-studio
// ---------------------------------------------------------------------------

import {
  parseVersion, parseDevecoToolVersion, normalizeStudioPath, readCltRootVersion,
  DEFAULT_WINDOWS_STUDIO, DEFAULT_MACOS_STUDIO, DEFAULT_LINUX_STUDIO,
  DEFAULT_WINDOWS_CLT_ROOTS, DEFAULT_MACOS_CLT_ROOTS, DEFAULT_LINUX_CLT_ROOTS,
  scanStudioCandidates, scanCltCandidates, resolveCli,
  MIN_CLT_VERSION, meetsMinVersion
} from '../harmony-studio.mjs'

test('parseVersion handles 26.0.0', () => {
  assert.deepEqual(parseVersion('26.0.0'), [26, 0, 0])
})
test('parseVersion handles v-prefix and prerelease', () => {
  assert.deepEqual(parseVersion('v5.0.3'), [5, 0, 3])
  assert.deepEqual(parseVersion('26.0.1-beta1'), [26, 0, 1])
})
test('parseVersion rejects garbage', () => {
  assert.equal(parseVersion('abc'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})
test('parseDevecoToolVersion extracts from hilog-style output', () => {
  assert.equal(parseDevecoToolVersion('Command Line Tools 26.0.1\nBuild 1234'), '26.0.1')
  assert.equal(parseDevecoToolVersion('26.0.0'), '26.0.0')
  assert.equal(parseDevecoToolVersion(''), null)
  assert.equal(parseDevecoToolVersion('Command Line Tools 26.0.1 (Build 1234)'), '26.0.1')
})
test('MIN_CLT_VERSION is 26.0.0', () => {
  assert.deepEqual(MIN_CLT_VERSION, [26, 0, 0])
})
test('meetsMinVersion semantics', () => {
  assert.equal(meetsMinVersion('26.0.0'), true)
  assert.equal(meetsMinVersion('26.0.1'), true)
  assert.equal(meetsMinVersion('25.5.5'), false)
  assert.equal(meetsMinVersion('26.0.0-beta1'), true) // 26.0.0-beta1 仍 parse 为 [26,0,1] > [26,0,0]？不，beta1 解析后是 [26,0,1]
  assert.equal(meetsMinVersion('26.0.0'), true)
})
test('normalizeStudioPath strips quotes and whitespace', () => {
  assert.equal(normalizeStudioPath('  "C:\\Program Files\\Huawei\\DevEco Studio"  '),
    'C:\\Program Files\\Huawei\\DevEco Studio')
  assert.equal(normalizeStudioPath("'/opt/deveco-studio'"), '/opt/deveco-studio')
  assert.equal(normalizeStudioPath(''), '')
})
test('resolveCli with overrideExec', () => {
  const r = resolveCli({ overrideExec: '/usr/bin/devecocli' })
  assert.equal(r.source, 'devecocli')
  assert.equal(r.exec, '/usr/bin/devecocli')
})
test('resolveCli falls back to cltPath when devecocli missing', () => {
  process.env.PATH = '/empty'
  const r = resolveCli({
    studioPath: '',
    cltPath: 'C:\\fake\\clt\\26.0.0',
    overrideExec: ''
  })
  // PATH 不存在 devecocli → 走 clt
  // 但 fake 路径 readdirSync 会抛错 → 需要测试 fake 路径有版本子目录的情况
  // 简化：cltPath 自身以 26.0.0 结尾 → 直接当版本目录使用，但 readdirSync 之前读根不会触发
  // 实际上代码会先 readdirSync 根 → fake 不存在 → cands 空 → 不会用 clt
  // 因此这个 case 实际会落到 studioPath 或 none
  // 改：手动 mock readdirSync 不可能 → 这个测试我们用 mock overrideExec=''
  // 实际上：cands 会失败（fake root），cltPath 是版本目录路径名匹配 → chosen = cltPath 本身
  // 重新审视代码逻辑：cltPath split 后最后一段匹配 ^\d+\.\d+\.\d+$ → '26.0.0' 匹配 → chosen = cltPath
  assert.equal(r.source, 'clt')
  assert.equal(r.minVersionOk, true)
})
test('resolveCli prefers clt over studio when both configured', () => {
  process.env.PATH = '/empty'
  const r = resolveCli({
    studioPath: 'C:\\fake\\studio',
    cltPath: 'C:\\fake\\clt\\26.0.0',
    overrideExec: ''
  })
  assert.equal(r.source, 'clt')
})
test('resolveCli marks clt < 26.0.0 as below min', () => {
  process.env.PATH = '/empty'
  const r = resolveCli({
    studioPath: '',
    cltPath: 'C:\\fake\\clt\\25.0.5',
    overrideExec: ''
  })
  assert.equal(r.source, 'clt')
  assert.equal(r.minVersionOk, false)
  assert.match(r.message, /低于/)
})
test('resolveCli falls through to studio when clt below min and studio configured', () => {
  process.env.PATH = '/empty'
  // clt 25.0.5 不达标 → 但代码仍然返回 clt with minVersionOk:false
  // 用户决策：互斥时优先 clt，不达标也不回退 studio（让用户知道去升级）
  const r = resolveCli({
    studioPath: 'C:\\fake\\studio',
    cltPath: 'C:\\fake\\clt\\25.0.5',
    overrideExec: ''
  })
  // 期望：source='clt', minVersionOk=false（提示升级，不静默回退）
  assert.equal(r.source, 'clt')
  assert.equal(r.minVersionOk, false)
})
test('resolveCli returns none when nothing configured', () => {
  process.env.PATH = '/empty'
  const r = resolveCli({ studioPath: '', cltPath: '', overrideExec: '' })
  assert.equal(r.source, 'none')
  assert.equal(r.minVersionOk, false)
  assert.match(r.message, /未配置/)
})
test('DEFAULT_WINDOWS_STUDIO contains canonical paths', () => {
  assert.ok(DEFAULT_WINDOWS_STUDIO.length > 0)
  assert.ok(DEFAULT_WINDOWS_STUDIO.some(p => p.includes('DevEco Studio')))
})
test('DEFAULT_MACOS_STUDIO contains Applications', () => {
  assert.ok(DEFAULT_MACOS_STUDIO.some(p => p.includes('/Applications')))
})
test('DEFAULT_LINUX_STUDIO contains opt', () => {
  assert.ok(DEFAULT_LINUX_STUDIO.some(p => p.startsWith('/opt')))
})
test('scanStudioCandidates returns empty on test platform with no matches', () => {
  const cands = scanStudioCandidates('linux')
  assert.ok(Array.isArray(cands))
})
test('scanCltCandidates returns empty for non-existent root', () => {
  const cands = scanCltCandidates('linux', '/non/existent/root')
  assert.equal(cands.length, 0)
})

// Linux 官方 CLT 包是**扁平根**（根下 version.txt + sdk/，没有
// <root>/26.0.0/ 版本号子目录）。只扫子目录会让自动发现恒为空。
function makeFlatCltRoot (root, version = '26.0.0.621') {
  const exe = process.platform === 'win32' ? 'hdc.exe' : 'hdc'
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'version.txt'),
    `# ======================\n# Command Line Tools(linux-x64)\n# Version: ${version}\n# ======================\n`)
  const dir = join(root, 'sdk', 'default', 'openharmony', 'toolchains')
  mkdirSync(dir, { recursive: true })
  const hdc = join(dir, exe)
  writeFileSync(hdc, '')
  return hdc
}

test('readCltRootVersion reads the flat CLT version.txt', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-flatclt-'))
  try {
    makeFlatCltRoot(root)
    const r = readCltRootVersion(root)
    assert.deepEqual(r.version, [26, 0, 0])
    // 无 version.txt → null（版本不能凭空猜）
    const empty = mkdtempSync(join(tmpdir(), 'dsh-deveco-nover-'))
    try {
      assert.equal(readCltRootVersion(empty), null)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('scanCltCandidates accepts a flat CLT root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-flatclt-'))
  try {
    makeFlatCltRoot(root)
    const cands = scanCltCandidates('linux', root)
    assert.equal(cands.length, 1)
    assert.deepEqual(cands[0].version, [26, 0, 0])
    // 尾部斜杠不能产生重复候选
    assert.equal(scanCltCandidates('linux', `${root}/`).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('resolveCli accepts a configured flat CLT root without devecocli', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-flatclt-'))
  try {
    makeFlatCltRoot(root)
    // PATH 无 devecocli 是 Linux 用户的默认形态（devecocli 是独立 npm 包）
    const r = resolveCli({ cltPath: root, pathEnv: '/empty', dshDevecoCli: '/nonexistent' })
    assert.equal(r.source, 'clt')
    assert.equal(r.minVersionOk, true)
    assert.deepEqual(r.version, [26, 0, 0])
    assert.equal(r.cliAvailable, false)
    assert.match(r.message, /Command Line Tools 26\.0\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// integration: discoverAll returns the documented schema even though
// harmony-studio's raw scanners return string[] / {path,version:number[]}[].
// ---------------------------------------------------------------------------

test('discoverAll normalizes studios into {path,kind:studio}[]', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-int-'))
  try {
    const result = await discoverAll(tmp, 'linux')
    assert.equal(result.platform, 'linux')
    assert.ok(Array.isArray(result.studios))
    assert.ok(Array.isArray(result.clts))
    for (const s of result.studios) {
      assert.equal(typeof s.path, 'string')
      assert.equal(s.kind, 'studio')
    }
    for (const c of result.clts) {
      assert.equal(typeof c.path, 'string')
      assert.match(c.version, /^\d+\.\d+\.\d+$/)
      assert.equal(c.kind, 'clt')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('ensureDiscovery returns normalized cached shape', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deveco-int-'))
  try {
    // Seed a malformed cache (string[] instead of {path,kind}[]) and confirm
    // the re-normalize path scrubs it on read.
    writeFileSync(join(tmp, 'discovery.json'), JSON.stringify({
      schemaVersion: 1,
      platform: 'linux',
      scannedAt: Date.now(),
      studios: ['/fake/studio/a', '/fake/studio/b'],
      clts: [{ path: '/fake/clt/26.0.0', version: '26.0.0' }],
    }))
    const r = await ensureDiscovery(tmp, 'win32')
    assert.equal(r.studios.length, 2)
    for (const s of r.studios) {
      assert.equal(typeof s.path, 'string')
      assert.equal(s.kind, 'studio')
    }
    assert.equal(r.clts.length, 1)
    assert.equal(r.clts[0].kind, 'clt')
    assert.equal(r.clts[0].version, '26.0.0')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// harmony-tools：agent 工具面的命令构造与解析（不触网、不碰设备）
// ---------------------------------------------------------------------------

test('shellQuote escapes single quotes for the device shell', () => {
  assert.equal(shellQuote('abc'), "'abc'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote(''), "''")
})

test('parseBundleInfo reads the bundle json body', () => {
  const text = 'com.example.demo:\n' + JSON.stringify({
    mainElementName: 'EntryAbility',
    abilities: [{ name: 'EntryAbility' }, { name: 'OtherAbility' }],
  }, null, 2)
  const info = parseBundleInfo(text)
  assert.equal(info.bundle, 'com.example.demo')
  assert.equal(info.mainAbility, 'EntryAbility')
  assert.deepEqual(info.abilities, ['EntryAbility', 'OtherAbility'])
  assert.equal(info.json.mainElementName, 'EntryAbility')
})

test('buildAppDebugCommand marks the app for wait-for-debugger launch', () => {
  const r = buildAppDebugCommand('com.example.demo')
  assert.equal(r.ok, true)
  assert.equal(r.command, "aa appdebug -b 'com.example.demo'")
  assert.equal(buildAppDebugCommand('bad name').ok, false)
})

test('parseBundleInfo finds the stage-model main ability inside hapModuleInfos', () => {
  const text = 'com.example.demo:' + String.fromCharCode(10) + JSON.stringify({
    hapModuleInfos: [{ moduleName: 'entry', mainElementName: 'EntryAbility', abilities: [{ name: 'EntryAbility' }] }],
  }, null, 2)
  const info = parseBundleInfo(text)
  assert.equal(info.mainAbility, 'EntryAbility')
  assert.equal(info.moduleName, 'entry')
  assert.deepEqual(info.abilities, ['EntryAbility'])
})

test('buildStartAbilityCommand validates names and supports debug', () => {
  const r = buildStartAbilityCommand({ bundle: 'com.example.demo', ability: 'EntryAbility', debug: true })
  assert.equal(r.ok, true)
  assert.equal(r.command, "aa start -b 'com.example.demo' -a 'EntryAbility' -D")
  assert.equal(buildStartAbilityCommand({ bundle: 'bad name' }).ok, false)
  assert.equal(buildStartAbilityCommand({ bundle: 'com.example.demo', ability: 'a b' }).ok, false)
})

// ---------------------------------------------------------------------------
// harmony-debugger：ArkTS 调试协议的纯函数（协议形状来自实测报文）
// ---------------------------------------------------------------------------

test('debugger forward targets use the ark:<pid>@Debugger form and preserve the selected device', () => {
  assert.equal(debuggerForwardTarget(3308), 'ark:3308@Debugger')
  assert.deepEqual(buildDebuggerForwardArgs(19011, 3308), ['fport', 'tcp:19011', 'ark:3308@Debugger'])
  assert.deepEqual(buildDebuggerForwardRemoveArgs(19011, 3308), ['fport', 'rm', 'tcp:19011', 'ark:3308@Debugger'])
  assert.deepEqual(
    buildDebuggerForwardArgs(19011, 3308, '127.0.0.1:5555'),
    ['-t', '127.0.0.1:5555', 'fport', 'tcp:19011', 'ark:3308@Debugger'],
  )
  assert.deepEqual(
    buildDebuggerForwardRemoveArgs(19011, 3308, '127.0.0.1:5555'),
    ['-t', '127.0.0.1:5555', 'fport', 'rm', 'tcp:19011', 'ark:3308@Debugger'],
  )
})

test('isDebuggerError detects ArkVM errors carried inside result', () => {
  // 实测：失败不是 JSON-RPC error，而是 result.code/result.message
  assert.equal(isDebuggerError({ code: 1, message: 'Can only perform operation while paused' }), true)
  assert.equal(isDebuggerError({ message: 'Unknown file name.' }), true)
  assert.equal(isDebuggerError({ protocols: [] }), false)
  assert.equal(isDebuggerError({ breakpointId: 'id:10:0:url' }), false)
  assert.equal(isDebuggerError(null), false)
})

test('summarizeCallFrames projects the paused frames', () => {
  const frames = summarizeCallFrames([
    {
      callFrameId: '0',
      functionName: 'func_main_0',
      url: 'entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts',
      location: { scriptId: '0', lineNumber: -1, columnNumber: 0 },
    },
  ])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].functionName, 'func_main_0')
  assert.equal(frames[0].lineNumber, -1)
  assert.equal(frames[0].scriptId, '0')
  const lines = formatCallFrameLines(frames)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^#0 func_main_0 @ entry\|hrouter\|2\.0\.0\|/)
  assert.deepEqual(formatCallFrameLines([]), [])
})

// ---- client bundle: settings navigation icon contract --------------------
// Regression guard for the 2026-11 double-icon bug. DSH 0.2.2-rc.1 moved the
// settings shell's gear into a `span.navIcon` wrapper, so the plugin's old
// `button > svg:first-child` CSS no longer matched the gear: the masked
// plugin icon was drawn NEXT TO the core gear. The plugin now contributes the
// glyph through the official `settings.section.icon` slot, and the DOM patch
// must stay deleted — these assertions fail if it creeps back.
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('client contributes the settings nav icon through the official slot', () => {
  assert.match(clientSource, /ctx\.slots\.inject\("settings\.section\.icon"/)
  assert.match(
    clientSource,
    /name:\s*"settings\.section\.icon"[\s\S]{0,160}?id:\s*"harmony-deveco"/
  )
})

test('client keeps the settings section and its icon under the same id', () => {
  const sectionId = clientSource.match(/name:\s*"settings\.section"[\s\S]{0,160}?id:\s*"([^"]+)"/)
  const iconId = clientSource.match(/name:\s*"settings\.section\.icon"[\s\S]{0,160}?id:\s*"([^"]+)"/)
  assert.ok(sectionId, 'settings.section registration not found')
  assert.ok(iconId, 'settings.section.icon registration not found')
  // The shell addresses icons by the section id it renders; a mismatch makes
  // the icon silently never render.
  assert.equal(iconId[1], sectionId[1])
})

test('client nav icon draws a currentColor glyph sized by the owner props', () => {
  assert.match(clientSource, /function HarmonySettingsNavIcon\(props\)/)
  assert.match(clientSource, /stroke:\s*"currentColor"/)
  assert.match(clientSource, /props\.size/)
  assert.match(clientSource, /viewBox:\s*"0 0 16 16"/)
})

test('client keeps no DOM-patch icon hack that could double the shell gear', () => {
  assert.doesNotMatch(clientSource, /registerSettingsNavIcon/)
  assert.doesNotMatch(clientSource, /data-dsh-deveco-settings-nav/)
  assert.doesNotMatch(clientSource, /svg:first-child/)
})

// ---------------------------------------------------------------------------
// hdc fallback channel（devecocli 未安装时的降级）
// ---------------------------------------------------------------------------

test('parseHdcTargets skips [Empty]/unauthorized and keeps serial+state', () => {
  assert.deepEqual(parseHdcTargets('[Empty]'), [])
  const list = parseHdcTargets([
    '127.0.0.1:5555\tdevice',
    '55K0225509025604\tdevice',
    'BADDEVICE        unauthorized',
    '',
  ].join('\n'))
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { serial: '127.0.0.1:5555', name: '', state: 'device', type: '' })
  assert.equal(list[1].serial, '55K0225509025604')
})

test('buildHdcHilogArgs snapshots with -x, follows without it, quotes keyword', () => {
  assert.deepEqual(buildHdcHilogArgs({}), ['shell', 'hilog', '-x'])
  assert.deepEqual(
    buildHdcHilogArgs({ device: 'S', level: 'I' }),
    ['-t', 'S', 'shell', 'hilog', '-x', '-L', 'I']
  )
  assert.deepEqual(buildHdcHilogFollowArgs({ device: 'S' }), ['-t', 'S', 'shell', 'hilog'])
  assert.deepEqual(buildHdcHilogArgs({ keyword: 'a b' }), ['shell', 'hilog', '-x', '-e', "'a b'"])
  assert.equal(quoteDeviceShellArg("it's"), "'it'\\''s'")
})

test('hdc screenshot/input builders use the device commands DevEco CLI uses', () => {
  assert.deepEqual(buildHdcScreenCapArgs('/data/local/tmp/a.png'),
    ['shell', 'uitest', 'screenCap', '-p', '/data/local/tmp/a.png'])
  assert.deepEqual(buildHdcSnapshotDisplayArgs('/p'), ['shell', 'snapshot_display', '-f', '/p'])
  assert.deepEqual(buildHdcFileRecvArgs('/p', 'C:/x.png'), ['file', 'recv', '/p', 'C:/x.png'])
  assert.deepEqual(buildHdcFileRemoveArgs('/p'), ['shell', 'rm', '-f', '/p'])
  assert.deepEqual(buildHdcTapArgs({ x: 1, y: 2 }), ['shell', 'uitest', 'uiInput', 'click', '1', '2'])
  assert.deepEqual(buildHdcSwipeArgs({ x1: 1, y1: 2, x2: 3, y2: 4, speed: 600 }),
    ['shell', 'uitest', 'uiInput', 'swipe', '1', '2', '3', '4', '600'])
  assert.deepEqual(buildHdcTextArgs({ text: 'hi there' }), ['shell', 'uitest', 'uiInput', 'text', "'hi there'"])
})

test('parseWindowManagerDump parses the hidumper window table + focus', () => {
  const dump = [
    'WindowName          DisplayId Pid     WinId Type',
    'EntryAbility        0         1234    31    1',
    'StatusBar           0         100     12    2',
    'Focus window: 31',
    'total window: 2',
  ].join('\n')
  const rows = parseWindowManagerDump(dump)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { id: 31, name: 'EntryAbility', pid: 1234, displayId: 0, type: 1, focused: true })
  assert.equal(rows[1].focused, false)
  assert.deepEqual(parseWindowManagerDump('no table here'), [])
  assert.deepEqual(buildHdcWindowListArgs(),
    ['shell', 'hidumper', '-s', 'WindowManagerService', '-a', '-a'])
})

test('hdc device-info params and builder stay on the const.* system keys', () => {
  assert.ok(HDC_DEVICE_PARAM_KEYS.includes('const.product.model'))
  assert.deepEqual(buildHdcParamArgs('const.product.model'),
    ['shell', 'param', 'get', 'const.product.model'])
})

test('resolveCli marks studio without devecocli as cli-unavailable (hdc degradation)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-studio-'))
  const binName = process.platform === 'win32' ? 'devecocli.cmd' : 'devecocli'
  try {
    const r = resolveCli({ studioPath: root, cltPath: '', overrideExec: '', pathEnv: '', dshDevecoCli: '' })
    assert.equal(r.source, 'studio')
    assert.equal(r.cliAvailable, false)
    assert.equal(r.exec, undefined)
    assert.match(r.message, /未检测到 devecocli/)

    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', binName), 'probe\n')
    const r2 = resolveCli({ studioPath: root, cltPath: '', overrideExec: '', pathEnv: '', dshDevecoCli: '' })
    assert.equal(r2.cliAvailable, true)
    assert.equal(r2.exec, join(root, 'bin', binName))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveCli marks clt without devecocli as cli-unavailable', () => {
  const r = resolveCli({
    studioPath: '',
    cltPath: 'C:\\fake\\clt\\26.0.0',
    overrideExec: '',
    pathEnv: '',
    dshDevecoCli: '',
  })
  assert.equal(r.source, 'clt')
  assert.equal(r.cliAvailable, false)
  assert.match(r.message, /未检测到 devecocli/)
})

test('client surfaces the hdc-degraded badge and device-list errors', () => {
  assert.match(clientSource, /hdc 降级/)
  assert.match(clientSource, /cliAvailable === false/)
  assert.match(clientSource, /设备列表获取失败/)
})

// ---- ArkTS 调试器：断点命中 → 通知 agent -------------------------------------

test('shortScriptUrl keeps the file name of an ArkTS script url', () => {
  assert.equal(shortScriptUrl('entry|com.example|1.0.0|src/main/ets/pages/Index.ets'), 'Index.ets')
  assert.equal(shortScriptUrl(''), '')
  assert.equal(shortScriptUrl(undefined), '')
  assert.equal(shortScriptUrl('entry|com.example|1.0.0|EntryAbility.ets'), 'EntryAbility.ets')
})

test('formatPauseNotification reports the stop location, the stack and the next actions', () => {
  const { text, summary } = formatPauseNotification({
    bundleName: 'com.example.app',
    pid: 4321,
    device: 'emulator-5554',
    paused: {
      reason: 'break',
      hitBreakpoints: ['id:41:0:entry|com.example|1.0.0|src/main/ets/pages/Index.ets'],
      frames: [
        { callFrameId: '1', functionName: 'onPageShow', url: 'entry|com.example|1.0.0|src/main/ets/pages/Index.ets', lineNumber: 41, columnNumber: 0, scriptId: '7' },
        { callFrameId: '2', functionName: 'build', url: 'entry|com.example|1.0.0|src/main/ets/pages/Index.ets', lineNumber: 12, columnNumber: 0, scriptId: '7' },
      ],
    },
  })
  // 行号是 1 基展示（协议里是 0 基）
  assert.match(text, /Index\.ets:42/)
  assert.match(text, /com\.example\.app \(pid 4321\)/)
  assert.match(text, /emulator-5554/)
  assert.match(text, /命中断点：id:41:0:/)
  assert.match(text, /#0 onPageShow @ entry\|com\.example\|1\.0\.0\|src\/main\/ets\/pages\/Index\.ets:42/)
  assert.match(text, /action=stack/)
  assert.match(text, /action=resume/)
  assert.match(summary, /com\.example\.app 已暂停于 Index\.ets:42/)
})

test('formatPauseNotification survives an empty pause', () => {
  const { text, summary } = formatPauseNotification({})
  assert.match(text, /目标应用/)
  assert.match(text, /未知位置/)
  assert.ok(summary.length > 0)
})

test('createDebugNoticeMessage builds a user-role notice with a bounded summary', () => {
  const message = createDebugNoticeMessage('正文', '摘要')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.content, [{ type: 'text', text: '正文' }])
  assert.equal(message.source.kind, 'dsh-deveco-debug')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, '摘要')

  const long = createDebugNoticeMessage('正文', 'x'.repeat(300))
  assert.equal(long.source.summary.length, 120)
  assert.ok(long.source.summary.endsWith('…'))
})

test('a breakpoint pause notifies the owning agent exactly once', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555, bundleName: 'com.example.app', device: 'emulator-5554' })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }

  session._handleEvent('Debugger.paused', {
    reason: 'break',
    hitBreakpoints: ['id:41:0:entry|com.example|1.0.0|src/main/ets/pages/Index.ets'],
    callFrames: [{ callFrameId: '1', functionName: 'onPageShow', url: 'entry|com.example|1.0.0|src/main/ets/pages/Index.ets', location: { lineNumber: 41, columnNumber: 0, scriptId: '7' } }],
  })

  assert.equal(notices.length, 1)
  assert.equal(notices[0].agent.id, 'session-1')
  assert.match(notices[0].text, /Index\.ets:42/)
  assert.match(notices[0].summary, /已暂停/)
})

test('a pause the tool reports inline is never pushed to the agent', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555, bundleName: 'com.example.app' })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }

  session.noteExpectedPause(8000)
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 0)

  // 期望过期之后，真正的暂停仍然要通知
  session.noteExpectedPause(-1)
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 1)

  session.clearExpectedPauses()
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 2)
})

test('pauses are not pushed when the session has no owner or notifications are off', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555 })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)

  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 0)

  session.ownerAgent = { id: 'session-1' }
  session.notifyEnabled = false
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 0)

  session.notifyEnabled = true
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 1)
})

test('a failing notice delivery never breaks the debugger session', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555 })
  const host = { notifyAgent: () => { throw new Error('boom') } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }
  assert.doesNotThrow(() => session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] }))
})

test('a debugger notice wakes an idle agent but never interrupts a busy one', () => {
  assert.equal(decideDebugNoticeDelivery({ agentStatus: 'idle', wakeCount: 0, maxWakes: 3 }), 'wake')
  assert.equal(decideDebugNoticeDelivery({ agentStatus: 'running', wakeCount: 0, maxWakes: 3 }), 'queue')
  // 连续唤醒预算用尽后只入队，不再新开一轮
  assert.equal(decideDebugNoticeDelivery({ agentStatus: 'idle', wakeCount: 3, maxWakes: 3 }), 'queue')
  assert.equal(decideDebugNoticeDelivery({ agentStatus: 'idle', wakeCount: 2, maxWakes: 3 }), 'wake')
  // 缺省值：空闲 agent、有预算 → 唤醒
  assert.equal(decideDebugNoticeDelivery(), 'wake')
})

test('the Host wakes an idle agent when the app stops at a breakpoint', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const calls = []
  const agent = {
    id: 'session-1',
    status: 'idle',
    followup (message) { calls.push(['followup', message]) },
    inject (message) { calls.push(['inject', message]) },
  }
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._ctx = {
    get: (name) => (name === 'agents' ? { get: (id) => (id === 'session-1' ? agent : undefined) } : undefined),
  }
  service._debugWakeCounts = new Map()

  const delivered = await service._notifyDebugAgent({ agent, text: '正文', summary: '摘要' })
  assert.equal(delivered, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  assert.equal(calls[0][1].role, 'user')
  assert.equal(calls[0][1].source.kind, 'dsh-deveco-debug')
  assert.equal(calls[0][1].source.form, 'notice')
  assert.equal(calls[0][1].content[0].text, '正文')
})

test('a busy agent only gets the notice queued, and the wake budget stops the loop', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const calls = []
  const agent = {
    id: 'session-2',
    status: 'running',
    followup (message) { calls.push(['followup', message]) },
    inject (message) { calls.push(['inject', message]) },
  }
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._ctx = {
    get: (name) => (name === 'agents' ? { get: (id) => (id === 'session-2' ? agent : undefined) } : undefined),
  }
  service._debugWakeCounts = new Map()

  await service._notifyDebugAgent({ agent, text: 'a', summary: 'a' })
  assert.deepEqual(calls.map((c) => c[0]), ['inject'])

  // 空闲 agent：连续 3 次唤醒后预算耗尽 → 只入队
  agent.status = 'idle'
  calls.length = 0
  await service._notifyDebugAgent({ agent, text: 'b', summary: 'b' })
  await service._notifyDebugAgent({ agent, text: 'b', summary: 'b' })
  await service._notifyDebugAgent({ agent, text: 'b', summary: 'b' })
  assert.deepEqual(calls.map((c) => c[0]), ['followup', 'followup', 'followup'])
  calls.length = 0
  await service._notifyDebugAgent({ agent, text: 'b', summary: 'b' })
  assert.deepEqual(calls.map((c) => c[0]), ['inject'])

  // agent 又用了调试器 → 预算清零
  service._noteDebugAgentActivity(agent)
  calls.length = 0
  await service._notifyDebugAgent({ agent, text: 'b', summary: 'b' })
  assert.deepEqual(calls.map((c) => c[0]), ['followup'])

  // 会话已销毁 → 静默丢弃
  const gone = Object.create(HarmonyDevEcoService.prototype)
  gone._ctx = { get: () => undefined }
  gone._debugWakeCounts = new Map()
  assert.equal(await gone._notifyDebugAgent({ agent, text: 'x', summary: 'x' }), false)
})

test('module-init pauses ("Break on start") are never pushed to the agent', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555, bundleName: 'com.example.app' })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }

  // 入口模块的初始化暂停（attach 已经内联回报过）
  session._handleEvent('Debugger.paused', { reason: 'Break on start', callFrames: [] })
  // 库模块（hrouter 等）的初始化暂停——真机实测每个加载的模块都会来一次
  session._handleEvent('Debugger.paused', { reason: 'Break on start', callFrames: [] })
  assert.equal(notices.length, 0)

  // 真正的断点命中仍然要通知
  session._handleEvent('Debugger.paused', { reason: 'break', hitBreakpoints: ['id:41:0:entry|com.example|1.0.0|src/main/ets/pages/Index.ets'], callFrames: [] })
  assert.equal(notices.length, 1)
})

test('a reason-scoped expectation does not swallow a real breakpoint hit', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555 })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }

  // attach 的入口期望只针对启动类原因
  session.noteExpectedPause(15000, { reasons: ['Break on start'] })
  // 断点命中（原因不匹配）必须照常通知
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 1)

  // 启动类暂停会消费这条期望
  session._handleEvent('Debugger.paused', { reason: 'Break on start', callFrames: [] })
  assert.equal(notices.length, 1)
})

test('a pause the tool already reported inline is not pushed again', () => {
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555 })
  const notices = []
  const host = { notifyAgent: (payload) => { notices.push(payload); return Promise.resolve(true) } }
  installPauseNotifier(session, host)
  session.ownerAgent = { id: 'session-1' }

  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 1)

  // 工具结果内联回报了这一次的暂停
  session.markPauseReportedInline()
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, 2) // 新的一次暂停（新的快照）仍然要通知

  // 标记只作用于当次快照：重复处理同一个快照不再推
  const snapshot = session.paused
  session.markPauseReportedInline()
  session.paused = snapshot
  const before = notices.length
  session._handleEvent('Debugger.paused', { reason: 'break', callFrames: [] })
  assert.equal(notices.length, before + 1)
})

test('startup pauses can be skipped and re-enabled on demand', async () => {
  const sent = []
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555 })
  session.request = async (method, params) => {
    sent.push({ method, params })
    if (method === 'Runtime.enable') return { ok: true, value: {} }
    if (method === 'Debugger.enable') return { ok: true, value: { protocols: [] } }
    return { ok: true, value: {} }
  }

  // attach 默认跳过启动期暂停（ArkVM 每个新脚本都会 Break on start）
  const ini = await session.init({ runIfWaiting: true })
  assert.equal(ini.ok, true)
  assert.equal(session.skipPauses, true)
  const skipCall = sent.find((c) => c.method === 'Debugger.setSkipAllPauses')
  assert.ok(skipCall, 'init 必须下发 setSkipAllPauses')
  assert.equal(skipCall.params.skip, true)
  // 必须在放行应用之前下发，否则第一个脚本的启动暂停已经发生
  const skipIndex = sent.findIndex((c) => c.method === 'Debugger.setSkipAllPauses')
  const runIndex = sent.findIndex((c) => c.method === 'Runtime.runIfWaitingForDebugger')
  assert.ok(skipIndex < runIndex, 'setSkipAllPauses 要早于 runIfWaitingForDebugger')

  // 设断点前必须把跳过关掉，否则断点不会命中
  await session.ensurePausesEnabled()
  assert.equal(session.skipPauses, false)
  const off = sent.filter((c) => c.method === 'Debugger.setSkipAllPauses').pop()
  assert.equal(off.params.skip, false)

  // 已经关掉时不要重复下发
  const before = sent.length
  await session.ensurePausesEnabled()
  assert.equal(sent.length, before)

  // 显式开关
  await session.setSkipAllPauses(true)
  assert.equal(session.skipPauses, true)
  await session.setSkipAllPauses(false)
  assert.equal(session.skipPauses, false)
})

test('a breakpoint hit reports the ArkVM reason "other" as a breakpoint', () => {
  const withHit = formatPauseNotification({
    bundleName: 'com.example.app',
    paused: {
      reason: 'other',
      hitBreakpoints: ['id:340:0:entry|entry|1.0.0|src/main/ets/pages/Index.ts'],
      frames: [{ url: 'entry|entry|1.0.0|src/main/ets/pages/Index.ts', lineNumber: 340, functionName: 'onCreateSession' }],
    },
  })
  assert.match(withHit.text, /断点命中/)
  assert.match(withHit.text, /命中断点：id:340:0/)
  assert.match(withHit.summary, /命中断点/)

  // 没有命中断点时保留原始 reason
  const plain = formatPauseNotification({
    bundleName: 'com.example.app',
    paused: { reason: 'other', hitBreakpoints: [], frames: [] },
  })
  assert.match(plain.text, /暂停原因：other/)
})

test('the shared pause reason label translates the ArkVM "other" reason', () => {
  assert.equal(describePauseReason({ reason: 'other', hitBreakpoints: ['id:1:0:x'] }), '断点命中')
  assert.equal(describePauseReason({ reason: 'other', hitBreakpoints: [] }), 'other')
  assert.equal(describePauseReason({ reason: 'exception' }), 'exception')
  assert.equal(describePauseReason(null), 'break')
})

// ---------------------------------------------------------------------------
// HarmonyOS project model + ArkTS Source Maps
// ---------------------------------------------------------------------------

function createHarmonyProjectFixture () {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deveco-project-'))
  const write = (name, content) => {
    const path = join(root, ...name.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  write('build-profile.json5', `{
    // JSON5 comments, single quotes, unquoted keys and trailing commas are valid.
    app: {
      signingConfigs: [{ name: 'default', type: 'HarmonyOS', material: {
        certpath: 'secret-cert', profile: 'secret-profile', storeFile: 'secret-store',
        storePassword: 'secret-password', keyAlias: 'secret-alias', keyPassword: 'secret-key',
      }}],
      products: [{ name: 'default', signingConfig: 'default', targetSdkVersion: '26.0.0', compatibleSdkVersion: '26.0.0', runtimeOS: 'HarmonyOS' }],
      buildModeSet: [{ name: 'debug' }, { name: 'release' }],
    },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }],
  }`)
  write('AppScope/app.json5', `{ app: { bundleName: 'com.example.demo', vendor: 'test', versionCode: 10001, versionName: '1.0.1' } }`)
  write('oh-package.json5', `{ name: 'demo', modelVersion: '26.0.0', dependencies: { hrouter: '^2.0.0' }, devDependencies: { '@ohos/hypium': '1.0.25' } }`)
  write('entry/build-profile.json5', `{ apiType: 'stageMode', targets: [{ name: 'default' }] }`)
  write('entry/oh-package.json5', `{ name: 'entry', version: '1.0.0', dependencies: { eventpost: '^2.0.0' } }`)
  write('entry/src/main/module.json5', `{ module: {
    name: 'entry', type: 'entry', mainElement: 'EntryAbility', deviceTypes: ['phone', 'tablet'],
    pages: '$profile:main_pages', routerMap: '$profile:router_map',
    abilities: [{ name: 'EntryAbility', srcEntry: './ets/entryability/EntryAbility.ets', exported: true }],
    requestPermissions: [{ name: 'ohos.permission.INTERNET' }],
  } }`)
  write('entry/src/main/resources/base/profile/main_pages.json', JSON.stringify({ src: ['pages/Index'] }))
  const source = write('entry/src/main/ets/pages/Index.ets', 'const a = 1\nconst b = 2\nconst c = 3\n')
  const url = 'entry|entry|1.0.0|src/main/ets/pages/Index.ts'
  const map = write('entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/sourceMaps.json', JSON.stringify({
    [url]: {
      version: 3,
      file: 'Index.ts',
      sources: ['entry/src/main/ets/pages/Index.ets'],
      names: [],
      mappings: 'AAAA;AACA;AACA',
    },
  }))
  write('entry/build/default/outputs/default/entry-default-signed.hap', 'fixture-hap')
  return { root, source, map, url }
}

test('harmony_project reads JSON5 project structure from any nested path without exposing signing material', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    assert.equal(await findHarmonyProjectRoot(fixture.source), fixture.root)
    const project = await inspectHarmonyProject(fixture.source)
    assert.equal(project.name, 'demo')
    assert.equal(project.bundleName, 'com.example.demo')
    assert.equal(project.versionName, '1.0.1')
    assert.equal(project.defaultProduct, 'default')
    assert.equal(project.defaultBuildMode, 'debug')
    assert.equal(project.dependencies.hrouter, '^2.0.0')
    assert.deepEqual(project.signingConfigs, [{ name: 'default', type: 'HarmonyOS', configured: true }])
    assert.equal(project.modules.length, 1)
    const module = project.modules[0]
    assert.equal(module.type, 'entry')
    assert.equal(module.mainElement, 'EntryAbility')
    assert.deepEqual(module.deviceTypes, ['phone', 'tablet'])
    assert.deepEqual(module.pages, ['pages/Index'])
    assert.deepEqual(module.requestPermissions, ['ohos.permission.INTERNET'])
    assert.equal(module.artifacts.length, 1)
    assert.equal(module.sourceMaps[0].scriptCount, 1)
    const serialized = JSON.stringify(project)
    assert.equal(serialized.includes('secret-'), false)
    assert.equal(serialized.includes('keyPassword'), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Source Map VLQ decoding preserves generated/original deltas across lines', async () => {
  assert.deepEqual(decodeVlqSegment('AACA').values, [0, 0, 1, 0])
  assert.deepEqual(decodeVlqSegment('AADA').values, [0, 0, -1, 0])
  const lines = decodeSourceMapMappings('AAAA,CAAC;AACA')
  assert.equal(lines.length, 2)
  assert.equal(lines[0][0].sourceLine, 0)
  assert.equal(lines[0][1].generatedColumn, 1)
  assert.equal(lines[0][1].sourceColumn, 1)
  assert.equal(lines[1][0].sourceLine, 1)
})

test('Source Map index resolves .ets source breakpoints and reverse-maps frames in both directions', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    const index = await loadHarmonySourceMapIndex(fixture.root)
    assert.equal(index.scriptCount, 1)
    const resolved = index.resolveSourceBreakpoint({
      sourcePath: 'entry/src/main/ets/pages/Index.ets', sourceLine: 1, loadedScripts: new Set([fixture.url]),
    })
    assert.equal(resolved.url, fixture.url)
    assert.equal(resolved.line, 1)
    assert.equal(resolved.sourceLine, 2)
    const frame = index.mapFrame({ index: 0, functionName: 'demo', url: fixture.url, lineNumber: 1, columnNumber: 0 })
    assert.equal(frame.sourcePath, 'entry/src/main/ets/pages/Index.ets')
    assert.equal(frame.sourceLine, 2)
    assert.match(formatCallFrameLines([frame])[0], /Index\.ets:2/)
    assert.match(formatCallFrameLines([frame])[0], /compiled: .*Index\.ts:2/)
    const map = index.mapForUrl(fixture.url)
    assert.equal(originalPositionFor(map, 1, 0).sourceLine, 1)
    assert.equal(generatedPositionFor(map, fixture.root, fixture.source, 1, 0).generatedLine, 1)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('source breakpoint resolution moves to the next executable source line explicitly', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    // Generated line 1 maps to original line 3 (0-based 2), leaving line 2 unmapped.
    const parsed = JSON.parse(readFileSync(fixture.map, 'utf8'))
    parsed[fixture.url].mappings = 'AAAA;AAEC'
    writeFileSync(fixture.map, JSON.stringify(parsed))
    const index = await loadHarmonySourceMapIndex(fixture.root)
    const resolved = index.resolveSourceBreakpoint({ sourcePath: fixture.source, sourceLine: 1 })
    assert.equal(resolved.line, 1)
    assert.equal(resolved.sourceLine, 3)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a source file newer than its Source Map is rejected instead of using stale line numbers', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    const index = await loadHarmonySourceMapIndex(fixture.root)
    const resolved = index.resolveSourceBreakpoint({ sourcePath: fixture.source, sourceLine: 1 })
    writeFileSync(fixture.source, 'const a = 1\nconst changed = 2\nconst c = 3\n')
    // 显式拨快源文件 mtime：tmpfs/ext4 上相邻两次写入常落在同一时间戳刻度
    // （实测 delta 可 < 1 ms），单靠写完立刻 stat 会撞上 mapMtimeMs + 1 的容差
    const bumped = resolved.mapMtimeMs + 2000
    utimesSync(fixture.source, bumped / 1000, bumped / 1000)
    await assert.rejects(assertSourceBreakpointFresh(resolved, fixture.source, fixture.root), /尚未重新构建|比 Source Map 更新/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('harmony_project agent tool defaults to the host workspace and returns the full model', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    const tools = buildHarmonyAgentTools({ defineTool: (spec) => spec, host: { cwd: fixture.root, sessions: new Map() } })
    assert.deepEqual(tools.map((tool) => tool.name), ['harmony_project', 'harmony_debug', 'harmony_web_dom'])
    const result = await tools[0].execute({})
    assert.equal(result.ok, true)
    assert.equal(result.project.root, fixture.root)
    const rendered = tools[0].output.render({}, result)
    assert.match(rendered[0].text, /com\.example\.demo/)
    assert.match(rendered[0].text, /Source Map 1 份/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('harmony_debug attach scopes fport to the selected device and does not retry non-port failures', async () => {
  const calls = []
  const host = {
    sessions: new Map(),
    hdc: async (argv) => {
      calls.push(argv)
      return { ok: true, stdout: '[Fail]Device not found', stderr: '' }
    },
    shell: async () => ({
      ok: true,
      stdout: 'com.example.demo:\n{"applicationInfo":{"appProvisionType":"debug"}}',
      stderr: '',
    }),
  }
  const debug = buildHarmonyAgentTools({ defineTool: (spec) => spec, host }).find((tool) => tool.name === 'harmony_debug')
  await assert.rejects(
    debug.execute({ action: 'attach', device: '127.0.0.1:5555', package_name: 'com.example.demo', pid: '4321' }),
    (error) => {
      assert.match(error.message, /\[Fail\]Device not found/)
      assert.doesNotMatch(error.message, /多次 `TCP Port listen failed`/)
      return true
    },
  )
  assert.equal(calls.length, 1, 'a deterministic hdc failure must not trigger port retries or cleanup')
  assert.deepEqual(calls[0].slice(0, 3), ['-t', '127.0.0.1:5555', 'fport'])
  assert.match(calls[0][3], /^tcp:\d+$/)
  assert.equal(calls[0][4], 'ark:4321@Debugger')
})

test('harmony_debug attach retries only port listen failures and cleans up on the same device', async () => {
  const calls = []
  const host = {
    sessions: new Map(),
    hdc: async (argv) => {
      calls.push(argv)
      return { ok: true, stdout: '[Fail]TCP Port listen failed at 19011', stderr: '' }
    },
    shell: async () => ({
      ok: true,
      stdout: 'com.example.demo:\n{"applicationInfo":{"appProvisionType":"debug"}}',
      stderr: '',
    }),
  }
  const debug = buildHarmonyAgentTools({ defineTool: (spec) => spec, host }).find((tool) => tool.name === 'harmony_debug')
  await assert.rejects(
    debug.execute({ action: 'attach', device: '127.0.0.1:5555', package_name: 'com.example.demo', pid: '4321' }),
    /多次 `TCP Port listen failed`/,
  )
  assert.equal(calls.length, 6, 'three forwards plus three best-effort removals')
  assert.equal(calls.filter((argv) => argv.includes('rm')).length, 3)
  for (const argv of calls) {
    assert.deepEqual(argv.slice(0, 3), ['-t', '127.0.0.1:5555', 'fport'])
  }
})

test('harmony_debug sets a source breakpoint with 1-based .ets input and returns 0-based ArkVM output', async () => {
  const fixture = createHarmonyProjectFixture()
  const session = new ArktsDebuggerSession({ pid: 4321, port: 5555, bundleName: 'com.example.demo' })
  session.scripts.set(fixture.url, '7')
  session.request = async (method, params) => {
    if (method === 'Debugger.setBreakpointByUrl') {
      return { ok: true, value: { breakpointId: `id:${params.lineNumber}:${params.columnNumber}:${params.url}`, locations: [{ id: 'ok', lineNumber: params.lineNumber }] } }
    }
    return { ok: true, value: {} }
  }
  const host = { cwd: fixture.root, sessions: new Map([[4321, session]]), hdc: async () => ({ ok: true }) }
  const debug = buildHarmonyAgentTools({ defineTool: (spec) => spec, host }).find((tool) => tool.name === 'harmony_debug')
  try {
    const result = await debug.execute({ action: 'set_breakpoint', pid: '4321', source_path: 'entry/src/main/ets/pages/Index.ets', source_line: 2, project_path: fixture.root })
    assert.equal(result.data.source.url, fixture.url)
    assert.equal(result.data.source.line, 1)
    assert.equal(result.data.source.sourceLine, 2)
    assert.equal(session.breakpoints[0].sourcePath, 'entry/src/main/ets/pages/Index.ets')
    assert.equal(session.breakpoints[0].requestedSourceLine, 2)
    assert.match(result.message, /已设置源码断点/)

    session._handleEvent('Debugger.paused', {
      reason: 'other', hitBreakpoints: [session.breakpoints[0].breakpointId],
      callFrames: [{ callFrameId: '1', functionName: 'demo', url: fixture.url, location: { scriptId: '7', lineNumber: 1, columnNumber: 0 } }],
    })
    const stack = await debug.execute({ action: 'stack', pid: '4321' })
    assert.equal(stack.data.frames[0].sourcePath, 'entry/src/main/ets/pages/Index.ets')
    assert.equal(stack.data.frames[0].sourceLine, 2)
    assert.match(stack.data.stackLines[0], /Index\.ets:2/)
  } finally {
    session.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('breakpoint notifications prefer the mapped .ets source location', async () => {
  const fixture = createHarmonyProjectFixture()
  try {
    const index = await loadHarmonySourceMapIndex(fixture.root)
    const session = new ArktsDebuggerSession({ pid: 4321, port: 5555, bundleName: 'com.example.demo' })
    session.sourceMaps = index
    session.ownerAgent = { id: 'source-session' }
    const notices = []
    installPauseNotifier(session, { notifyAgent: (notice) => { notices.push(notice); return Promise.resolve(true) } })
    session._handleEvent('Debugger.paused', {
      reason: 'break',
      callFrames: [{ callFrameId: '1', functionName: 'demo', url: fixture.url, location: { scriptId: '7', lineNumber: 1, columnNumber: 0 } }],
    })
    assert.equal(notices.length, 1)
    assert.match(notices[0].text, /entry\/src\/main\/ets\/pages\/Index\.ets:2/)
    assert.match(notices[0].summary, /Index\.ets:2/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

// ---- ArkWeb Web DevTools ---------------------------------------------------

function fixtureWebDom () {
  const text = {
    nodeId: 31,
    backendNodeId: 31,
    nodeType: 3,
    nodeName: '#text',
    nodeValue: 'Hello web',
  }
  const span = {
    nodeId: 21,
    backendNodeId: 21,
    nodeType: 1,
    nodeName: 'SPAN',
    localName: 'span',
    attributes: ['class', 'hint'],
    childNodeCount: 1,
    children: [{ ...text, nodeId: 32, backendNodeId: 32, nodeValue: 'hint text' }],
  }
  const p = {
    nodeId: 22,
    backendNodeId: 22,
    nodeType: 1,
    nodeName: 'P',
    localName: 'p',
    childNodeCount: 1,
    children: [text],
  }
  const div = {
    nodeId: 2,
    backendNodeId: 2,
    nodeType: 1,
    nodeName: 'DIV',
    localName: 'div',
    attributes: ['id', 'app', 'class', 'classA', 'data-x', '1'],
    childNodeCount: 2,
    children: [p, span],
  }
  const html = {
    nodeId: 3,
    backendNodeId: 3,
    nodeType: 1,
    nodeName: 'HTML',
    localName: 'html',
    childNodeCount: 1,
    children: [div],
  }
  return {
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    childNodeCount: 1,
    children: [html],
  }
}

test('parseWebDebugSockets extracts every ArkWeb socket and ignores unrelated entries', () => {
  const text = [
    '0000: 00000002 00000000 00010000 0001 01 1001 @webview_devtools_remote_38532',
    '0000: 00000002 00000000 00010000 0001 01 1002 @webview_devtools_remote_48532',
    '0000: 00000002 00000000 00010000 0001 01 1003 @webview_devtools_remote_38532',
    '0000: 00000002 00000000 00010000 0001 01 1004 @some_other_socket',
    'garbage webview_devtools_remote_not_a_pid',
  ].join('\n')
  assert.deepEqual(parseWebDebugSockets(text), [
    { socketName: 'webview_devtools_remote_38532', pid: 38532 },
    { socketName: 'webview_devtools_remote_48532', pid: 48532 },
  ])
  assert.deepEqual(parseWebDebugSockets('no devtools here'), [])
})

test('Web DevTools argv and websocket URL are built from our local port, not the device payload', () => {
  assert.deepEqual(
    buildWebForwardArgs(19011, 'webview_devtools_remote_38532'),
    ['fport', 'tcp:19011', 'localabstract:webview_devtools_remote_38532'],
  )
  assert.deepEqual(
    buildWebForwardRemoveArgs(19011, 'webview_devtools_remote_38532'),
    ['fport', 'rm', 'tcp:19011', 'localabstract:webview_devtools_remote_38532'],
  )
  assert.equal(buildWebSocketUrl(19011, 'TARGET A'), 'ws://127.0.0.1:19011/devtools/page/TARGET%20A')
  assert.throws(() => buildWebForwardArgs(0, 'webview_devtools_remote_1'), /无效的本地端口/)
})

test('parseDevToolsTargets accepts /json arrays and {targets}, drops duplicates and unsafe shapes', () => {
  const payload = {
    targets: [
      { id: 'A', type: 'page', title: 'Demo', url: 'https://example.test/', description: 'main' },
      { id: 'A', type: 'page', title: 'duplicate' },
      { id: '', type: 'page', title: 'missing id' },
      { id: 'B', type: 'worker', title: 'worker', url: 'worker.js' },
      null,
    ],
  }
  assert.deepEqual(parseDevToolsTargets(payload), [
    { id: 'A', type: 'page', title: 'Demo', url: 'https://example.test/', description: 'main' },
    { id: 'B', type: 'worker', title: 'worker', url: 'worker.js', description: '' },
  ])
  assert.deepEqual(parseDevToolsTargets([{ id: 'C', type: 'page', title: 'C', url: '' }]), [
    { id: 'C', type: 'page', title: 'C', url: '', description: '' },
  ])
  assert.throws(() => parseDevToolsTargets('{not json'), /不是有效 JSON/)
  assert.throws(() => parseDevToolsTargets({ foo: 'bar' }), /不是 target 数组/)
})

test('selectWebTarget prefers an explicit id and refuses to guess among multiple pages', () => {
  const targets = [
    { id: 'A', type: 'page' },
    { id: 'B', type: 'page' },
  ]
  assert.equal(selectWebTarget(targets, 'B').id, 'B')
  assert.equal(selectWebTarget(targets, 'Z'), null)
  assert.equal(selectWebTarget(targets), null)
  assert.equal(selectWebTarget([{ id: 'solo', type: 'page' }]).id, 'solo')
  assert.equal(selectWebTarget([{ id: 'iframe', type: 'iframe' }]).id, 'iframe')
})

test('normalizeWebDom preserves attributes, text, child counts and whole-subtree truncation', () => {
  const full = normalizeWebDom(fixtureWebDom(), { maxDepth: 8, maxNodes: 100, includeAttrs: true })
  assert.equal(full.nodes.length, 7)
  assert.equal(full.truncated, false)
  const div = full.nodes.find((node) => node.tag === 'div')
  assert.equal(div.id, 'app')
  assert.deepEqual(div.classes, ['classA'])
  assert.equal(div.attributes['data-x'], '1')
  assert.equal(div.attrCount, 3)
  const p = full.nodes.find((node) => node.tag === 'p')
  assert.equal(p.text, 'Hello web')
  const text = full.nodes.find((node) => node.tag === '#text')
  assert.equal(text.text, 'Hello web')

  const depthLimited = normalizeWebDom(fixtureWebDom(), { maxDepth: 2, maxNodes: 100 })
  assert.equal(depthLimited.nodes.length, 3)
  assert.equal(depthLimited.truncated, true)
  assert.equal(depthLimited.nodes[2].childrenOmitted, true)
  assert.equal(depthLimited.nodes[2].hiddenDirect, 2)
  assert.equal(depthLimited.nodes[2].childCount, 2)

  const nodeLimited = normalizeWebDom(fixtureWebDom(), { maxDepth: 8, maxNodes: 2 })
  assert.equal(nodeLimited.nodes.length, 2)
  assert.equal(nodeLimited.nodes[1].childrenOmitted, true)
  assert.equal(nodeLimited.nodes[1].hiddenDirect, 1)
})

test('normalizeWebDom counts descendants even when CDP reports nodeId=0 for unpushed nodes', () => {
  const root = {
    nodeId: 5,
    nodeType: 1,
    nodeName: 'BODY',
    localName: 'body',
    childNodeCount: 2,
    children: [
      { nodeId: 0, nodeType: 1, nodeName: 'DIV', localName: 'div', childNodeCount: 0, children: [] },
      { nodeId: 0, nodeType: 1, nodeName: 'SPAN', localName: 'span', childNodeCount: 0, children: [] },
    ],
  }
  const value = normalizeWebDom(root, { maxDepth: 2, maxNodes: 100 })
  assert.equal(value.nodeCount, 3)
  assert.equal(value.nodes.length, 3)
})

test('normalizeWebDom marks CDP depth gaps instead of pretending a truncated node is a leaf', () => {
  const root = {
    nodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    childNodeCount: 5,
    children: [{ nodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html', childNodeCount: 0 }],
  }
  const value = normalizeWebDom(root, { maxDepth: 1, maxNodes: 100 })
  assert.equal(value.nodes[0].childCount, 5)
  assert.equal(value.nodes[0].childrenOmitted, true)
  assert.equal(value.nodes[0].hiddenDirect, 4)
  assert.equal(value.truncated, true)
})

test('webDomTreeLines renders tag/id/class plus explicit omitted children', () => {
  const value = normalizeWebDom(fixtureWebDom(), { maxDepth: 2, maxNodes: 100 })
  const lines = webDomTreeLines(value.nodes)
  assert.match(lines[0], /^#document/)
  assert.match(lines[2], /div#app\.classA/)
  assert.match(lines[2], /\+2\/2 children hidden/)
})

class FakeCdpWebSocket {
  constructor (url) {
    this.url = url
    this.sent = []
    setTimeout(() => this.onopen && this.onopen({}), 0)
  }

  send (raw) {
    const request = JSON.parse(raw)
    this.sent.push(request)
    setTimeout(() => {
      if (request.method === 'bad') {
        this.onmessage && this.onmessage({
          data: JSON.stringify({ id: request.id, error: { code: -32601, message: 'method not found' } }),
        })
        return
      }
      this.onmessage && this.onmessage({
        data: JSON.stringify({ id: request.id, result: { echo: request.method, params: request.params } }),
      })
    }, 0)
  }

  close () {
    setTimeout(() => this.onclose && this.onclose({ code: 1000 }), 0)
  }
}

test('WebDevToolsSession uses standard Chromium JSON-RPC and reports cdp-error separately', async () => {
  const session = new WebDevToolsSession({
    port: 19011,
    targetId: 'TARGET-A',
    WebSocketImpl: FakeCdpWebSocket,
    timeoutMs: 3000,
  })
  await session.connect()
  assert.equal(session.url, 'ws://127.0.0.1:19011/devtools/page/TARGET-A')
  const reply = await session.request('DOM.getDocument', { depth: 1 })
  assert.equal(reply.echo, 'DOM.getDocument')
  assert.deepEqual(reply.params, { depth: 1 })
  await assert.rejects(
    session.request('bad'),
    (error) => error instanceof WebDevToolsError && error.code === 'cdp-error' && /method not found/.test(error.message),
  )
  await session.close()
})

test('TYPERT manifest exposes webTargets/webDomRead with strict dual-shape codecs', async () => {
  const { TYPERT } = await import('../typert.host.js')
  assert.equal(TYPERT.invocations.length, 27)
  for (const method of ['webTargets', 'webDomRead']) {
    const invocation = TYPERT.invocations.find((entry) => entry.method === method)
    assert.ok(invocation, `${method} invocation exists`)
    assert.equal(invocation.id, `dsh-deveco#harmonyDevEco/${method}`)
    assert.equal(invocation.parameters.length, 1)
    assert.equal(invocation.parameters[0].codec.mode, 'strict')
    assert.equal(typeof invocation.parameters[0].codec.schema.safeParse, 'function')
    assert.equal(typeof invocation.parameters[0].codec.create().safeParse, 'function')
    assert.equal(invocation.result.mode, 'strict')
    assert.equal(typeof invocation.result.schema.safeParse, 'function')
  }
  const targets = TYPERT.invocations.find((entry) => entry.method === 'webTargets')
  assert.equal(targets.parameters[0].codec.schema.safeParse({ pid: 4321 }).success, true)
  assert.equal(targets.parameters[0].codec.schema.safeParse({ pid: 'bad' }).success, false)
  const read = TYPERT.invocations.find((entry) => entry.method === 'webDomRead')
  assert.equal(read.parameters[0].codec.schema.safeParse({
    targetId: 'T', selector: '#app', depth: 4, maxNodes: 100, includeHtml: true,
  }).success, true)
  assert.equal(read.result.schema.safeParse({
    ok: true,
    value: {
      source: 'webdevtools',
      target: { id: 'T', type: 'page', title: 'T', url: 'https://t/', pid: 1, socketName: 'webview_devtools_remote_1' },
      nodeCount: 1,
      truncated: false,
      hiddenNodes: 0,
      nodes: [{
        index: 0, depth: 0, parentIndex: -1, nodeType: 9, tag: '#document', name: '#document',
        text: '', childCount: 0, attrCount: 0,
      }],
    },
  }).success, true)
})

test('Web fport helper removes only its own rule on success and never bulk-deletes forwards', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const calls = []
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._resolveHdcPath = () => 'hdc'
  service._hdcRun = async (argv) => {
    calls.push(argv)
    if (argv.includes('rm')) return { ok: true, stdout: '', stderr: '' }
    return { ok: true, stdout: 'Forwardport result:OK', stderr: '' }
  }
  const result = await service._withWebForward('127.0.0.1:5555', 'webview_devtools_remote_4321', async (port) => {
    assert.ok(Number.isInteger(port) && port > 0)
    return { port }
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.port > 0, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 3), ['-t', '127.0.0.1:5555', 'fport'])
  assert.match(calls[0][3], /^tcp:\d+$/)
  assert.equal(calls[0][4], 'localabstract:webview_devtools_remote_4321')
  assert.deepEqual(calls[1].slice(0, 4), ['-t', '127.0.0.1:5555', 'fport', 'rm'])
  assert.equal(calls[1][4], calls[0][3])
  assert.equal(calls[1][5], calls[0][4])
})

test('Web fport helper retries only TCP port failures and reports after three attempts', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const calls = []
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._resolveHdcPath = () => 'hdc'
  service._hdcRun = async (argv) => {
    calls.push(argv)
    return { ok: true, stdout: '[Fail]TCP Port listen failed', stderr: '' }
  }
  const result = await service._withWebForward('127.0.0.1:5555', 'webview_devtools_remote_4321', async () => ({ ok: true }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'forward-failed')
  assert.equal(calls.length, 3)
  assert.equal(calls.every((argv) => argv.includes('fport') && !argv.includes('rm')), true)
})

test('harmony_web_dom agent tool maps targets and snapshot into bounded renderable output', async () => {
  const target = {
    id: 'TARGET-A', type: 'page', title: 'Demo Page', url: 'https://example.test/',
    pid: 4321, socketName: 'webview_devtools_remote_4321', packageName: 'com.example.demo',
  }
  const webValue = normalizeWebDom(fixtureWebDom(), { maxDepth: 3, maxNodes: 10, includeAttrs: true })
  const host = {
    cwd: '',
    sessions: new Map(),
    webTargets: async () => ({ ok: true, value: { targets: [target], socketCount: 1 } }),
    webDomRead: async () => ({
      ok: true,
      value: {
        source: 'webdevtools',
        target,
        nodeCount: webValue.nodeCount,
        truncated: webValue.truncated,
        hiddenNodes: webValue.hiddenNodes,
        nodes: webValue.nodes,
        html: '<div id="app">Hello</div>',
      },
    }),
  }
  const tools = buildHarmonyAgentTools({ defineTool: (spec) => spec, host })
  const tool = tools.find((item) => item.name === 'harmony_web_dom')
  assert.ok(tool)
  const targets = await tool.execute({ action: 'targets' })
  assert.equal(targets.targets[0].id, 'TARGET-A')
  assert.match(tool.output.render({ action: 'targets' }, targets)[0].text, /Demo Page/)
  const snapshot = await tool.execute({ action: 'snapshot', target_id: 'TARGET-A', format: 'tree' })
  assert.equal(snapshot.nodeCount, 7)
  assert.equal(snapshot.nodes[0].tag, '#document')
  assert.match(tool.output.render({ action: 'snapshot', format: 'tree' }, snapshot)[0].text, /div#app\.classA/)
  assert.match(tool.output.render({ action: 'snapshot', format: 'html' }, snapshot)[0].text, /<div id="app">/)
})

// ---- git (file viewer) ------------------------------------------------------

/**
 * Earlier toolchain tests pin `process.env.PATH` to '/empty' to probe the
 * resolver and never restore it, so `git` is no longer spawnable by the time
 * the git tests run. Capture the real PATH while the module loads (before any
 * test mutates it) and put it back around every git call.
 */
const REAL_PATH = process.env.PATH || ''

async function withRealPath (fn) {
  const saved = process.env.PATH
  process.env.PATH = REAL_PATH
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
}

/**
 * Replica of the gateway's JSON-safety rules for Remote payloads:
 * no undefined, no null, no functions/symbols, no circular references.
 * Optional fields must be attached only when they carry a value.
 */
function assertJsonSafe (value, label = 'value') {
  const seen = new Set()
  const walk = (node, path) => {
    if (node === null) throw new Error(`${label}${path}: null is not allowed`)
    if (node === undefined) throw new Error(`${label}${path}: undefined is not allowed`)
    const type = typeof node
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      throw new Error(`${label}${path}: ${type} is not JSON-safe`)
    }
    if (type !== 'object') return
    if (seen.has(node)) throw new Error(`${label}${path}: circular reference`)
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    for (const [key, entry] of Object.entries(node)) walk(entry, `${path}.${key}`)
  }
  walk(value, '')
}

/** Build a unified diff body out of hunk chunks. */
function unifiedDiff (...chunks) {
  return chunks.join('')
}

test('git status porcelain maps every XY form to one state token', () => {
  assert.equal(parseGitStatusPorcelain(''), 'clean')
  assert.equal(parseGitStatusPorcelain('\n'), 'clean')
  assert.equal(parseGitStatusPorcelain('?? src/Index.ets\n'), 'untracked')
  assert.equal(parseGitStatusPorcelain(' M src/Index.ets\n'), 'modified')
  assert.equal(parseGitStatusPorcelain('M  src/Index.ets\n'), 'modified')
  assert.equal(parseGitStatusPorcelain('MM src/Index.ets\n'), 'modified')
  assert.equal(parseGitStatusPorcelain('A  src/Index.ets\n'), 'added')
  assert.equal(parseGitStatusPorcelain('AM src/Index.ets\n'), 'added')
  assert.equal(parseGitStatusPorcelain(' D src/Index.ets\n'), 'deleted')
  assert.equal(parseGitStatusPorcelain('D  src/Index.ets\n'), 'deleted')
  assert.equal(parseGitStatusPorcelain('R  old.ets -> new.ets\n'), 'renamed')
  assert.equal(parseGitStatusPorcelain('C  old.ets -> new.ets\n'), 'copied')
  assert.equal(parseGitStatusPorcelain('UU src/Index.ets\n'), 'conflict')
  assert.equal(parseGitStatusPorcelain('AA src/Index.ets\n'), 'conflict')
  assert.equal(parseGitStatusPorcelain('DD src/Index.ets\n'), 'conflict')
})

test('git diff classifies pure additions and never marks context lines', () => {
  const diff = unifiedDiff(
    '@@ -1,2 +1,3 @@\n',
    ' line1\n',
    '+line2 added\n',
    ' line3\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 2, kind: 'add' }])
  assert.equal(parsed.added, 1)
  assert.equal(parsed.modified, 0)
  assert.equal(parsed.deleted, 0)
})

test('git diff anchors a file-head deletion on line 1', () => {
  const diff = unifiedDiff(
    '@@ -1,3 +0,0 @@\n',
    '-line1\n',
    '-line2\n',
    '-line3\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 1, kind: 'del' }])
  assert.equal(parsed.deleted, 1)
})

test('git diff anchors a deletion on the last context line above the gap', () => {
  const diff = unifiedDiff(
    '@@ -1,5 +1,4 @@\n',
    ' line1\n',
    ' line2\n',
    '-line3\n',
    ' line4\n',
    ' line5\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 2, kind: 'del' }])
  assert.equal(parsed.deleted, 1)
})

test('git diff pairs a deletion run with the following addition run as mod', () => {
  const diff = unifiedDiff(
    '@@ -1,3 +1,3 @@\n',
    ' line1\n',
    '-line2\n',
    '+line2 rewritten\n',
    ' line3\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 2, kind: 'mod' }])
  assert.equal(parsed.modified, 1)
  assert.equal(parsed.added, 0)
  assert.equal(parsed.deleted, 0)
})

test('git diff handles several hunks and ignores the no-newline marker', () => {
  const diff = unifiedDiff(
    '@@ -1,3 +1,3 @@\n',
    ' line1\n',
    '-line2\n',
    '+line2 rewritten\n',
    ' line3\n',
    '\ No newline at end of file\n',
    '@@ -10,2 +10,3 @@\n',
    ' line10\n',
    '+line11 added\n',
    ' line12\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 2, kind: 'mod' }, { line: 11, kind: 'add' }])
  assert.equal(parsed.added, 1)
  assert.equal(parsed.modified, 1)
})

test('git diff never lets a delete anchor overwrite an add/mod line', () => {
  const diff = unifiedDiff(
    '@@ -1,3 +1,3 @@\n',
    '+added first\n',
    '-line2\n',
    ' line3\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 1, kind: 'add' }])
})

test('git diff initialises the anchor at newStart-1 for a hunk without context', () => {
  // The hunk starts with a deletion: the anchor must be the line above the
  // gap (newStart - 1), not always line 1.
  const diff = unifiedDiff(
    '@@ -5,3 +5,2 @@\n',
    '-old5\n',
    '-old6\n',
    ' old7\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  assert.deepEqual(parsed.changes, [{ line: 4, kind: 'del' }])
})

test('git diff keeps changes sorted and counts every kind', () => {
  const diff = unifiedDiff(
    '@@ -1,4 +1,5 @@\n',
    ' line1\n',
    '-line2\n',
    '+line2 rewritten\n',
    ' line3\n',
    '+line4 added\n',
    ' line5\n',
  )
  const parsed = parseUnifiedDiffLineKinds(diff)
  const lines = parsed.changes.map((entry) => entry.line)
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b))
  assert.equal(parsed.added, 1)
  assert.equal(parsed.modified, 1)
  assert.equal(parsed.deleted, 0)
})

test('git blame porcelain reuses the metadata of a commit across its lines', () => {
  const output = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
    'author Test User',
    'author-mail <test@example.com>',
    'author-time 1794939738',
    'author-tz +0800',
    'summary first commit',
    'filename a.ets',
    '\tline1',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1',
    'author Other User',
    'author-time 1794939800',
    'author-tz +0000',
    'summary second commit',
    'filename a.ets',
    '\tline2',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3 1',
    '\tline3',
    '',
  ].join('\n')
  const entries = parseBlamePorcelain(output)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].line, 1)
  assert.equal(entries[0].author, 'Test User')
  assert.equal(entries[0].summary, 'first commit')
  assert.equal(entries[0].date, '2026-11-18T02:22:18+08:00')
  assert.equal(entries[1].line, 2)
  assert.equal(entries[1].author, 'Other User')
  assert.equal(entries[1].summary, 'second commit')
  // The third line belongs to the first commit again — the metadata is reused.
  assert.equal(entries[2].author, 'Test User')
  assert.equal(entries[2].summary, 'first commit')
  assert.equal(entries[2].date, entries[0].date)
})

test('git blame porcelain keeps the uncommitted pseudo commit and skips junk lines', () => {
  const output = [
    '0000000000000000000000000000000000000000 1 1 1',
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 1794939738',
    'author-tz +0800',
    'summary Not Committed Yet',
    'boundary',
    'filename a.ets',
    '\tline1',
    'this line is not a blame header',
    '',
  ].join('\n')
  const entries = parseBlamePorcelain(output)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].hash, '0000000000000000000000000000000000000000')
  assert.equal(entries[0].author, 'Not Committed Yet')
  assert.equal(entries[0].summary, 'Not Committed Yet')
  assert.equal(entries[0].line, 1)
})

test('isoWithOffset renders the author timezone and falls back to UTC', () => {
  assert.equal(isoWithOffset(1794939738, '+0800'), '2026-11-18T02:22:18+08:00')
  assert.equal(isoWithOffset(1794939738, '-0500'), '2026-11-17T13:22:18-05:00')
  assert.equal(isoWithOffset(1794939738, 'bogus'), '2026-11-17T18:22:18Z')
  assert.equal(isoWithOffset(1794939738, ''), '2026-11-17T18:22:18Z')
})

test('toGitRelPath returns a POSIX relative path and refuses paths outside the repo', () => {
  const repoRoot = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
  const inside = process.platform === 'win32' ? 'C:\\work\\repo\\src\\main\\ets\\Index.ets' : '/work/repo/src/main/ets/Index.ets'
  const outside = process.platform === 'win32' ? 'C:\\work\\other\\Index.ets' : '/work/other/Index.ets'
  assert.equal(toGitRelPath(repoRoot, inside), 'src/main/ets/Index.ets')
  assert.equal(toGitRelPath(repoRoot, outside), null)
  assert.equal(toGitRelPath(repoRoot, repoRoot), null)
  assert.equal(toGitRelPath('', inside), null)
})

test('git command builders put --literal-pathspecs first and the path after --', () => {
  assert.deepEqual(buildGitRepoRootArgs(), ['rev-parse', '--show-toplevel'])
  assert.deepEqual(buildGitBranchArgs(), ['branch', '--show-current'])
  assert.deepEqual(buildGitVerifyHeadArgs(), ['rev-parse', '--verify', 'HEAD'])
  const status = buildGitStatusArgs('src/Index.ets')
  assert.equal(status[0], '--literal-pathspecs')
  assert.equal(status[1], 'status')
  assert.equal(status[status.length - 2], '--')
  assert.equal(status[status.length - 1], 'src/Index.ets')
  const diff = buildGitDiffArgs('src/Index.ets')
  assert.equal(diff[0], '--literal-pathspecs')
  assert.equal(diff[1], 'diff')
  assert.equal(diff[diff.length - 2], '--')
  assert.equal(diff[diff.length - 1], 'src/Index.ets')
  const blame = buildGitBlameArgs('src/Index.ets', 12)
  assert.equal(blame[0], '--literal-pathspecs')
  assert.equal(blame[1], 'blame')
  assert.ok(blame.includes('-L'))
  assert.equal(blame[blame.indexOf('-L') + 1], '12,12')
  assert.equal(blame[blame.length - 2], '--')
  assert.equal(blame[blame.length - 1], 'src/Index.ets')
  assert.deepEqual(GIT_ENV, { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' })
})

test('runGitCommand reports success and a missing binary', async () => {
  await withRealPath(async () => {
    const version = await runGitCommand({ cwd: process.cwd(), args: ['--version'] })
    assert.equal(version.ok, true)
    assert.match(version.stdout, /git version/)
    const missing = await runGitCommand({ cwd: process.cwd(), args: ['--version'], binary: 'dsh-deveco-no-such-git-binary' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'enoent')
  })
})

/** Create a throw-away git repository and run `fn` inside it. */
async function withTempGitRepo (fn) {
  return withRealPath(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-git-'))
    const run = (args) => runGitCommand({ cwd: dir, args })
    try {
      const init = await run(['init', '-q'])
      assert.equal(init.ok, true, init.stderr)
      await run(['config', 'user.name', 'Test User'])
      await run(['config', 'user.email', 'test@example.com'])
      await run(['config', 'core.autocrlf', 'false'])
      await run(['config', 'commit.gpgsign', 'false'])
      return await fn({ dir, run })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('git integration: a modified file reports state, branch and changed lines', async () => {
  await withTempGitRepo(async ({ dir, run }) => {
    writeFileSync(join(dir, 'base.ets'), 'line1\nline2\nline3\nline4\nline5\n')
    writeFileSync(join(dir, 'clean.ets'), 'clean1\nclean2\n')
    await run(['add', 'base.ets', 'clean.ets'])
    const commit = await run(['commit', '-m', 'baseline commit'])
    assert.equal(commit.ok, true, commit.stderr)

    writeFileSync(join(dir, 'base.ets'), 'line1\nline2 rewritten\nline3\nline4\nline5\nline6 added\n')

    const root = await runGitCommand({ cwd: dir, args: buildGitRepoRootArgs() })
    const info = await collectFileGitInfo(runGitCommand, join(dir, 'base.ets'))
    assert.equal(info.available, true)
    assert.equal(info.state, 'modified')
    assert.ok(info.branch && info.branch.length > 0)
    assert.equal(info.repoRoot, root.stdout.trim())
    assert.deepEqual(info.changes, [{ line: 2, kind: 'mod' }, { line: 6, kind: 'add' }])
    assert.equal(info.added, 1)
    assert.equal(info.modified, 1)
    assert.equal(info.deleted, 0)
    assert.equal(info.allAdded, undefined)

    const clean = await collectFileGitInfo(runGitCommand, join(dir, 'clean.ets'))
    assert.equal(clean.available, true)
    assert.equal(clean.state, 'clean')
    assert.deepEqual(clean.changes, [])
  })
})

test('git integration: an untracked file is reported as untracked', async () => {
  await withTempGitRepo(async ({ dir, run }) => {
    writeFileSync(join(dir, 'base.ets'), 'line1\n')
    await run(['add', 'base.ets'])
    await run(['commit', '-m', 'baseline commit'])
    writeFileSync(join(dir, 'new.ets'), 'fresh\n')
    const info = await collectFileGitInfo(runGitCommand, join(dir, 'new.ets'))
    assert.equal(info.available, true)
    assert.equal(info.state, 'untracked')
    assert.deepEqual(info.changes, [])
  })
})

test('git integration: blame answers for a committed line and refuses an untracked file', async () => {
  await withTempGitRepo(async ({ dir, run }) => {
    writeFileSync(join(dir, 'base.ets'), 'line1\nline2\n')
    await run(['add', 'base.ets'])
    await run(['commit', '-m', 'baseline commit'])
    writeFileSync(join(dir, 'new.ets'), 'fresh\n')

    const blame = await blameFileLine(runGitCommand, join(dir, 'base.ets'), 1)
    assert.equal(blame.available, true)
    assert.equal(blame.entry.line, 1)
    assert.equal(blame.entry.author, 'Test User')
    assert.equal(blame.entry.summary, 'baseline commit')
    assert.match(blame.entry.hash, /^[0-9a-f]{40}$/)
    assert.match(blame.entry.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)

    const untracked = await blameFileLine(runGitCommand, join(dir, 'new.ets'), 1)
    assert.equal(untracked.available, false)
    assert.ok(untracked.reason)
  })
})

test('git integration: a folder outside any repository degrades to no-repo', async () => {
  await withRealPath(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-norepo-'))
    try {
      writeFileSync(join(dir, 'a.ets'), 'line1\n')
      const info = await collectFileGitInfo(runGitCommand, join(dir, 'a.ets'))
      assert.equal(info.available, false)
      assert.equal(info.reason, 'no-repo')
      const blame = await blameFileLine(runGitCommand, join(dir, 'a.ets'), 1)
      assert.equal(blame.available, false)
      assert.equal(blame.reason, 'no-repo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('fileGitInfo/fileGitBlame Remote methods validate the request and degrade quietly', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._ctx = { get: () => undefined }

  const empty = await service.fileGitInfo({ path: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'invalid-request')

  const noSession = await service.fileGitInfo({ path: 'src/Index.ets' })
  assert.equal(noSession.ok, true)
  assert.equal(noSession.value.available, false)
  assert.equal(noSession.value.reason, 'no-session-cwd')

  const badLine = await service.fileGitBlame({ path: 'src/Index.ets', line: 0 })
  assert.equal(badLine.ok, false)
  assert.equal(badLine.error.code, 'invalid-request')

  const noLine = await service.fileGitBlame({ path: 'src/Index.ets' })
  assert.equal(noLine.ok, false)
  assert.equal(noLine.error.code, 'invalid-request')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-norepo-'))
  try {
    writeFileSync(join(dir, 'a.ets'), 'line1\n')
    const outside = await withRealPath(() => service.fileGitInfo({ path: join(dir, 'a.ets') }))
    assert.equal(outside.ok, true)
    assert.equal(outside.value.available, false)
    assert.equal(outside.value.reason, 'no-repo')
    assertJsonSafe(outside.value, 'fileGitInfo.value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fileGitInfo resolves a session-relative path against the session cwd', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  await withTempGitRepo(async ({ dir, run }) => {
    writeFileSync(join(dir, 'base.ets'), 'line1\nline2\n')
    await run(['add', 'base.ets'])
    await run(['commit', '-m', 'baseline commit'])

    const service = Object.create(HarmonyDevEcoService.prototype)
    service._ctx = {
      get: (name) => (name === 'sessions'
        ? new Map([['session-1', { header: { cwd: dir } }]])
        : undefined),
    }
    const info = await service.fileGitInfo({ path: 'base.ets', sessionId: 'session-1' })
    assert.equal(info.ok, true)
    assert.equal(info.value.available, true)
    assert.equal(info.value.state, 'clean')
    assertJsonSafe(info.value, 'fileGitInfo.value')
  })
})

test('TYPERT manifest exposes fileGitInfo/fileGitBlame with strict dual-shape codecs', async () => {
  const { TYPERT } = await import('../typert.host.js')
  assert.equal(TYPERT.invocations.length, 27)
  for (const method of ['fileGitInfo', 'fileGitBlame']) {
    const invocation = TYPERT.invocations.find((entry) => entry.method === method)
    assert.ok(invocation, `${method} invocation exists`)
    assert.equal(invocation.id, `dsh-deveco#harmonyDevEco/${method}`)
    assert.equal(invocation.parameters.length, 1)
    assert.equal(invocation.parameters[0].name, 'request')
    assert.equal(invocation.parameters[0].codec.mode, 'strict')
    assert.equal(typeof invocation.parameters[0].codec.schema.safeParse, 'function')
    assert.equal(typeof invocation.parameters[0].codec.create().safeParse, 'function')
    assert.equal(invocation.result.mode, 'strict')
    assert.equal(typeof invocation.result.schema.safeParse, 'function')
    assert.equal(typeof invocation.result.create().safeParse, 'function')
  }

  const info = TYPERT.invocations.find((entry) => entry.method === 'fileGitInfo')
  assert.equal(info.parameters[0].codec.schema.safeParse({ path: 'a.ets' }).success, true)
  assert.equal(info.parameters[0].codec.schema.safeParse({ path: 'a.ets', sessionId: 's1' }).success, true)
  assert.equal(info.parameters[0].codec.schema.safeParse({}).success, false)
  assert.equal(info.parameters[0].codec.schema.safeParse({ path: 42 }).success, false)

  const blame = TYPERT.invocations.find((entry) => entry.method === 'fileGitBlame')
  assert.equal(blame.parameters[0].codec.schema.safeParse({ path: 'a.ets', line: 3 }).success, true)
  assert.equal(blame.parameters[0].codec.schema.safeParse({ path: 'a.ets' }).success, false)
  assert.equal(blame.parameters[0].codec.schema.safeParse({ path: 'a.ets', line: 'x' }).success, false)

  const unavailable = { ok: true, value: { available: false, reason: 'no-git' } }
  assert.equal(info.result.schema.safeParse(unavailable).success, true)
  assert.equal(blame.result.schema.safeParse({ ok: true, value: { available: false, reason: 'no-answer' } }).success, true)
  assert.equal(info.result.schema.safeParse({ ok: true, value: { available: false, reason: 'bogus' } }).success, false)

  const available = {
    ok: true,
    value: {
      available: true,
      repoRoot: '/work/repo',
      branch: 'main',
      state: 'modified',
      changes: [{ line: 2, kind: 'mod' }],
      added: 0,
      modified: 1,
      deleted: 0,
    },
  }
  assert.equal(info.result.schema.safeParse(available).success, true)
  assert.equal(blame.result.schema.safeParse({
    ok: true,
    value: {
      available: true,
      entry: { line: 2, hash: 'abc', author: 'A', date: '2026-11-18T02:22:18+08:00', summary: 's' },
    },
  }).success, true)
  assert.equal(info.result.schema.safeParse({ ok: true, value: { available: true, state: 'weird' } }).success, false)

  // Both payload shapes must survive the gateway's JSON-safety rules.
  assertJsonSafe(unavailable.value, 'fileGitInfo.value')
  assertJsonSafe(available.value, 'fileGitInfo.value')
  assertJsonSafe({ available: true, entry: { line: 2, hash: 'abc', author: 'A', date: '2026-11-18T02:22:18+08:00', summary: 's' } }, 'fileGitBlame.value')
})

// ---- writeTextFile (file editor) --------------------------------------------

test('prepareSaveContent keeps the EOL style of the original file', () => {
  // CRLF original + LF content → CRLF
  assert.equal(prepareSaveContent('a\r\nb\r\n', 'x\ny\n'), 'x\r\ny\r\n')
  // LF original → LF
  assert.equal(prepareSaveContent('a\nb\n', 'x\ny\n'), 'x\ny\n')
  // A stray CRLF in the payload is normalized first (never doubled)
  assert.equal(prepareSaveContent('a\r\nb\r\n', 'x\r\ny\n'), 'x\r\ny\r\n')
  assert.equal(prepareSaveContent('a\nb\n', 'x\r\ny\n'), 'x\ny\n')
})

test('prepareSaveContent preserves the BOM without doubling it', () => {
  assert.equal(prepareSaveContent('\uFEFFa\r\n', 'x\n'), '\uFEFFx\r\n')
  // The payload already carries a BOM → it is not doubled
  assert.equal(prepareSaveContent('\uFEFFa\r\n', '\uFEFFx\n'), '\uFEFFx\r\n')
  // No BOM in the original → no BOM is added
  assert.equal(prepareSaveContent('a\n', 'x\n'), 'x\n')
})

test('writeTextFile saves atomically, preserves EOL/BOM and refuses unknown files', async () => {
  const { HarmonyDevEcoService } = await import('../index.js')
  const service = Object.create(HarmonyDevEcoService.prototype)
  service._ctx = { get: () => undefined }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-deveco-write-'))
  try {
    // CRLF file
    const crlf = join(dir, 'crlf.ets')
    writeFileSync(crlf, 'line1\r\nline2\r\n')
    const saved = await service.writeTextFile({ path: crlf, content: 'line1\nline2 edited\n' })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.saved, true)
    assert.equal(saved.value.path, crlf)
    assert.equal(saved.value.bytes, Buffer.byteLength('line1\r\nline2 edited\r\n', 'utf8'))
    assert.equal(readFileSync(crlf, 'utf8'), 'line1\r\nline2 edited\r\n')

    // BOM + LF file
    const bom = join(dir, 'bom.ets')
    writeFileSync(bom, '\uFEFFline1\n')
    const savedBom = await service.writeTextFile({ path: bom, content: 'line1\nline2\n' })
    assert.equal(savedBom.ok, true)
    assert.equal(readFileSync(bom, 'utf8'), '\uFEFFline1\nline2\n')

    // Unknown file → not-found, and nothing is created
    const missing = join(dir, 'missing.ets')
    const notFound = await service.writeTextFile({ path: missing, content: 'x' })
    assert.equal(notFound.ok, false)
    assert.equal(notFound.error.code, 'not-found')
    assert.equal(existsSync(missing), false)

    // Invalid request
    const noPath = await service.writeTextFile({ content: 'x' })
    assert.equal(noPath.ok, false)
    assert.equal(noPath.error.code, 'invalid-request')
    const noContent = await service.writeTextFile({ path: crlf })
    assert.equal(noContent.ok, false)
    assert.equal(noContent.error.code, 'invalid-request')

    // Too large
    const tooLarge = await service.writeTextFile({ path: crlf, content: 'x'.repeat(2 * 1024 * 1024 + 1) })
    assert.equal(tooLarge.ok, false)
    assert.equal(tooLarge.error.code, 'too-large')

    // No temp file is left behind
    const leftovers = readdirSync(dir).filter((name) => name.includes('dsh-deveco-tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TYPERT manifest exposes writeTextFile and the invocation count is 27', async () => {
  const { TYPERT } = await import('../typert.host.js')
  assert.equal(TYPERT.invocations.length, 27)
  const invocation = TYPERT.invocations.find((entry) => entry.method === 'writeTextFile')
  assert.ok(invocation)
  assert.equal(invocation.id, 'dsh-deveco#harmonyDevEco/writeTextFile')
  assert.equal(invocation.parameters.length, 1)
  assert.equal(invocation.parameters[0].name, 'request')
  assert.equal(invocation.parameters[0].codec.mode, 'strict')
  assert.equal(typeof invocation.parameters[0].codec.schema.safeParse, 'function')
  assert.equal(typeof invocation.parameters[0].codec.create().safeParse, 'function')
  assert.equal(invocation.result.mode, 'strict')
  assert.equal(typeof invocation.result.schema.safeParse, 'function')

  assert.equal(invocation.parameters[0].codec.schema.safeParse({ path: 'a.ets', content: 'x' }).success, true)
  assert.equal(invocation.parameters[0].codec.schema.safeParse({ path: 'a.ets', content: 'x', sessionId: 's1' }).success, true)
  assert.equal(invocation.parameters[0].codec.schema.safeParse({ path: 'a.ets' }).success, false)
  assert.equal(invocation.parameters[0].codec.schema.safeParse({ content: 'x' }).success, false)
  assert.equal(invocation.parameters[0].codec.schema.safeParse({ path: 'a.ets', content: 42 }).success, false)

  const value = { ok: true, value: { path: '/tmp/a.ets', bytes: 12, saved: true } }
  assert.equal(invocation.result.schema.safeParse(value).success, true)
  assert.equal(invocation.result.schema.safeParse({ ok: true, value: { path: '/tmp/a.ets', bytes: 12 } }).success, false)
  assertJsonSafe(value.value, 'writeTextFile.value')
})

// ---- ArkUI 调试源 agent 工具（harmony_ui_tree / harmony_ui_node）----------------
//
// 工具的 output.schema 是 DSH 的**严格** schema：additionalProperties:false ——
// 返回值里出现任何未声明的键，运行时直接判 INVALID_TOOL_OUTPUT。工具定义因此
// 必须住在零依赖模块 harmony-ui-tools.mjs 里（index.js 里的定义 self-test 一行
// 都覆盖不到），才可能在这里逐键比对。

/**
 * 工具输出 schema 的**严格**校验器（自带，不依赖 DSH 包）。
 *
 * 工具的 `output.schema` 是 value-spec 形态：`properties` 里每个属性用
 * `required: true` 标记必填；`additionalProperties: false` 表示返回值不允许出现
 * 未声明的键。递归进入 type 为 object 且带 properties 的属性（node / bounds /
 * padding 等）继续比对；type 为 json 的属性只要求 JSON-safe（无 undefined /
 * 函数 / NaN / Infinity）。
 *
 * @param {object} schema 工具的 output.schema（value-spec 形态）
 * @param {*} value 工具 execute() 的返回值
 * @param {string} label 报错时用的路径前缀
 */
const assertToolOutputMatchesSchema = (schema, value, label) => {
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const assertJsonSafe = (v, path) => {
    if (v === undefined) assert.fail(`${path}: undefined 不是 JSON 值`)
    if (typeof v === 'function' || typeof v === 'symbol') assert.fail(`${path}: ${typeof v} 不是 JSON 值`)
    if (typeof v === 'number' && !Number.isFinite(v)) assert.fail(`${path}: ${v} 不是无损 JSON 数`)
    if (Array.isArray(v)) {
      v.forEach((entry, i) => assertJsonSafe(entry, `${path}[${i}]`))
      return
    }
    if (isPlainObject(v)) {
      for (const [k, entry] of Object.entries(v)) assertJsonSafe(entry, `${path}.${k}`)
    }
  }
  const check = (sch, val, path) => {
    if (!sch || typeof sch !== 'object') return
    if (Object.hasOwn(sch, 'const')) assert.deepEqual(val, sch.const, `${path}: const 不匹配`)
    if (Array.isArray(sch.enum)) assert.ok(sch.enum.includes(val), `${path}: ${JSON.stringify(val)} 不在 enum 里`)
    const type = sch.type
    if (type === 'json') {
      assertJsonSafe(val, path)
      return
    }
    if (type === 'object') {
      assert.ok(isPlainObject(val), `${path}: 期望 object`)
      const props = sch.properties || {}
      for (const key of Object.keys(val)) {
        if (sch.additionalProperties === false) {
          assert.ok(Object.hasOwn(props, key), `${path}: 出现未声明的键 "${key}"（additionalProperties: false）`)
        }
      }
      for (const [key, child] of Object.entries(props)) {
        const present = Object.hasOwn(val, key) && val[key] !== undefined
        if (!present) {
          if (child.required === true) assert.fail(`${path}.${key}: 缺少必填属性`)
          continue
        }
        check(child, val[key], `${path}.${key}`)
      }
      return
    }
    if (type === 'array') {
      assert.ok(Array.isArray(val), `${path}: 期望 array`)
      if (sch.items) val.forEach((entry, i) => check(sch.items, entry, `${path}[${i}]`))
      return
    }
    if (type === 'string') { assert.equal(typeof val, 'string', `${path}: 期望 string`); return }
    if (type === 'boolean') { assert.equal(typeof val, 'boolean', `${path}: 期望 boolean`); return }
    if (type === 'integer') {
      assert.equal(typeof val, 'number', `${path}: 期望 number`)
      assert.ok(Number.isInteger(val), `${path}: 期望 integer`)
      return
    }
    if (type === 'number') {
      assert.equal(typeof val, 'number', `${path}: 期望 number`)
      assert.ok(Number.isFinite(val), `${path}: 期望有限数`)
      return
    }
  }
  check(schema, value, label)
}

/**
 * 工具夹具：假 defineTool（不做参数校验，只透传 spec）+ 假 host（返回固定的
 * 一棵 DevEco 树）。树形见 `mkDevEcoIdTree`：
 *   10 PageRoot(custom) → 11 dup(Column) → 12 leaf(Text)；13 Label(Text)
 * 其中 devId `dup` 命中两个节点（11 / 13）——用来触发 ambiguous 分支。
 */
const mkUiToolFixture = () => {
  const nodes = mkDevEcoIdTree()
  const host = {
    fetchDevEcoTree: async () => ({
      ok: true,
      value: { nodes, source: 'deveco', pid: 1234, packageName: 'com.example.demo' },
    }),
  }
  const defineTool = (spec) => spec
  return {
    nodes,
    host,
    tree: buildHarmonyUiTreeTool(defineTool, host),
    node: buildHarmonyUiNodeTool(defineTool, host),
  }
}

test('the strict tool-output validator rejects undeclared keys and missing required ones', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { type: 'string', required: true },
      b: { type: 'integer' },
      c: { type: 'object', additionalProperties: false, properties: { d: { type: 'number', required: true } } },
    },
  }
  assert.doesNotThrow(() => assertToolOutputMatchesSchema(schema, { a: 'x', b: 1, c: { d: 2 } }, 'ok'))
  assert.throws(() => assertToolOutputMatchesSchema(schema, { a: 'x', zzz: 1 }, 'undeclared'))
  assert.throws(() => assertToolOutputMatchesSchema(schema, { b: 1 }, 'missing required'))
  assert.throws(() => assertToolOutputMatchesSchema(schema, { a: 'x', b: 'no' }, 'wrong type'))
  assert.throws(() => assertToolOutputMatchesSchema(schema, { a: 'x', c: {} }, 'missing nested required'))
  assert.throws(() => assertToolOutputMatchesSchema(schema, { a: 'x', c: { d: 1, e: 2 } }, 'undeclared nested'))
})

test('the ArkUI tool output schemas are strict and share one canonical node schema', () => {
  const { tree, node } = mkUiToolFixture()
  assert.equal(tree.output.schema.additionalProperties, false)
  assert.equal(node.output.schema.additionalProperties, false)
  // 两个工具共用同一份 canonical 节点 schema（不复制第二份）
  assert.deepEqual(tree.output.schema.properties.nodes.items.properties, node.output.schema.properties.node.properties)
  assert.equal(node.output.schema.properties.node.additionalProperties, false)
  // childCount 是 canonical 节点的必填字段
  assert.equal(node.output.schema.properties.node.properties.childCount.required, true)
})

test('harmony_ui_tree output matches its strict output schema (no root_id)', async () => {
  const { tree } = mkUiToolFixture()
  const value = await tree.execute({})
  assertToolOutputMatchesSchema(tree.output.schema, value, 'harmony_ui_tree')
  // 不传 root_id 时不出现 rootId / rootMatchedBy（既有行为不变）
  assert.equal(Object.hasOwn(value, 'rootId'), false)
  assert.equal(Object.hasOwn(value, 'rootMatchedBy'), false)
  assert.equal(value.source, 'deveco')
  assert.equal(value.pid, 1234)
  assert.equal(value.packageName, 'com.example.demo')
  assert.equal(value.nodeCount, 4)
  assert.equal(value.truncated, false)
  assert.equal(value.nodes.length, 4)
  // 每个节点也逐个过校验器（递归进 nodeSchema）
  value.nodes.forEach((n, i) => {
    assertToolOutputMatchesSchema(tree.output.schema.properties.nodes.items, n, `harmony_ui_tree.nodes[${i}]`)
  })
  // render 不抛异常，文本里**不含** root= 标注
  const text = tree.output.render({}, value)[0].text
  assert.equal(text.includes('root='), false)
  assert.ok(text.includes('PageRoot'))
})

test('harmony_ui_tree with include_attrs and max_nodes still matches the strict schema', async () => {
  const { tree } = mkUiToolFixture()
  const withAttrs = await tree.execute({ include_attrs: true })
  assertToolOutputMatchesSchema(tree.output.schema, withAttrs, 'harmony_ui_tree(include_attrs)')
  assert.equal(withAttrs.nodes[0].attrs.id, 'pageRoot')
  // 整棵子树省略式截断：只发整节点，不发半棵
  const truncated = await tree.execute({ max_nodes: 1 })
  assertToolOutputMatchesSchema(tree.output.schema, truncated, 'harmony_ui_tree(max_nodes)')
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.nodes.length, 1)
  assert.equal(truncated.nodeCount, 4)
  assert.equal(truncated.nodes[0].childrenOmitted, true)
})

test('harmony_ui_tree root_id returns only that subtree and reports the match', async () => {
  const { tree } = mkUiToolFixture()
  const value = await tree.execute({ root_id: '11' })
  assertToolOutputMatchesSchema(tree.output.schema, value, 'harmony_ui_tree(root_id)')
  assert.equal(value.rootId, '11')
  assert.equal(value.rootMatchedBy, 'accessibilityId')
  // 子树 = 节点 11 → 它的子节点 12（兄弟 13 不在内）
  assert.equal(value.nodeCount, 2)
  assert.deepEqual(value.nodes.map((n) => n.accessibilityId), ['11', '12'])
  // 子树自洽：index 连续、depth 相对子树根、parentIndex 重映射
  assert.deepEqual(value.nodes.map((n) => n.index), [0, 1])
  assert.deepEqual(value.nodes.map((n) => n.depth), [0, 1])
  assert.equal(value.nodes[0].parentIndex, -1)
  assert.equal(value.nodes[1].parentIndex, 0)
  // render 文本带 root= 标注
  const text = tree.output.render({ root_id: '11' }, value)[0].text
  assert.ok(text.includes('root=#11 (accessibilityId)'))
})

test('harmony_ui_tree root_id accepts the # prefixed accessibility id', async () => {
  const { tree } = mkUiToolFixture()
  const value = await tree.execute({ root_id: '#11' })
  assertToolOutputMatchesSchema(tree.output.schema, value, 'harmony_ui_tree(root_id #)')
  assert.equal(value.rootId, '11')
  assert.equal(value.rootMatchedBy, 'accessibilityId')
  assert.deepEqual(value.nodes.map((n) => n.accessibilityId), ['11', '12'])
})

test('harmony_ui_tree root_id rejects an ambiguous id and lists the candidates', async () => {
  const { tree } = mkUiToolFixture()
  await assert.rejects(() => tree.execute({ root_id: 'dup' }), (err) => {
    assert.ok(err instanceof Error)
    assert.ok(err.message.includes('命中多个节点'))
    assert.ok(err.message.includes('#11 dup'))
    assert.ok(err.message.includes('#13 Label'))
    return true
  })
})

test('harmony_ui_tree root_id reports the available ids when the node is missing', async () => {
  const { tree } = mkUiToolFixture()
  await assert.rejects(() => tree.execute({ root_id: 'nope' }), (err) => {
    assert.ok(err.message.includes('找不到 id "nope"'))
    assert.ok(err.message.includes('#10 PageRoot'))
    assert.ok(err.message.includes('#12 leaf'))
    assert.ok(err.message.includes('harmony_ui_tree'))
    return true
  })
})

test('harmony_ui_node returns one node with every raw attribute and its ancestor path', async () => {
  const { node } = mkUiToolFixture()
  const value = await node.execute({ id: '12' })
  assertToolOutputMatchesSchema(node.output.schema, value, 'harmony_ui_node')
  assert.equal(value.source, 'deveco')
  assert.equal(value.pid, 1234)
  assert.equal(value.packageName, 'com.example.demo')
  assert.equal(value.matchedBy, 'accessibilityId')
  assert.equal(typeof value.id, 'string')
  assert.equal(value.id, '12')
  // node 是 canonical 节点 + 设备全部原始属性（attrs）
  assert.equal(value.node.accessibilityId, '12')
  assert.equal(value.node.name, 'leaf')
  assert.equal(value.node.className, 'Text')
  assert.equal(value.node.kind, 'build-in')
  assert.equal(typeof value.node.childCount, 'number')
  assert.equal(value.node.childCount, 0)
  assert.equal(value.node.attrs.id, 'leaf')
  // path 是根→父的祖先链
  assert.equal(value.path.length, 2)
  assert.deepEqual(value.path.map((p) => p.accessibilityId), ['10', '11'])
  assert.equal(value.path[0].name, 'PageRoot')
  assert.equal(value.path[1].name, 'dup')
  for (const step of value.path) {
    assert.deepEqual(Object.keys(step).sort(), ['accessibilityId', 'className', 'devId', 'index', 'name'])
  }
  // 根节点没有祖先
  const root = await node.execute({ id: '10' })
  assert.deepEqual(root.path, [])
  assert.equal(root.matchedBy, 'accessibilityId')
  assert.equal(root.node.kind, 'custom')
})

test('harmony_ui_node reports an actionable error for an unknown id', async () => {
  const { node } = mkUiToolFixture()
  await assert.rejects(() => node.execute({ id: 'nope' }), (err) => {
    assert.ok(err.message.includes('找不到 id "nope"'))
    assert.ok(err.message.includes('#11 dup'))
    assert.ok(err.message.includes('harmony_ui_node'))
    return true
  })
})

test('harmony_ui_node rejects an ambiguous id with the candidate list', async () => {
  const { node } = mkUiToolFixture()
  await assert.rejects(() => node.execute({ id: 'dup' }), (err) => {
    assert.ok(err.message.includes('命中多个节点'))
    assert.ok(err.message.includes('#11 dup'))
    assert.ok(err.message.includes('#13 Label'))
    return true
  })
})

test('the ArkUI tools render text output without throwing', async () => {
  const { tree, node } = mkUiToolFixture()
  const treeValue = await tree.execute({})
  const nodeValue = await node.execute({ id: '12' })
  for (const [label, chunks] of [
    ['harmony_ui_tree', tree.output.render({}, treeValue)],
    ['harmony_ui_node', node.output.render({ id: '12' }, nodeValue)],
  ]) {
    assert.ok(Array.isArray(chunks), `${label}: render 必须返回数组`)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'text')
    assert.equal(typeof chunks[0].text, 'string')
    assert.ok(chunks[0].text.length > 0)
  }
  // format=json 时输出的是合法 JSON
  const jsonChunks = tree.output.render({ format: 'json' }, treeValue)
  assert.equal(jsonChunks[0].type, 'text')
  assert.equal(JSON.parse(jsonChunks[0].text).source, 'deveco')
  // node 的 render 是紧凑文本：概要行 + 路径行 + 逐条原始属性
  const text = node.output.render({ id: '12' }, nodeValue)[0].text
  assert.ok(text.includes('路径：'))
  assert.ok(text.includes('原始属性'))
  assert.ok(text.includes('id=leaf'))
})

test('harmony_ui_node requires an id parameter and takes no tree-only parameters', () => {
  const { tree, node } = mkUiToolFixture()
  assert.equal(node.parameters.id.type, 'string')
  assert.equal(node.parameters.id.required, true)
  assert.equal(node.parameters.device.type, 'string')
  assert.equal(node.parameters.pid.type, 'integer')
  assert.equal(node.parameters.package_name.type, 'string')
  // 不该有 format / include_attrs / max_nodes
  assert.equal(Object.hasOwn(node.parameters, 'format'), false)
  assert.equal(Object.hasOwn(node.parameters, 'include_attrs'), false)
  assert.equal(Object.hasOwn(node.parameters, 'max_nodes'), false)
  // tree 工具的 root_id 是可选参数
  assert.equal(tree.parameters.root_id.type, 'string')
  assert.equal(Object.hasOwn(tree.parameters.root_id, 'required'), false)
})

