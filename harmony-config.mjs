// dsh-deveco 配置持久化 + Studio/CLT 互斥规则 + 自发现调度。
// 零依赖、纯 Node ESM。允许的依赖仅：node:fs/promises, node:path。

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { scanStudioCandidates, scanCltCandidates } from './harmony-studio.mjs'

const CONFIG_FILE = 'config.json'
const DISCOVERY_FILE = 'discovery.json'
const SCHEMA_VERSION = 1

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  studioPath: '',
  cltPath: '',
  updatedAt: 0,
})

function defaultPlatform() {
  const p = process.platform
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'
}

function normalizePlatform(p) {
  return p === 'win32' || p === 'darwin' || p === 'linux' ? p : defaultPlatform()
}

async function readJsonFile(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not an object')
    }
    return data
  } catch {
    return null
  }
}

function pickConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG }
  const out = { ...DEFAULT_CONFIG }
  if (typeof parsed.studioPath === 'string') out.studioPath = parsed.studioPath
  if (typeof parsed.cltPath === 'string') out.cltPath = parsed.cltPath
  if (typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)) {
    out.updatedAt = parsed.updatedAt
  }
  if (parsed.schemaVersion === SCHEMA_VERSION) out.schemaVersion = SCHEMA_VERSION
  return out
}

/**
 * 从 <dir>/config.json 读；缺失/损坏返回默认空配置。
 */
export async function loadConfig(dir) {
  const parsed = await readJsonFile(join(dir, CONFIG_FILE))
  if (!parsed) return { ...DEFAULT_CONFIG }
  return pickConfig(parsed)
}

/**
 * 合并 partial 并原子写入（tmp + rename），返回最新配置。
 * 未在 partial 中出现的字段保留旧值。
 */
export async function saveConfig(dir, partial = {}) {
  const current = await loadConfig(dir)
  const next = {
    schemaVersion: SCHEMA_VERSION,
    studioPath: typeof partial.studioPath === 'string' ? partial.studioPath : current.studioPath,
    cltPath: typeof partial.cltPath === 'string' ? partial.cltPath : current.cltPath,
    updatedAt: Date.now(),
  }
  await atomicWriteJson(join(dir, CONFIG_FILE), next)
  return next
}

/**
 * 设置 Studio 路径并清空 cltPath（互斥规则）。
 */
export async function setStudioPath(dir, path) {
  return saveConfig(dir, { studioPath: String(path ?? ''), cltPath: '' })
}

/**
 * 设置 CLT 路径并清空 studioPath（互斥规则）。
 * 即使 CLT 版本低于 26.0.0，互斥也优先于版本校验——让用户明确选择。
 */
export async function setCltPath(dir, path) {
  return saveConfig(dir, { studioPath: '', cltPath: String(path ?? '') })
}

/**
 * 跑一次自发现并把结果写入 <dir>/discovery.json，返回结果对象。
 *
 * 若 discovery.json 已存在且 schemaVersion 匹配，保留旧 scannedAt，
 * 让"两次连写"产生字节相同的文件（is idempotent）。
 */
// Normalize the raw scan output from harmony-studio into the discovery schema
// (studios: Array<{path, kind: 'studio'}>, clts: Array<{path, version, kind: 'clt'}>).
// harmony-studio.scanStudioCandidates may return either string[] or
// {path, kind?}[] depending on caller; scanCltCandidates returns
// Array<{path, version: number[] | string}>.
function normalizeStudios(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string' && item) {
      out.push({ path: item, kind: 'studio' })
    } else if (item && typeof item === 'object' && typeof item.path === 'string') {
      out.push({ path: item.path, kind: 'studio' })
    }
  }
  return out
}

function normalizeClts(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') continue
    let v = item.version
    if (Array.isArray(v)) v = v.join('.')
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) continue
    out.push({ path: item.path, version: v, kind: 'clt' })
  }
  out.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0))
  return out
}

export async function discoverAll(dir, platform) {
  const pf = normalizePlatform(platform)
  const [studiosRaw, cltsRaw] = await Promise.all([
    Promise.resolve(scanStudioCandidates(pf)).catch(() => []),
    Promise.resolve(scanCltCandidates(pf)).catch(() => []),
  ])
  const file = join(dir, DISCOVERY_FILE)
  const existing = await readJsonFile(file)
  const scannedAt =
    existing && existing.schemaVersion === SCHEMA_VERSION && Number.isFinite(existing.scannedAt)
      ? existing.scannedAt
      : Date.now()
  const result = {
    schemaVersion: SCHEMA_VERSION,
    platform: pf,
    scannedAt,
    studios: normalizeStudios(studiosRaw),
    clts: normalizeClts(cltsRaw),
  }
  await atomicWriteJson(file, result)
  return result
}

/**
 * 入口：若 discovery.json 不存在或 schema 不匹配，触发 discoverAll；
 * 否则返回已缓存的结果。
 */
export async function ensureDiscovery(dir, platform) {
  const file = join(dir, DISCOVERY_FILE)
  const parsed = await readJsonFile(file)
  if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
    const platformVal =
      parsed.platform === 'win32' || parsed.platform === 'darwin' || parsed.platform === 'linux'
        ? parsed.platform
        : normalizePlatform(platform)
    return {
      schemaVersion: SCHEMA_VERSION,
      platform: platformVal,
      scannedAt:
        typeof parsed.scannedAt === 'number' && Number.isFinite(parsed.scannedAt)
          ? parsed.scannedAt
          : 0,
      // Re-normalize to drop old or malformed entries; the file is the
      // authoritative source but we still sanitize its shape on read.
      studios: normalizeStudios(parsed.studios),
      clts: normalizeClts(parsed.clts),
    }
  }
  return discoverAll(dir, platform)
}

async function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const json = JSON.stringify(data, null, 2)
  await writeFile(tmp, json, 'utf8')
  try {
    await rename(tmp, file)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {}
    throw err
  }
}