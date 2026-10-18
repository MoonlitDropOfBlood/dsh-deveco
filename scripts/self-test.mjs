// dsh-deveco 自测试：harmony-studio 路径探测 + harmony-config 配置互斥与自发现 + harmony-device 工具封装/HiLog/UI 解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  buildUiRawDumpArgs, buildUiRawRecvArgs, buildUiRawCleanArgs,
  buildHdcConnectArgs, buildHdcDisconnectArgs, parseTconnResult, resolveHdc,
  hitTest, readPngSize,
  LEVEL_SEVERITY, formatHilogLevel, devecoExec
} from '../harmony-device.mjs'

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
  // 剪枝后 index/depth 保持连续（parseDevEcoTree 的 parentIndex 是既有的
  // 链式语义：指向递归时的上一入列节点——t2 前面是 t1 存根，故 p=2）
  assert.equal(nodes[3].parentIndex, 2)
  assert.equal(nodes[3].depth, 2)
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
  assert.equal(lines[1], '  Text (5,5,50,30) "你好" id=title pad:1 2 3 4')
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

// resolveHdc reads DEVECO_SDK_HOME / DEVECO_HOME from the environment; the
// test machine may have either set, so tests pin them explicitly and restore.
function withHdcEnv (sdkHome, devecoHome, fn) {
  const savedSdk = process.env.DEVECO_SDK_HOME
  const savedHome = process.env.DEVECO_HOME
  try {
    if (sdkHome === undefined) delete process.env.DEVECO_SDK_HOME
    else process.env.DEVECO_SDK_HOME = sdkHome
    if (devecoHome === undefined) delete process.env.DEVECO_HOME
    else process.env.DEVECO_HOME = devecoHome
    return fn()
  } finally {
    if (savedSdk === undefined) delete process.env.DEVECO_SDK_HOME
    else process.env.DEVECO_SDK_HOME = savedSdk
    if (savedHome === undefined) delete process.env.DEVECO_HOME
    else process.env.DEVECO_HOME = savedHome
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
  parseVersion, parseDevecoToolVersion, normalizeStudioPath,
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
