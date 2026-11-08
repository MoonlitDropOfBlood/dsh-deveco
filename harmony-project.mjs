/**
 * dsh-deveco — read-only HarmonyOS project model.
 *
 * Reads the same JSON5 configuration that DevEco Studio / Hvigor use and
 * projects it into a compact, JSON-safe model for agent tools. Signing material
 * is deliberately reduced to names/types/completeness flags: certificate paths,
 * key aliases and passwords never leave this module.
 */

import JSON5 from 'json5'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

const MAX_MODULES = 64
const MAX_PRODUCTS = 32
const MAX_ABILITIES = 64
const MAX_DEPENDENCIES = 128
const MAX_ARTIFACTS_PER_MODULE = 24
const MAX_SOURCE_MAPS_PER_MODULE = 24
const MAX_MAP_BYTES = 32 * 1024 * 1024

async function fileStat (path) {
  try { return await stat(path) } catch (_) { return null }
}

async function readJson5 (path) {
  const info = await fileStat(path)
  if (!info || !info.isFile()) return null
  const text = await readFile(path, 'utf8')
  return { value: JSON5.parse(text), mtimeMs: info.mtimeMs, size: info.size }
}

function object (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function string (value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function strings (value, cap = 64) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, cap)
}

function dependencies (value) {
  const result = {}
  for (const [name, version] of Object.entries(object(value)).slice(0, MAX_DEPENDENCIES)) {
    if (typeof version === 'string') result[name] = version
  }
  return result
}

async function looksLikeProjectRoot (path) {
  const profilePath = join(path, 'build-profile.json5')
  if (!await fileStat(profilePath)) return false
  if (await fileStat(join(path, 'AppScope', 'app.json5'))) return true
  try {
    const parsed = await readJson5(profilePath)
    const profile = object(parsed && parsed.value)
    return !!object(profile.app) && Array.isArray(profile.modules)
  } catch (_) {
    return false
  }
}

/** Find the application root, not a same-shaped module build profile. */
export async function findHarmonyProjectRoot (inputPath) {
  let current = resolve(inputPath || process.cwd())
  const info = await fileStat(current)
  if (!info) throw new Error(`路径不存在：${current}`)
  if (info.isFile()) current = dirname(current)
  while (true) {
    if (await looksLikeProjectRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`未找到 HarmonyOS 应用工程：从 ${resolve(inputPath || process.cwd())} 向上没有找到含 app/modules 的 build-profile.json5。请传工程根目录或工程内任意路径。`)
}

function signingSummaries (value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_PRODUCTS).map((entry) => {
    const item = object(entry)
    const material = object(item.material)
    const required = ['certpath', 'profile', 'storeFile', 'storePassword', 'keyAlias', 'keyPassword']
    return {
      name: string(item.name, 'default'),
      type: string(item.type),
      configured: required.every((key) => typeof material[key] === 'string' && material[key].length > 0),
    }
  })
}

async function collectArtifacts (modulePath, products, targets) {
  const found = new Map()
  async function walk (directory, depth, product, target) {
    if (depth > 3 || found.size >= MAX_ARTIFACTS_PER_MODULE) return
    let entries = []
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (_) { return }
    for (const entry of entries) {
      if (found.size >= MAX_ARTIFACTS_PER_MODULE) break
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1, product, target)
      else if (entry.isFile() && ['.hap', '.hsp', '.har', '.app'].includes(extname(entry.name).toLowerCase())) {
        const info = await fileStat(path)
        if (info) found.set(path, {
          path,
          kind: extname(entry.name).slice(1).toLowerCase(),
          product,
          target,
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
    }
  }
  for (const product of products) {
    for (const target of targets) await walk(join(modulePath, 'build', product, 'outputs', target), 0, product, target)
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ARTIFACTS_PER_MODULE)
}

async function sourceMapRecord (path, buildMode, kind) {
  const info = await fileStat(path)
  if (!info || !info.isFile()) return null
  // Keep oversized maps in the inventory without reading them: the debugger's
  // loader emits the explicit size warning and skips them safely.
  if (info.size > MAX_MAP_BYTES) {
    return { path, buildMode, kind, scriptCount: 0, size: info.size, mtimeMs: info.mtimeMs, tooLarge: true }
  }
  let scriptCount = 0
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    scriptCount = Object.keys(object(parsed)).length
  } catch (_) { /* the debugger reports malformed maps when it loads them */ }
  return { path, buildMode, kind, scriptCount, size: info.size, mtimeMs: info.mtimeMs }
}

async function collectSourceMaps (modulePath, products, targets, buildModes) {
  const records = new Map()
  async function add (path, buildMode, kind) {
    if (records.has(path)) return
    const record = await sourceMapRecord(path, buildMode, kind)
    if (record) records.set(path, record)
  }
  for (const product of products) {
    for (const target of targets) {
      for (const mode of buildModes) {
        await add(join(modulePath, 'build', product, 'cache', target, 'default@CompileArkTS', 'esmodule', mode, 'sourceMaps.json'), mode, 'cache')
      }
      await add(join(modulePath, 'build', product, 'intermediates', 'source_map', target, 'sourceMaps.map'), '', 'intermediate')
      await add(join(modulePath, 'build', product, 'intermediates', 'loader_out', target, 'ets', 'sourceMaps.map'), '', 'intermediate')
      await add(join(modulePath, 'build', product, 'outputs', target, 'mapping', 'sourceMaps.map'), '', 'output')
    }
  }
  return [...records.values()]
    .sort((a, b) => (a.kind === 'cache' ? -1 : 0) - (b.kind === 'cache' ? -1 : 0) || b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SOURCE_MAPS_PER_MODULE)
}

async function pageList (modulePath, pagesRef, warnings) {
  const name = string(pagesRef)
  if (!name.startsWith('$profile:')) return []
  const path = join(modulePath, 'src', 'main', 'resources', 'base', 'profile', `${name.slice('$profile:'.length)}.json`)
  try {
    const parsed = await readJson5(path)
    return strings(object(parsed && parsed.value).src, 128)
  } catch (error) {
    warnings.push(`页面列表读取失败：${path}（${error.message}）`)
    return []
  }
}

function abilitySummaries (value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_ABILITIES).map((entry) => {
    const item = object(entry)
    return {
      name: string(item.name),
      srcEntry: string(item.srcEntry),
      exported: item.exported === true,
    }
  }).filter((item) => item.name)
}

function extensionSummaries (value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_ABILITIES).map((entry) => {
    const item = object(entry)
    return { name: string(item.name), srcEntry: string(item.srcEntry), type: string(item.type), exported: item.exported === true }
  }).filter((item) => item.name)
}

/**
 * Inspect one HarmonyOS application.
 *
 * @param {string} inputPath project root or any file/directory inside it
 * @returns {Promise<object>} JSON-safe project model
 */
export async function inspectHarmonyProject (inputPath) {
  const root = await findHarmonyProjectRoot(inputPath)
  const warnings = []
  const profilePath = join(root, 'build-profile.json5')
  const appPath = join(root, 'AppScope', 'app.json5')
  const packagePath = join(root, 'oh-package.json5')
  let profile
  let app
  let pkg
  try { profile = object((await readJson5(profilePath))?.value) } catch (error) {
    throw new Error(`工程配置解析失败：${profilePath}（${error.message}）`)
  }
  try { app = object(object((await readJson5(appPath))?.value).app) } catch (error) {
    warnings.push(`AppScope/app.json5 解析失败：${error.message}`)
    app = {}
  }
  try { pkg = object((await readJson5(packagePath))?.value) } catch (error) {
    warnings.push(`oh-package.json5 解析失败：${error.message}`)
    pkg = {}
  }

  const appBuild = object(profile.app)
  const products = (Array.isArray(appBuild.products) ? appBuild.products : []).slice(0, MAX_PRODUCTS).map((entry) => {
    const item = object(entry)
    return {
      name: string(item.name, 'default'),
      signingConfig: string(item.signingConfig),
      targetSdkVersion: typeof item.targetSdkVersion === 'number' ? String(item.targetSdkVersion) : string(item.targetSdkVersion),
      compatibleSdkVersion: typeof item.compatibleSdkVersion === 'number' ? String(item.compatibleSdkVersion) : string(item.compatibleSdkVersion),
      runtimeOS: string(item.runtimeOS),
    }
  })
  if (products.length === 0) products.push({ name: 'default', signingConfig: '', targetSdkVersion: '', compatibleSdkVersion: '', runtimeOS: '' })
  const buildModes = strings((Array.isArray(appBuild.buildModeSet) ? appBuild.buildModeSet : []).map((item) => object(item).name), 16)
  for (const mode of ['debug', 'release']) if (!buildModes.includes(mode)) buildModes.push(mode)

  const modules = []
  for (const entry of (Array.isArray(profile.modules) ? profile.modules : []).slice(0, MAX_MODULES)) {
    const item = object(entry)
    const name = string(item.name)
    if (!name) continue
    const modulePath = resolve(root, string(item.srcPath, `./${name}`))
    const moduleProfilePath = join(modulePath, 'build-profile.json5')
    const moduleConfigPath = join(modulePath, 'src', 'main', 'module.json5')
    const modulePackagePath = join(modulePath, 'oh-package.json5')
    let moduleConfig = {}
    let modulePackage = {}
    try { moduleConfig = object(object((await readJson5(moduleConfigPath))?.value).module) } catch (error) {
      warnings.push(`${name}/module.json5 解析失败：${error.message}`)
    }
    try { modulePackage = object((await readJson5(modulePackagePath))?.value) } catch (error) {
      warnings.push(`${name}/oh-package.json5 解析失败：${error.message}`)
    }
    if (!await fileStat(moduleProfilePath)) warnings.push(`模块缺少 build-profile.json5：${modulePath}`)
    const targets = (Array.isArray(item.targets) ? item.targets : []).map((target) => {
      const value = object(target)
      return { name: string(value.name, 'default'), applyToProducts: strings(value.applyToProducts, 32) }
    })
    if (targets.length === 0) targets.push({ name: 'default', applyToProducts: products.map((product) => product.name) })
    const targetNames = targets.map((target) => target.name)
    const productNames = products.map((product) => product.name)
    const permissions = (Array.isArray(moduleConfig.requestPermissions) ? moduleConfig.requestPermissions : [])
      .map((permission) => string(object(permission).name)).filter(Boolean).slice(0, 128)
    modules.push({
      name: string(moduleConfig.name, name),
      path: modulePath,
      type: string(moduleConfig.type, name === 'entry' ? 'entry' : ''),
      mainElement: string(moduleConfig.mainElement),
      deviceTypes: strings(moduleConfig.deviceTypes),
      abilities: abilitySummaries(moduleConfig.abilities),
      extensionAbilities: extensionSummaries(moduleConfig.extensionAbilities),
      requestPermissions: permissions,
      pages: await pageList(modulePath, moduleConfig.pages, warnings),
      routerMap: string(moduleConfig.routerMap),
      targets,
      dependencies: dependencies(modulePackage.dependencies),
      devDependencies: dependencies(modulePackage.devDependencies),
      sourceMaps: await collectSourceMaps(modulePath, productNames, targetNames, buildModes),
      artifacts: await collectArtifacts(modulePath, productNames, targetNames),
    })
  }

  return {
    root,
    name: string(pkg.name, basename(root)),
    bundleName: string(app.bundleName),
    vendor: string(app.vendor),
    versionName: string(app.versionName),
    versionCode: Number.isFinite(Number(app.versionCode)) ? Number(app.versionCode) : 0,
    modelVersion: string(pkg.modelVersion),
    runtimeOS: products.find((product) => product.runtimeOS)?.runtimeOS || '',
    defaultProduct: products[0].name,
    defaultBuildMode: buildModes.includes('debug') ? 'debug' : buildModes[0] || 'debug',
    products,
    buildModes,
    signingConfigs: signingSummaries(appBuild.signingConfigs),
    dependencies: dependencies(pkg.dependencies),
    devDependencies: dependencies(pkg.devDependencies),
    modules,
    inspectedAt: Date.now(),
    warnings,
  }
}
