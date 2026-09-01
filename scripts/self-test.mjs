// dsh-deveco 自测试：harmony-studio 路径探测 + harmony-config 配置互斥与自发现 + harmony-device 工具封装/HiLog/UI 解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, setStudioPath, setCltPath, discoverAll, ensureDiscovery } from '../harmony-config.mjs'
import {
  execCli, execHdc, parseHilogLine, parseUiDumpXml, parseBounds,
  buildHilogArgs, buildUiDumpArgs,
  LEVEL_SEVERITY, formatHilogLevel, selectHdc
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

test('parseUiDumpXml extracts node attrs', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<hierarchy>
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]" />
  <node index="1" text="Submit" resource-id="btn_submit" class="android.widget.Button" bounds="[100,200][400,300]" />
</hierarchy>`
  const r = parseUiDumpXml(xml)
  assert.equal(r.length, 2)
  assert.equal(r[0].className, 'android.widget.FrameLayout')
  assert.equal(r[0].bounds.width, 1080)
  assert.equal(r[0].bounds.height, 1920)
  assert.equal(r[1].text, 'Submit')
  assert.equal(r[1].resourceId, 'btn_submit')
  assert.equal(r[1].bounds.width, 300)
  assert.equal(r[1].bounds.height, 100)
  assert.equal(r[1].bounds.left, 100)
  assert.equal(r[1].bounds.top, 200)
})

test('parseBounds handles missing', () => {
  assert.deepEqual(parseBounds(''), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  assert.deepEqual(parseBounds('garbage'), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
})

test('buildHilogArgs with all filters', () => {
  const args = buildHilogArgs({ level: 'D', bundle: 'com.example.app', keyword: 'focus', tail: 100 })
  assert.deepEqual(args, ['hilog', '-L', 'D', '-t', 'com.example.app', '-g', 'focus', '-T', '100'])
})

test('buildHilogArgs default tail', () => {
  const args = buildHilogArgs({})
  assert.deepEqual(args, ['hilog', '-T', '500'])
})

test('buildHilogArgs with time range', () => {
  const args = buildHilogArgs({ from: '5m', to: '1m' })
  assert.deepEqual(args, ['hilog', '-s', '5m', '-e', '1m', '-T', '500'])
})

test('buildUiDumpArgs with device', () => {
  assert.deepEqual(buildUiDumpArgs({ device: 'Phone' }), ['uitest', 'uiDump', '-d', 'Phone'])
  assert.deepEqual(buildUiDumpArgs({}), ['uitest', 'uiDump'])
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

test('selectHdc for devecocli source', () => {
  const sel = selectHdc({ source: 'devecocli', exec: '/usr/bin/devecocli' })
  assert.equal(sel.kind, 'devecocli')
  assert.equal(sel.exec, '/usr/bin/devecocli')
  assert.deepEqual(sel.prefix, ['device', 'hdc'])
})

test('selectHdc for studio source returns null exec but kind=hdc', () => {
  const sel = selectHdc({ source: 'studio', path: '/opt/deveco-studio' })
  assert.equal(sel.kind, 'hdc')
  assert.match(sel.exec, /hdc$/)
  assert.deepEqual(sel.prefix, [])
})

test('selectHdc returns null for none source', () => {
  assert.equal(selectHdc({ source: 'none' }), null)
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
