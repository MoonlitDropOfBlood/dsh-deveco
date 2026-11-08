/**
 * dsh-deveco — Hvigor ArkTS Source Map index.
 *
 * Hvigor stores a dictionary keyed by the exact ArkVM scriptParsed.url in
 * `sourceMaps.json` / `sourceMaps.map`. This module implements the Source Map
 * v3 VLQ decoding needed for both directions:
 *   .ets source line → generated .ts breakpoint location
 *   generated debugger frame → original .ets source location
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { inspectHarmonyProject } from './harmony-project.mjs'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = new Map([...BASE64].map((char, index) => [char, index]))
const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024

function normalizePath (path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function samePath (a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function projectSourcePath (projectRoot, sourcePath) {
  const absolute = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(projectRoot, sourcePath)
  return normalizePath(relative(projectRoot, absolute))
}

/** Decode one Base64-VLQ segment starting at `start`. */
export function decodeVlqSegment (text, start = 0) {
  const values = []
  let position = start
  while (position < text.length) {
    let result = 0
    let shift = 0
    let continuation = true
    while (continuation) {
      if (position >= text.length) throw new Error('truncated Source Map VLQ value')
      const digit = BASE64_VALUES.get(text[position++])
      if (digit === undefined) throw new Error(`invalid Source Map Base64 character: ${text[position - 1]}`)
      continuation = (digit & 32) !== 0
      result += (digit & 31) * (2 ** shift)
      shift += 5
      if (shift > 55) throw new Error('Source Map VLQ value is too large')
    }
    const negative = (result & 1) === 1
    result = Math.floor(result / 2)
    values.push(negative ? -result : result)
    if (text[position] === ',' || text[position] === ';' || position >= text.length) break
  }
  return { values, next: position }
}

/** Decode Source Map v3 mappings into generated-line-indexed segments. */
export function decodeSourceMapMappings (mappings) {
  const lines = []
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  let nameIndex = 0
  const generatedLines = String(mappings || '').split(';')
  for (let generatedLine = 0; generatedLine < generatedLines.length; generatedLine++) {
    const segments = []
    let generatedColumn = 0
    let position = 0
    const text = generatedLines[generatedLine]
    while (position < text.length) {
      if (text[position] === ',') { position++; continue }
      const decoded = decodeVlqSegment(text, position)
      position = decoded.next
      const values = decoded.values
      if (values.length === 0) continue
      generatedColumn += values[0]
      const segment = { generatedLine, generatedColumn, sourceIndex: -1, sourceLine: -1, sourceColumn: -1, nameIndex: -1 }
      if (values.length >= 4) {
        sourceIndex += values[1]
        sourceLine += values[2]
        sourceColumn += values[3]
        segment.sourceIndex = sourceIndex
        segment.sourceLine = sourceLine
        segment.sourceColumn = sourceColumn
        if (values.length >= 5) {
          nameIndex += values[4]
          segment.nameIndex = nameIndex
        }
      }
      segments.push(segment)
    }
    lines.push(segments)
  }
  return lines
}

function decodeMap (raw, url, file) {
  if (!raw || typeof raw !== 'object' || typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) {
    throw new Error(`Source Map 缺少 sources/mappings：${file.path}`)
  }
  return {
    url,
    mapPath: file.path,
    mtimeMs: file.mtimeMs,
    sourceRoot: typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '',
    sources: raw.sources.map((source) => String(source)),
    names: Array.isArray(raw.names) ? raw.names : [],
    lines: decodeSourceMapMappings(raw.mappings),
  }
}

function mapSourceAbsolute (projectRoot, map, sourceIndex) {
  const source = map.sources[sourceIndex]
  if (typeof source !== 'string') return ''
  return resolve(projectRoot, map.sourceRoot || '', source)
}

/** Greatest-lower-bound generated lookup, with empty generated lines skipped. */
export function originalPositionFor (map, generatedLine, generatedColumn = 0) {
  const line = Math.max(0, Number(generatedLine) || 0)
  const column = Math.max(0, Number(generatedColumn) || 0)
  for (let current = Math.min(line, map.lines.length - 1); current >= 0; current--) {
    const segments = map.lines[current] || []
    let candidate = null
    for (const segment of segments) {
      if (segment.sourceIndex < 0) continue
      if (current === line && segment.generatedColumn > column) break
      candidate = segment
    }
    if (candidate) return candidate
    // A populated requested line whose first mapping starts after the requested
    // column must not borrow a previous statement's location.
    if (current === line && segments.length > 0) return null
  }
  return null
}

/** Find the first generated statement for an original line, or the next mapped line. */
export function generatedPositionFor (map, projectRoot, sourcePath, sourceLine, sourceColumn = 0) {
  const requestedLine = Math.max(0, Number(sourceLine) || 0)
  const requestedColumn = Math.max(0, Number(sourceColumn) || 0)
  const absolute = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(projectRoot, sourcePath)
  const candidates = []
  for (const line of map.lines) {
    for (const segment of line) {
      if (segment.sourceIndex < 0 || !samePath(mapSourceAbsolute(projectRoot, map, segment.sourceIndex), absolute)) continue
      if (segment.sourceLine >= requestedLine) candidates.push(segment)
    }
  }
  if (candidates.length === 0) return null
  const exact = candidates.filter((segment) => segment.sourceLine === requestedLine)
  const pool = exact.length > 0 ? exact : candidates
  const firstOriginalLine = Math.min(...pool.map((segment) => segment.sourceLine))
  const sameOriginalLine = pool.filter((segment) => segment.sourceLine === firstOriginalLine)
  sameOriginalLine.sort((a, b) => {
    if (exact.length > 0 && requestedColumn > 0) {
      const columnDelta = Math.abs(a.sourceColumn - requestedColumn) - Math.abs(b.sourceColumn - requestedColumn)
      if (columnDelta) return columnDelta
    }
    return a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn
  })
  return sameOriginalLine[0]
}

function mapPriority (file, buildMode) {
  if (file.buildMode && file.buildMode !== buildMode) return -1
  if (file.kind === 'cache' && file.buildMode === buildMode) return 0
  if (file.kind === 'intermediate') return 1
  if (file.kind === 'output') return 2
  return 3
}

/** Lazily decoded collection of all script maps selected for one build mode. */
export class HarmonySourceMapIndex {
  constructor ({ project, buildMode, records, warnings, maps = new Map() }) {
    this.project = project
    this.projectRoot = project.root
    this.buildMode = buildMode
    this.records = records
    this.warnings = warnings
    this.rawMaps = maps
    this.decodedMaps = new Map()
  }

  get scriptCount () { return this.rawMaps.size }

  mapForUrl (url) {
    if (this.decodedMaps.has(url)) return this.decodedMaps.get(url)
    const entry = this.rawMaps.get(url)
    if (!entry) return null
    try {
      const decoded = decodeMap(entry.raw, url, entry.file)
      this.decodedMaps.set(url, decoded)
      return decoded
    } catch (error) {
      this.decodedMaps.set(url, null)
      const message = error && error.message ? error.message : String(error)
      if (!this.warnings.includes(message)) this.warnings.push(message)
      return null
    }
  }

  resolveSourceBreakpoint ({ sourcePath, sourceLine, sourceColumn = 0, loadedScripts = null }) {
    const loaded = loadedScripts instanceof Set ? loadedScripts : null
    const matches = []
    for (const url of this.rawMaps.keys()) {
      const map = this.mapForUrl(url)
      if (!map) continue
      const generated = generatedPositionFor(map, this.projectRoot, sourcePath, sourceLine, sourceColumn)
      if (!generated) continue
      const source = normalizePath(projectSourcePath(this.projectRoot, mapSourceAbsolute(this.projectRoot, map, generated.sourceIndex)))
      matches.push({
        url,
        line: generated.generatedLine,
        column: generated.generatedColumn,
        sourcePath: source,
        sourceLine: generated.sourceLine + 1,
        sourceColumn: generated.sourceColumn + 1,
        mapPath: map.mapPath,
        mapMtimeMs: map.mtimeMs,
        scriptLoaded: loaded ? loaded.has(url) : true,
      })
    }
    if (matches.length === 0) return null
    const loadedMatches = matches.filter((match) => match.scriptLoaded)
    const candidates = loadedMatches.length > 0 ? loadedMatches : matches
    const uniqueUrls = [...new Set(candidates.map((match) => match.url))]
    if (uniqueUrls.length > 1) {
      const error = new Error(`源码对应多个 ArkVM 脚本，无法唯一定位：${uniqueUrls.join('；')}。请先构建/启动最新工程，或用 url 参数指定编译脚本。`)
      error.candidates = candidates
      throw error
    }
    return candidates[0]
  }

  mapFrame (frame) {
    if (!frame || typeof frame !== 'object') return frame
    const map = this.mapForUrl(frame.url)
    if (!map) return frame
    const original = originalPositionFor(map, frame.lineNumber, frame.columnNumber)
    if (!original) return frame
    const absolute = mapSourceAbsolute(this.projectRoot, map, original.sourceIndex)
    if (!absolute) return frame
    return {
      ...frame,
      sourcePath: projectSourcePath(this.projectRoot, absolute),
      sourceLine: original.sourceLine + 1,
      sourceColumn: original.sourceColumn + 1,
    }
  }

  mapFrames (frames) {
    return Array.isArray(frames) ? frames.map((frame) => this.mapFrame(frame)) : []
  }
}

/** Load all applicable Hvigor maps for a project and debug/release build. */
export async function loadHarmonySourceMapIndex (projectOrPath, options = {}) {
  const project = typeof projectOrPath === 'string' || !projectOrPath
    ? await inspectHarmonyProject(projectOrPath || process.cwd())
    : projectOrPath
  const buildMode = options.buildMode === 'release' ? 'release' : 'debug'
  const selected = new Map()
  const files = []
  const warnings = [...(project.warnings || [])]
  for (const module of project.modules || []) {
    const candidates = (module.sourceMaps || [])
      .map((file) => ({ file, priority: mapPriority(file, buildMode) }))
      .filter((entry) => entry.priority >= 0)
      .sort((a, b) => a.priority - b.priority || b.file.mtimeMs - a.file.mtimeMs)
    // A mode-specific CompileArkTS cache is authoritative and complete for
    // that build; avoid re-reading duplicate intermediate/output copies.
    const effective = candidates.some((entry) => entry.priority === 0)
      ? candidates.filter((entry) => entry.priority === 0)
      : candidates
    for (const { file, priority } of effective) {
      if (file.size > MAX_SOURCE_MAP_BYTES) {
        warnings.push(`Source Map 超过 32 MiB，已跳过：${file.path}`)
        continue
      }
      let parsed
      try { parsed = JSON.parse(await readFile(file.path, 'utf8')) } catch (error) {
        warnings.push(`Source Map 读取失败：${file.path}（${error.message}）`)
        continue
      }
      files.push(file)
      const entries = parsed && typeof parsed === 'object' && typeof parsed.mappings === 'string'
        ? [[typeof parsed.file === 'string' && parsed.file ? parsed.file : file.path, parsed]]
        : Object.entries(parsed || {})
      for (const [url, raw] of entries) {
        const previous = selected.get(url)
        if (!previous || priority < previous.priority || (priority === previous.priority && file.mtimeMs > previous.file.mtimeMs)) {
          selected.set(url, { raw, file, priority })
        }
      }
    }
  }
  if (files.some((file) => !file.buildMode)) {
    warnings.push('部分 Source Map 来自中间产物，目录本身不区分 debug/release；若映射异常，请重新执行对应模式的 build/run。')
  }
  return new HarmonySourceMapIndex({ project, buildMode, records: files, warnings, maps: selected })
}

/** Refuse to place a source breakpoint using a map older than the edited source. */
export async function assertSourceBreakpointFresh (resolution, sourcePath, projectRoot) {
  const absolute = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(projectRoot, sourcePath)
  const info = await stat(absolute)
  if (info.mtimeMs > resolution.mapMtimeMs + 1) {
    throw new Error(`源文件 ${resolution.sourcePath} 比 Source Map 更新（可能尚未重新构建）。请先执行 devecocli build/run，再设置源码断点；不要用旧映射猜新行号。`)
  }
}
