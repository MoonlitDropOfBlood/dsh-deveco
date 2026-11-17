/**
 * dsh-deveco — git information for the `.ets` sidebar viewer.
 *
 * Zero-dependency helper module: every algorithm is a pure function, and the
 * only side effect (spawning `git`) lives behind an injectable executor so the
 * parsers can be unit-tested with a fake runner and the orchestrators can be
 * integration-tested against the real `git` binary.
 *
 * Design notes (read before changing):
 *   - `git` is spawned with an argv array, never a shell string. Pathspecs are
 *     passed after `--` and the global `--literal-pathspecs` option is placed
 *     BEFORE the subcommand, so a file name containing glob magic or a dash
 *     cannot turn into an option or a pattern.
 *   - The environment pins `GIT_OPTIONAL_LOCKS=0` (read-only commands must not
 *     take the index lock) and `LC_ALL=C` (stable, parseable output).
 *   - Nothing here throws at the caller: every git failure degrades to
 *     `available: false` (with a reason) or to an empty change list, so the
 *     code viewer keeps working when git is missing or the folder is not a
 *     repository.
 */

import { spawn } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Environment overrides applied to every git invocation. */
export const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

/** Default wall-clock budget for one git invocation. */
export const GIT_TIMEOUT_MS = 10000

/** Default cap on captured stdout (8 MiB) — a huge diff must not blow up memory. */
export const GIT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Run one git command.
 *
 * @param {object} options
 * @param {string} options.cwd working directory for the child process
 * @param {string[]} options.args argv array (already includes any global options)
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {string} [options.binary] executable name (default `git`)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, error?: {code: string, message: string}}>}
 */
export function runGitCommand ({ cwd, args, timeoutMs = GIT_TIMEOUT_MS, maxBytes = GIT_MAX_BYTES, binary = 'git' }) {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child = null
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(result)
    }

    const killChild = () => {
      try {
        if (child && child.exitCode === null && !child.killed) child.kill()
      } catch (_) {
        /* the process is already gone — nothing to do */
      }
    }

    try {
      child = spawn(binary, Array.isArray(args) ? args : [], {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        windowsHide: true,
      })
    } catch (e) {
      finish({
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        error: { code: 'enoent', message: (e && e.message) ? e.message : String(e) },
      })
      return
    }

    timer = setTimeout(() => {
      killChild()
      finish({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: { code: 'timeout', message: `git timed out after ${timeoutMs}ms` },
      })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk
      if (stdout.length > maxBytes) {
        killChild()
        finish({
          ok: false,
          stdout: stdout.slice(0, maxBytes),
          stderr,
          code: null,
          error: { code: 'output-limit', message: `git output exceeded ${maxBytes} bytes` },
        })
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk
    })
    child.on('error', (e) => {
      const code = (e && e.code === 'ENOENT') ? 'enoent' : 'spawn-failed'
      finish({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: { code, message: (e && e.message) ? e.message : String(e) },
      })
    })
    child.on('close', (code) => {
      const ok = code === 0
      const result = { ok, stdout, stderr, code: code === null ? null : code }
      if (!ok) {
        const message = stderr.trim() || stdout.trim() || `git exited with code ${code}`
        result.error = { code: 'exit', message }
      }
      finish(result)
    })
  })
}

// ---- command builders (pure) ----------------------------------------------

export function buildGitRepoRootArgs () {
  return ['rev-parse', '--show-toplevel']
}

export function buildGitBranchArgs () {
  return ['branch', '--show-current']
}

export function buildGitVerifyHeadArgs () {
  return ['rev-parse', '--verify', 'HEAD']
}

export function buildGitStatusArgs (relPath) {
  return ['--literal-pathspecs', 'status', '--porcelain=v1', '--', relPath]
}

export function buildGitDiffArgs (relPath) {
  return ['--literal-pathspecs', 'diff', 'HEAD', '--no-color', '--unified=3', '--', relPath]
}

export function buildGitBlameArgs (relPath, line) {
  return ['--literal-pathspecs', 'blame', '--porcelain', '-L', `${line},${line}`, '--', relPath]
}

// ---- status parsing --------------------------------------------------------

const CONFLICT_XY = new Set(['AA', 'UU', 'DD', 'AU', 'UA', 'DU', 'UD'])

/**
 * Map `git status --porcelain=v1` output to one state token.
 *
 * Only the first record is considered — the caller passes a single-file
 * pathspec, so the first record IS the file we asked about.
 *
 * @param {string} output
 * @returns {'clean'|'modified'|'untracked'|'added'|'deleted'|'renamed'|'copied'|'conflict'}
 */
export function parseGitStatusPorcelain (output) {
  const text = typeof output === 'string' ? output : ''
  const line = text.split('\n').find((entry) => entry.trim() !== '')
  if (line === undefined) return 'clean'
  const xy = line.slice(0, 2)
  const x = xy.charAt(0)
  const y = xy.charAt(1)
  if (xy === '??') return 'untracked'
  if (CONFLICT_XY.has(xy)) return 'conflict'
  if (x === 'R') return 'renamed'
  if (x === 'C') return 'copied'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  if (xy.includes('M')) return 'modified'
  if (x === 'T' || y === 'T') return 'modified'
  return 'clean'
}

// ---- unified diff parsing --------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Classify the changed lines of one unified diff.
 *
 * Rules (VS Code style gutter):
 *   - `+` lines are additions, `-` lines are deletions, context lines are never
 *     marked.
 *   - A run of deletions immediately followed by a run of additions is a
 *     rewrite: the pairs are reported as `mod` on the NEW side line number.
 *   - A deletion without a matching addition is anchored to the line ABOVE the
 *     gap (the last new-side line seen in the hunk; the hunk's first new line
 *     minus one when the deletion opens the hunk, floored at line 1).
 *   - An anchor never overwrites a line already claimed by an add/mod entry.
 *
 * @param {string} diffText
 * @returns {{changes: Array<{line: number, kind: 'add'|'mod'|'del'}>, added: number, modified: number, deleted: number}}
 */
export function parseUnifiedDiffLineKinds (diffText) {
  const text = typeof diffText === 'string' ? diffText : ''
  const lines = text.split('\n')
  /** @type {Map<number, 'add'|'mod'|'del'>} */
  const byLine = new Map()

  const claim = (line, kind) => {
    const existing = byLine.get(line)
    if (existing === undefined) {
      byLine.set(line, kind)
      return
    }
    // A delete anchor never wins over an add/mod claim on the same line.
    if (existing === 'del' && kind !== 'del') byLine.set(line, kind)
  }

  let index = 0
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index])
    if (!header) {
      index += 1
      continue
    }
    const oldCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10)
    const newCount = header[4] === undefined ? 1 : Number.parseInt(header[4], 10)
    const newStart = Number.parseInt(header[3], 10)
    index += 1

    // Collect the hunk body. The header tells us exactly how many old/new
    // lines belong to the hunk, so we stop there instead of guessing from
    // the text — `--- a/file` / `+++ b/file` headers can never leak in.
    const tokens = []
    let oldSeen = 0
    let newSeen = 0
    while (index < lines.length && (oldSeen < oldCount || newSeen < newCount)) {
      const line = lines[index]
      index += 1
      if (line === '') break
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      if (line.startsWith(' ')) {
        oldSeen += 1
        newSeen += 1
        tokens.push({ type: 'ctx' })
      } else if (line.startsWith('-')) {
        oldSeen += 1
        tokens.push({ type: 'del' })
      } else if (line.startsWith('+')) {
        newSeen += 1
        tokens.push({ type: 'add' })
      } else {
        break // not a diff body line — the hunk is malformed, stop here
      }
    }

    applyHunk(tokens, newStart, claim)
  }

  const changes = [...byLine.entries()]
    .map(([line, kind]) => ({ line, kind }))
    .sort((a, b) => a.line - b.line)
  return {
    changes,
    added: changes.filter((entry) => entry.kind === 'add').length,
    modified: changes.filter((entry) => entry.kind === 'mod').length,
    deleted: changes.filter((entry) => entry.kind === 'del').length,
  }
}

/**
 * Map one hunk body onto new-side line numbers.
 *
 * @param {Array<{type: 'ctx'|'del'|'add'}>} tokens
 * @param {number} newStart
 * @param {(line: number, kind: 'add'|'mod'|'del') => void} claim
 */
function applyHunk (tokens, newStart, claim) {
  const runs = []
  for (const token of tokens) {
    const last = runs[runs.length - 1]
    if (last && last.type === token.type) last.count += 1
    else runs.push({ type: token.type, count: 1 })
  }

  let newLine = newStart
  // The last new-side line number we have seen. Before the hunk body starts
  // it is `newStart - 1`, so a deletion that opens the hunk anchors one line
  // above the gap instead of always landing on line 1.
  let lastNew = newStart - 1

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex]
    if (run.type === 'ctx') {
      // The last context line of the run owns the highest new-side number.
      lastNew = newLine + run.count - 1
      newLine += run.count
      continue
    }
    if (run.type === 'add') {
      for (let i = 0; i < run.count; i += 1) {
        claim(newLine, 'add')
        lastNew = newLine
        newLine += 1
      }
      continue
    }
    // Deletion run.
    const next = runs[runIndex + 1]
    if (next && next.type === 'add') {
      const paired = Math.min(run.count, next.count)
      // The deletions that have no counterpart sit above the gap — anchor them
      // BEFORE the additions move `lastNew` forward.
      if (run.count > paired) {
        const anchor = Math.max(1, lastNew)
        claim(anchor, 'del')
      }
      for (let i = 0; i < next.count; i += 1) {
        claim(newLine, i < paired ? 'mod' : 'add')
        lastNew = newLine
        newLine += 1
      }
      runIndex += 1
      continue
    }
    const anchor = Math.max(1, lastNew)
    claim(anchor, 'del')
  }
}

// ---- blame parsing ---------------------------------------------------------

const BLAME_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/

/**
 * Parse `git blame --porcelain` output.
 *
 * The metadata of a commit is only emitted once by git, so it is remembered
 * per hash and reused for the remaining lines of the same commit.
 *
 * @param {string} output
 * @returns {Array<{line: number, hash: string, author: string, date: string, summary: string}>}
 */
export function parseBlamePorcelain (output) {
  const text = typeof output === 'string' ? output : ''
  const lines = text.split('\n')
  /** @type {Map<string, {author: string, date: string, summary: string}>} */
  const metaByHash = new Map()
  const entries = []

  let hash = ''
  let line = 0
  let author = ''
  let authorTime = ''
  let authorTz = ''
  let summary = ''
  let hasHeader = false

  const flush = () => {
    if (!hasHeader) return
    let meta = metaByHash.get(hash)
    if (!meta) {
      meta = {
        author,
        date: authorTime ? isoWithOffset(authorTime, authorTz) : '',
        summary,
      }
      metaByHash.set(hash, meta)
    }
    entries.push({ line, hash, author: meta.author, date: meta.date, summary: meta.summary })
  }

  for (const raw of lines) {
    if (raw === '') continue
    if (raw.startsWith('\t')) {
      flush()
      hasHeader = false
      author = ''
      authorTime = ''
      authorTz = ''
      summary = ''
      continue
    }
    const header = BLAME_HEADER.exec(raw)
    if (header) {
      flush()
      hash = header[1]
      line = Number.parseInt(header[3], 10)
      hasHeader = true
      continue
    }
    if (!hasHeader) continue // stray metadata without a header — ignore
    if (raw.startsWith('author ')) {
      author = raw.slice('author '.length)
    } else if (raw.startsWith('author-time ')) {
      authorTime = raw.slice('author-time '.length).trim()
    } else if (raw.startsWith('author-tz ')) {
      authorTz = raw.slice('author-tz '.length).trim()
    } else if (raw.startsWith('summary ')) {
      summary = raw.slice('summary '.length)
    }
  }
  flush()

  return entries
}

/**
 * Format an epoch second as ISO 8601 with the author's UTC offset.
 *
 * @param {number|string} seconds epoch seconds
 * @param {string} tz `±HHMM` (git's `author-tz` format); invalid → UTC
 */
export function isoWithOffset (seconds, tz) {
  const epoch = Number(seconds)
  if (!Number.isFinite(epoch)) return ''
  const text = String(tz || '').trim()
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text)
  if (!match) {
    return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number.parseInt(match[2], 10)
  const minutes = Number.parseInt(match[3], 10)
  const offsetMinutes = sign * (hours * 60 + minutes)
  const shifted = new Date((epoch + offsetMinutes * 60) * 1000)
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  const yyyy = shifted.getUTCFullYear()
  const MM = pad(shifted.getUTCMonth() + 1)
  const dd = pad(shifted.getUTCDate())
  const HH = pad(shifted.getUTCHours())
  const mm = pad(shifted.getUTCMinutes())
  const ss = pad(shifted.getUTCSeconds())
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}${match[1]}${match[2]}:${match[3]}`
}

/**
 * Convert an absolute file path into a repository-relative POSIX path.
 *
 * @returns {string|null} null when the file lives outside the repository
 */
export function toGitRelPath (repoRoot, absPath) {
  if (!repoRoot || !absPath) return null
  const rel = relative(resolve(repoRoot), resolve(absPath))
  if (!rel) return null
  const normalized = rel.split(sep).join('/')
  if (!normalized || normalized.startsWith('..')) return null
  if (isAbsolute(normalized)) return null
  return normalized
}

/**
 * Prepare the content that is written back to a file.
 *
 * Two properties of the original file are preserved:
 *   - **EOL style** — a CRLF file stays CRLF, an LF file stays LF. The client
 *     always sends LF-normalized text, so the conversion happens here.
 *   - **BOM** — a UTF-8 BOM stays a UTF-8 BOM (and is never doubled).
 *
 * @param {string} originalRawUtf8 the original file content, decoded as UTF-8
 * @param {string} content the new content (LF-normalized by the client)
 * @returns {string} the exact text to write
 */
export function prepareSaveContent (originalRawUtf8, content) {
  const original = typeof originalRawUtf8 === 'string' ? originalRawUtf8 : ''
  let text = typeof content === 'string' ? content : ''

  // The client sends LF; a stray CR (or CRLF) in the payload is normalized
  // first so the conversion below cannot double a carriage return.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  if (original.includes('\r\n')) text = text.replace(/\n/g, '\r\n')

  const originalHasBom = original.charCodeAt(0) === 0xFEFF
  const contentHasBom = text.charCodeAt(0) === 0xFEFF
  if (originalHasBom && !contentHasBom) text = `\uFEFF${text}`

  return text
}

// ---- orchestrators ---------------------------------------------------------

function unavailable (reason, message) {
  const value = { available: false, reason }
  if (message) value.message = String(message)
  return value
}

function gitFailureReason (result) {
  if (result && result.error && result.error.code === 'enoent') return 'no-git'
  return 'git-failed'
}

/**
 * `git rev-parse` failed: a clean non-zero exit means "not a repository",
 * anything else (timeout, spawn failure) is an unexpected git failure.
 */
function repoRootFailureReason (result) {
  if (result && result.error) {
    if (result.error.code === 'enoent') return 'no-git'
    if (result.error.code !== 'exit') return 'git-failed'
  }
  return 'no-repo'
}

/**
 * Collect the git information of one file.
 *
 * @param {Function} runGit injectable executor: `({cwd, args}) => Promise<result>`
 * @param {string} absPath absolute host path of the file
 * @returns {Promise<object>} the `fileGitInfo` value shape
 */
export async function collectFileGitInfo (runGit, absPath) {
  const cwd = dirname(absPath)

  const rootResult = await runGit({ cwd, args: buildGitRepoRootArgs() })
  if (!rootResult || !rootResult.ok) {
    const reason = repoRootFailureReason(rootResult)
    const message = (rootResult && rootResult.stderr) ? rootResult.stderr.trim()
      : ((rootResult && rootResult.error) ? rootResult.error.message : '')
    return unavailable(reason, message)
  }
  const repoRoot = String(rootResult.stdout || '').trim()
  if (!repoRoot) return unavailable('no-repo')
  const relPath = toGitRelPath(repoRoot, absPath)
  if (!relPath) return unavailable('no-repo', 'file is outside the repository')

  const statusResult = await runGit({ cwd: repoRoot, args: buildGitStatusArgs(relPath) })
  const state = (statusResult && statusResult.ok)
    ? parseGitStatusPorcelain(statusResult.stdout)
    : 'clean'

  const branchResult = await runGit({ cwd: repoRoot, args: buildGitBranchArgs() })
  const branch = (branchResult && branchResult.ok) ? String(branchResult.stdout || '').trim() : ''

  const headResult = await runGit({ cwd: repoRoot, args: buildGitVerifyHeadArgs() })
  const unborn = !(headResult && headResult.ok)

  const value = {
    available: true,
    repoRoot,
    branch: branch || 'HEAD',
    state,
    changes: [],
    added: 0,
    modified: 0,
    deleted: 0,
  }

  if (state === 'untracked' || state === 'deleted' || state === 'clean') return value

  const diffResult = await runGit({ cwd: repoRoot, args: buildGitDiffArgs(relPath) })
  if (!diffResult || !diffResult.ok) {
    // A repository without any commit has no HEAD to diff against; a file
    // that was staged as new then covers every line.
    if (state === 'added' && unborn) {
      value.allAdded = true
      return value
    }
    return value
  }

  const parsed = parseUnifiedDiffLineKinds(diffResult.stdout)
  value.changes = parsed.changes
  value.added = parsed.added
  value.modified = parsed.modified
  value.deleted = parsed.deleted
  return value
}

/**
 * Blame one line of one file.
 *
 * @param {Function} runGit injectable executor
 * @param {string} absPath absolute host path of the file
 * @param {number} line 1-based line number
 * @returns {Promise<object>} the `fileGitBlame` value shape
 */
export async function blameFileLine (runGit, absPath, line) {
  const cwd = dirname(absPath)

  const rootResult = await runGit({ cwd, args: buildGitRepoRootArgs() })
  if (!rootResult || !rootResult.ok) {
    const reason = repoRootFailureReason(rootResult)
    const message = (rootResult && rootResult.stderr) ? rootResult.stderr.trim()
      : ((rootResult && rootResult.error) ? rootResult.error.message : '')
    return unavailable(reason, message)
  }
  const repoRoot = String(rootResult.stdout || '').trim()
  if (!repoRoot) return unavailable('no-repo')
  const relPath = toGitRelPath(repoRoot, absPath)
  if (!relPath) return unavailable('no-repo', 'file is outside the repository')

  const blameResult = await runGit({ cwd: repoRoot, args: buildGitBlameArgs(relPath, line) })
  if (!blameResult || !blameResult.ok) {
    const reason = gitFailureReason(blameResult)
    if (reason === 'no-git') {
      return unavailable(reason, (blameResult && blameResult.error) ? blameResult.error.message : '')
    }
    return unavailable('git-failed', (blameResult && blameResult.stderr) ? blameResult.stderr.trim() : '')
  }

  const entries = parseBlamePorcelain(blameResult.stdout)
  const entry = entries.find((item) => item.line === line)
  if (!entry) return unavailable('no-answer')
  return { available: true, entry }
}
