/**
 * harmony-studio.mjs — HarmonyOS 工具链路径探测
 *
 * 零依赖、纯 Node ESM 模块。提供：
 *  - 版本解析与比较
 *  - 三平台默认安装路径（Studio + CLT 根）
 *  - 候选路径扫描
 *  - resolveCli 工具链解析
 *
 * 解析优先级：
 *  1. overrideExec           → source: 'devecocli'
 *  2. PATH / DSH_DEVECO_CLI  → source: 'devecocli'
 *  3. cltPath                → source: 'clt'  （必须 ≥ MIN_CLT_VERSION）
 *  4. studioPath             → source: 'studio'
 *  5. 都没配                 → source: 'none'
 *
 * 只允许使用 node 内置：node:fs, node:path。
 */

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// ────────────────────────────────────────────────────────────────────────────
// 1. 版本解析与比较
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把 "26.0.0" / "v5.0.3" / "26.0.1-beta1" / "26.0.0 (Build 1234)" 等字符串解析为 [major, minor, patch] 数组。
 * 解析失败返回 null。空、null、undefined、纯非数字一律返回 null。
 *
 * 实现要点：
 *  - 去前导 "v" / "V"
 *  - 提取形如 \d+(\.\d+)* 的最小前缀
 *  - 只取前三段 major.minor.patch，多余段忽略
 *  - 数字缺失或 <3 段 → null
 */
export function parseVersion(v) {
  if (v == null) return null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  const stripped = s.startsWith('v') || s.startsWith('V') ? s.slice(1) : s
  const m = stripped.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  const maj = m[1]
  const min = m[2]
  const pat = m[3]
  if (min == null || pat == null) return null
  return [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10)]
}

/**
 * 从 "Command Line Tools 26.0.1\nBuild 1234" / "26.0.0" / "Command Line Tools 26.0.1 (Build 1234)"
 * 这类 devecocli 风格输出里提取语义化版本字符串。
 * 解析失败返回 null。
 */
export function parseDevecoToolVersion(text) {
  if (text == null) return null
  if (typeof text !== 'string') return null
  // 必须能 parse 出一个完整的三段版本号
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}`
}

/**
 * 比较两个 [major, minor, patch] 数组。
 *  返回 -1 / 0 / 1。任一为 null 时一律返回 0（不比较，调用方负责 null 检查）。
 */
export function compareVersions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  for (let i = 0; i < 3; i++) {
    const x = a[i] | 0
    const y = b[i] | 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/**
 * 校验 version 字符串 ≥ min 数组。
 *  version 解析失败 → false；min 不是数组 → false（保守判定）。
 */
export function meetsMinVersion(version, min = MIN_CLT_VERSION) {
  const v = parseVersion(version)
  if (!v) return false
  if (!Array.isArray(min)) return false
  return compareVersions(v, min) >= 0
}

/**
 * DevEco 命令行工具最低要求版本：[26, 0, 0]
 */
export const MIN_CLT_VERSION = [26, 0, 0]

// ────────────────────────────────────────────────────────────────────────────
// 2. 三平台默认安装路径
// ────────────────────────────────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'

function envHome(...parts) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return null
  return join(home, ...parts)
}

function envLocalAppData(...parts) {
  const lad = process.env.LOCALAPPDATA || ''
  if (!lad) return null
  return join(lad, ...parts)
}

// Studio 默认安装路径（跨平台数组）
export const DEFAULT_WINDOWS_STUDIO = [
  'C:\\Program Files\\Huawei\\DevEco Studio',
  'C:\\Program Files (x86)\\Huawei\\DevEco Studio',
  'C:\\DevEco Studio',
]

export const DEFAULT_MACOS_STUDIO = [
  '/Applications/DevEco Studio.app/Contents',
  '/Applications/Huawei DevEco Studio.app/Contents',
  envHome('Applications', 'DevEco Studio.app', 'Contents'),
].filter(Boolean)

export const DEFAULT_LINUX_STUDIO = [
  '/opt/deveco-studio',
  '/opt/Huawei DevEco Studio',
  envHome('deveco-studio'),
].filter(Boolean)

// CLT 默认根路径
export const DEFAULT_WINDOWS_CLT_ROOTS = [
  'C:\\Program Files\\Huawei\\Command Line Tools',
  envLocalAppData('Huawei', 'Command Line Tools'),
].filter(Boolean)

export const DEFAULT_MACOS_CLT_ROOTS = [
  '/Applications/Command Line Tools.app/Contents',
  envHome('Library', 'Huawei', 'Command Line Tools'),
].filter(Boolean)

export const DEFAULT_LINUX_CLT_ROOTS = [
  '/opt/Huawei/Command Line Tools',
  envHome('Huawei', 'Command Line Tools'),
].filter(Boolean)

// ────────────────────────────────────────────────────────────────────────────
// 3. 辅助：路径规范化
// ────────────────────────────────────────────────────────────────────────────

/**
 * 去前后空白、去单/双引号；空字符串返回 ''。
 * 不解析环境变量、不解析 ~，仅做字面清洗（与 settings UI 用户粘贴的行为对齐）。
 */
export function normalizeStudioPath(p) {
  if (p == null) return ''
  let s = String(p).trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim()
    }
  }
  return s
}

// ────────────────────────────────────────────────────────────────────────────
// 4. findDevecoCli — PATH / DSH_DEVECO_CLI 环境变量探测
// ────────────────────────────────────────────────────────────────────────────

const EXEC_NAME_WIN = 'devecocli.cmd'
const EXEC_NAME_NIX = 'devecocli'

/**
 * 在 PATH 或 DSH_DEVECO_CLI 中查找 devecocli 可执行。
 * 找到返回绝对路径（未必校验可执行权限）；否则返回 null。
 */
export function findDevecoCli() {
  // 1. DSH_DEVECO_CLI 优先
  const envOverride = process.env.DSH_DEVECO_CLI
  if (envOverride && existsSync(envOverride)) return envOverride

  // 2. PATH 扫描
  const pathEnv = process.env.PATH || ''
  if (!pathEnv) return null
  const sepChar = IS_WIN ? ';' : ':'
  const execName = IS_WIN ? EXEC_NAME_WIN : EXEC_NAME_NIX
  for (const dir of pathEnv.split(sepChar)) {
    if (!dir) continue
    const candidate = join(dir, execName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 候选路径扫描
// ────────────────────────────────────────────────────────────────────────────

const VERSION_DIR_RE = /^\d+\.\d+\.\d+$/

/**
 * 扫描 Studio 候选路径：
 *  - 把 DEFAULT_<PLATFORM>_STUDIO 与调用方传入的额外路径合并
 *  - 每个路径用 statSync 验证存在；不存在静默跳过
 *  - 返回去重后的字符串数组（顺序按入参顺序）
 */
export function scanStudioCandidates(platform, extras = []) {
  let defaults
  switch (platform) {
    case 'windows':
    case 'win32':
    case 'win':
      defaults = DEFAULT_WINDOWS_STUDIO
      break
    case 'darwin':
    case 'macos':
    case 'mac':
      defaults = DEFAULT_MACOS_STUDIO
      break
    case 'linux':
      defaults = DEFAULT_LINUX_STUDIO
      break
    default:
      defaults = []
  }
  const all = [...defaults, ...extras]
  const seen = new Set()
  const out = []
  for (const p of all) {
    if (!p) continue
    if (seen.has(p)) continue
    seen.add(p)
    try {
      const st = statSync(p)
      if (st && st.isDirectory()) out.push(p)
    } catch {
      // 静默跳过不存在的路径
    }
  }
  return out
}

/**
 * 扫描 CLT 候选版本目录。
 *  - 不传 cltRoot 时，使用对应平台 DEFAULT_*_CLT_ROOTS
 *  - 对每个根目录 readdirSync，过滤出匹配 ^\d+\.\d+\.\d+$ 的子目录
 *  - 按 [major, minor, patch] 倒序（最新在前）
 *  - 根目录不存在/不可读 → 静默跳过
 *
 *  返回：[{ path, version: [maj, min, pat] }, ...]
 */
export function scanCltCandidates(platform, cltRoot) {
  let roots
  if (cltRoot) {
    roots = [cltRoot]
  } else {
    switch (platform) {
      case 'windows':
      case 'win32':
      case 'win':
        roots = DEFAULT_WINDOWS_CLT_ROOTS
        break
      case 'darwin':
      case 'macos':
      case 'mac':
        roots = DEFAULT_MACOS_CLT_ROOTS
        break
      case 'linux':
        roots = DEFAULT_LINUX_CLT_ROOTS
        break
      default:
        roots = []
    }
  }

  const cands = []
  for (const root of roots) {
    if (!root) continue
    let entries
    try {
      if (!existsSync(root)) continue
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!VERSION_DIR_RE.test(name)) continue
      const full = join(root, name)
      try {
        const st = statSync(full)
        if (!st || !st.isDirectory()) continue
      } catch {
        continue
      }
      const v = parseVersion(name)
      if (!v) continue
      cands.push({ path: full, version: v })
    }
  }

  cands.sort((a, b) => -compareVersions(a.version, b.version))
  return cands
}

// ────────────────────────────────────────────────────────────────────────────
// 6. resolveCli — 核心解析
// ────────────────────────────────────────────────────────────────────────────

/**
 * 工具链解析。
 *
 * @param {object} opts
 * @param {string} [opts.studioPath]   设置中的 Studio 路径
 * @param {string} [opts.cltPath]      设置中的 CLT 路径
 * @param {string} [opts.overrideExec] 测试/调试入口：强制返回 devecocli 路径
 * @param {string} [opts.platform]     'windows' | 'darwin' | 'linux'；默认按 process.platform 推断
 * @param {string} [opts.pathEnv]      覆盖 PATH（测试用）；默认 process.env.PATH
 * @param {string} [opts.dshDevecoCli] 覆盖 DSH_DEVECO_CLI（测试用）；默认 process.env.DSH_DEVECO_CLI
 * @returns {{
 *   source: 'devecocli'|'clt'|'studio'|'none',
 *   exec?: string,
 *   path?: string,
 *   version?: number[],
 *   minVersionOk: boolean,
 *   message: string,
 * }}
 */
export function resolveCli(opts = {}) {
  const {
    studioPath = '',
    cltPath = '',
    overrideExec = '',
    platform,
    pathEnv,
    dshDevecoCli,
  } = opts

  // 测试用 env 覆盖：保存原值并在本次调用期间替换
  const savedPath = process.env.PATH
  const savedDsh = process.env.DSH_DEVECO_CLI
  if (pathEnv !== undefined) process.env.PATH = pathEnv
  if (dshDevecoCli !== undefined) process.env.DSH_DEVECO_CLI = dshDevecoCli

  try {
    // 1. overrideExec 直接返回
    if (overrideExec) {
      return {
        source: 'devecocli',
        exec: overrideExec,
        minVersionOk: true,
        message: '使用 overrideExec 指定的 devecocli',
      }
    }

    // 2. PATH / DSH_DEVECO_CLI
    const found = findDevecoCli()
    if (found) {
      return {
        source: 'devecocli',
        exec: found,
        minVersionOk: true,
        message: `在 PATH 中找到 devecocli: ${found}`,
      }
    }

    // 3. cltPath
    const cleanClt = normalizeStudioPath(cltPath)
    if (cleanClt) {
      const chosen = pickCltPath(cleanClt, platform)
      if (chosen) {
        const v = chosen.version
        const ok = compareVersions(v, MIN_CLT_VERSION) >= 0
        const verStr = `${v[0]}.${v[1]}.${v[2]}`
        return {
          source: 'clt',
          path: chosen.path,
          version: v,
          minVersionOk: ok,
          message: ok
            ? `使用 Command Line Tools ${verStr}`
            : `Command Line Tools 版本 ${verStr} 低于最低要求 ${MIN_CLT_VERSION.join('.')}，请升级到 26.0.0 或更新`,
        }
      }
      // cltPath 配置了但解析不出可用版本 → 落到下一步（studio / none）
    }

    // 4. studioPath 兜底
    const cleanStudio = normalizeStudioPath(studioPath)
    if (cleanStudio) {
      return {
        source: 'studio',
        path: cleanStudio,
        minVersionOk: true,
        message: '使用 DevEco Studio 内置工具',
      }
    }

    // 5. 都没配
    return {
      source: 'none',
      minVersionOk: false,
      message: '未配置 DevEco Studio 或 Command Line Tools 路径；请在设置中填写，或将 devecocli 加入 PATH',
    }
  } finally {
    // 恢复 env，避免污染调用方
    if (pathEnv !== undefined) {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
    if (dshDevecoCli !== undefined) {
      if (savedDsh === undefined) delete process.env.DSH_DEVECO_CLI
      else process.env.DSH_DEVECO_CLI = savedDsh
    }
  }
}

/**
 * 把 cltPath（用户填的字符串）解析成一个具体的 { path, version } 候选。
 *  - 若末尾段匹配 ^\d+\.\d+\.\d+$，视为具体版本目录，直接用
 *  - 否则视为根目录，scanCltCandidates 找最新版本
 *  - 找不到或不可读 → 返回 null
 */
function pickCltPath(cltPath, platform) {
  // 末段切分：兼容 / 与 \
  const parts = cltPath.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] || ''
  if (VERSION_DIR_RE.test(last)) {
    // 视作具体版本目录：末段匹配 ^\d+\.\d+\.\d+$ 即信任用户配置，不强制 statSync
    // （用户在设置里粘路径时即使目录还没创建也应当允许保存；运行期再让 devecocli 自检）
    const v = parseVersion(last)
    if (!v) return null
    return { path: cltPath, version: v }
  }

  // 根目录扫描
  const cands = scanCltCandidates(platform || process.platform, cltPath)
  if (cands.length === 0) return null
  return { path: cands[0].path, version: cands[0].version }
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助：导出以供测试 / 调试，但不写入 README。
// ────────────────────────────────────────────────────────────────────────────

export const _internal = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  EXEC_NAME_WIN,
  EXEC_NAME_NIX,
  VERSION_DIR_RE,
  pickCltPath,
}
