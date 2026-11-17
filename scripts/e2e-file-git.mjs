// dsh-deveco — `.ets` 查看器 git/编辑能力端到端探针（**不依赖 DSH，不依赖设备**）。
//
//   node scripts/e2e-file-git.mjs
//
// 目的：把「打开 .ets → 看 git 变更行 → 悬停 blame → 保存编辑 → git 状态变化」
// 这条链路在真实 git 仓库上跑通一遍：真的 HarmonyDevEcoService、真的 git 二进制、
// 真的临时仓库（不是假执行器）。
//
// 覆盖：
//   1. fileGitInfo：工作区改写后 state=modified、changes 非空、branch 非空
//   2. fileGitBlame：author/summary 非空、date 带时区偏移
//   3. writeTextFile：保存成功、读回内容一致、CRLF 文件的 EOL 被保留
//   4. 保存后再 fileGitInfo：kinds 随保存变化；把内容改回基线 → state=clean
//   5. 未跟踪文件：fileGitInfo state=untracked、fileGitBlame available=false
//
// 退出码 0 = 全部通过。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 配置目录必须落在临时目录里——探针绝不能污染 ~/.dsh。
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-deveco-e2e-home-'))
process.env.DSH_HOME = SANDBOX_HOME

const { HarmonyDevEcoService } = await import('../index.js')
const { runGitCommand } = await import('../harmony-git.mjs')

const results = []
function check (name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function step (title) {
  console.log(`\n== ${title}`)
}

/** Minimal Cordis-ish context: the service only needs reflect.provide here. */
function mockContext () {
  return {
    inject: () => () => {},
    get: () => undefined,
    effect: () => {},
    on: () => () => {},
    reflect: { provide: () => {} },
  }
}

const git = (cwd, args) => runGitCommand({ cwd, args })

async function main () {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-deveco-e2e-repo-'))
  try {
    // ---- 0. 真 git 仓库 + 基线提交 ----
    const init = await git(repo, ['init', '-q'])
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
    await git(repo, ['config', 'user.name', 'E2E User'])
    await git(repo, ['config', 'user.email', 'e2e@example.com'])
    await git(repo, ['config', 'core.autocrlf', 'false'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])

    const baseline = ['@Entry', '@Component', 'struct Index {', '  build() {', '  }', '}', ''].join('\n')
    const etsFile = join(repo, 'Index.ets')
    writeFileSync(etsFile, baseline, 'utf8')
    await git(repo, ['add', 'Index.ets'])
    const commit = await git(repo, ['commit', '-m', 'baseline commit'])
    if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)

    const service = new HarmonyDevEcoService(mockContext(), {})

    // ---- 1. 工作区改写 → fileGitInfo ----
    step('fileGitInfo after a working-tree edit')
    const edited = baseline.replace('struct Index {', 'struct Index {\n  // edited line')
    writeFileSync(etsFile, edited, 'utf8')
    const info = await service.fileGitInfo({ path: etsFile })
    check('fileGitInfo 成功', info.ok === true, info.error ? info.error.message : '')
    const value = info.value || {}
    check('git 可用', value.available === true, `reason=${value.reason}`)
    check('state=modified', value.state === 'modified', `state=${value.state}`)
    check('branch 非空', typeof value.branch === 'string' && value.branch.length > 0, `branch=${value.branch}`)
    check('repoRoot 非空', typeof value.repoRoot === 'string' && value.repoRoot.length > 0, `repoRoot=${value.repoRoot}`)
    check('changes 非空', Array.isArray(value.changes) && value.changes.length > 0, `changes=${JSON.stringify(value.changes)}`)
    check('changes 的 kind 合法', Array.isArray(value.changes) && value.changes.every((entry) => ['add', 'mod', 'del'].includes(entry.kind)), JSON.stringify(value.changes))

    // ---- 2. fileGitBlame ----
    step('fileGitBlame on a committed line')
    const blame = await service.fileGitBlame({ path: etsFile, line: 1 })
    check('fileGitBlame 成功', blame.ok === true, blame.error ? blame.error.message : '')
    const entry = (blame.value || {}).entry || {}
    check('blame 可用', (blame.value || {}).available === true, `reason=${(blame.value || {}).reason}`)
    check('author 非空', typeof entry.author === 'string' && entry.author.length > 0, `author=${entry.author}`)
    check('summary 非空', typeof entry.summary === 'string' && entry.summary.length > 0, `summary=${entry.summary}`)
    check('date 带时区偏移', typeof entry.date === 'string' && /[+-]\d{2}:\d{2}$/.test(entry.date), `date=${entry.date}`)

    // ---- 3. writeTextFile（LF 文件） ----
    step('writeTextFile on the LF file')
    const newContent = baseline.replace('struct Index {', 'struct Index {\n  // saved line')
    const saved = await service.writeTextFile({ path: etsFile, content: newContent })
    check('writeTextFile 成功', saved.ok === true, saved.error ? saved.error.message : '')
    check('saved=true', (saved.value || {}).saved === true, JSON.stringify(saved.value))
    check('path 是绝对路径', typeof (saved.value || {}).path === 'string' && saved.value.path.length > 0, String((saved.value || {}).path))
    check('bytes 是写入字节数', (saved.value || {}).bytes === Buffer.byteLength(newContent, 'utf8'), `bytes=${(saved.value || {}).bytes}`)
    check('磁盘内容与保存内容一致', readFileSync(etsFile, 'utf8') === newContent, JSON.stringify(readFileSync(etsFile, 'utf8')))

    // ---- 4. 保存后的 git 状态 → 改回基线 → clean ----
    step('fileGitInfo after saving, then back to the baseline')
    const afterSave = await service.fileGitInfo({ path: etsFile })
    check('保存后仍可用', (afterSave.value || {}).available === true, `reason=${(afterSave.value || {}).reason}`)
    check('保存后 changes 非空', Array.isArray((afterSave.value || {}).changes) && afterSave.value.changes.length > 0, JSON.stringify((afterSave.value || {}).changes))

    const restored = await service.writeTextFile({ path: etsFile, content: baseline })
    check('改回基线保存成功', restored.ok === true, restored.error ? restored.error.message : '')
    const clean = await service.fileGitInfo({ path: etsFile })
    check('改回基线后 state=clean', (clean.value || {}).state === 'clean', `state=${(clean.value || {}).state}`)
    check('clean 时 changes 为空', Array.isArray((clean.value || {}).changes) && clean.value.changes.length === 0, JSON.stringify((clean.value || {}).changes))

    // ---- 5. CRLF 文件：EOL 保留 ----
    step('writeTextFile keeps the CRLF line endings')
    const crlfFile = join(repo, 'Crlf.ets')
    writeFileSync(crlfFile, 'line1\r\nline2\r\n', 'utf8')
    const crlfSaved = await service.writeTextFile({ path: crlfFile, content: 'line1\nline2 edited\n' })
    check('CRLF 文件保存成功', crlfSaved.ok === true, crlfSaved.error ? crlfSaved.error.message : '')
    const crlfRaw = readFileSync(crlfFile, 'utf8')
    check('CRLF 被保留', crlfRaw === 'line1\r\nline2 edited\r\n', JSON.stringify(crlfRaw))
    check('没有裸 LF', !/[^\r]\n/.test(crlfRaw), JSON.stringify(crlfRaw))

    // ---- 6. 未跟踪文件 ----
    step('untracked file degrades gracefully')
    const untracked = join(repo, 'Untracked.ets')
    writeFileSync(untracked, 'fresh\n', 'utf8')
    const untrackedInfo = await service.fileGitInfo({ path: untracked })
    check('未跟踪文件 available=true', (untrackedInfo.value || {}).available === true, `reason=${(untrackedInfo.value || {}).reason}`)
    check('未跟踪文件 state=untracked', (untrackedInfo.value || {}).state === 'untracked', `state=${(untrackedInfo.value || {}).state}`)
    const untrackedBlame = await service.fileGitBlame({ path: untracked, line: 1 })
    check('未跟踪文件 blame 不可用', (untrackedBlame.value || {}).available === false, `available=${(untrackedBlame.value || {}).available}`)

    // ---- 7. 不存在的文件 → not-found ----
    step('writeTextFile refuses a file that does not exist')
    const missing = await service.writeTextFile({ path: join(repo, 'Missing.ets'), content: 'x' })
    check('不存在的文件 → not-found', missing.ok === false && missing.error.code === 'not-found', JSON.stringify(missing.error))
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(SANDBOX_HOME, { recursive: true, force: true })
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`✖ e2e-file-git crashed: ${error && error.message ? error.message : error}`)
  process.exit(1)
})
