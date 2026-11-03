/**
 * dsh-deveco — Device command helpers for the ArkTS debugger tool (Host half).
 *
 * Only the pieces the debugger path needs: bundle/ability validation, the
 * `bm dump` probe that proves an app is debug-signed, and the launch commands
 * that put an app into the wait-for-debugger state.
 *
 * Everything else the agent might want (logs, app list/install/uninstall) is
 * already covered by `devecocli log` / `devecocli device app …`, so this
 * module deliberately does **not** re-implement those — the agent runs the
 * CLI directly.
 *
 * These functions are pure (no I/O) so `scripts/self-test.mjs` can assert the
 * exact command strings a real `hdc shell` receives.
 */

/** Bundle names: reverse-DNS-ish, no spaces/quotes/shell metacharacters. */
const BUNDLE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/
/** Ability names (EntryAbility / module/EntryAbility / $string:… is rejected). */
const ABILITY_RE = /^[A-Za-z0-9_.$/-]{1,180}$/
/** Module names share the ability charset. */
const MODULE_RE = /^[A-Za-z0-9_.$-]{1,120}$/

/**
 * Quote one value for the device shell (`sh -c` single-quote form).
 *
 * @param {unknown} value
 * @returns {string} `'…'` with embedded single quotes escaped.
 */
export function shellQuote (value) {
  const text = value === undefined || value === null ? '' : String(value)
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

/** @param {unknown} value @returns {boolean} */
export function isBundleName (value) {
  return typeof value === 'string' && BUNDLE_RE.test(value)
}

/** @param {unknown} value @returns {boolean} */
export function isAbilityName (value) {
  return typeof value === 'string' && ABILITY_RE.test(value)
}

/**
 * `bm dump -n <bundle>` device command.
 * @param {string} bundle
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
export function buildBundleInfoCommand (bundle) {
  if (!isBundleName(bundle)) return { ok: false, error: 'invalid bundle name' }
  return { ok: true, command: `bm dump -n ${shellQuote(bundle)}` }
}

/**
 * Parse `bm dump -n <bundle>` (`<bundle>:\n{ …json… }`). Returns the parsed
 * JSON (when present) plus a truncated raw text for callers that need fields
 * this helper does not model.
 *
 * On stage-model apps the launch entry point is NOT top-level: `bm dump`
 * reports it per module under `hapModuleInfos[]` (`mainElementName` /
 * `mainAbility`), so both shapes are searched. `moduleName` is returned too —
 * `aa start -m` needs it when a bundle has several modules.
 *
 * @param {string} text
 * @param {number} [rawCap] Max raw characters kept (default 20000).
 * @returns {{ bundle: string, json: object | null, raw: string, abilities: string[], mainAbility: string, moduleName: string }}
 */
export function parseBundleInfo (text, rawCap = 20000) {
  const source = String(text || '')
  const head = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+):\s*$/m.exec(source)
  const bundle = head ? head[1] : ''
  const start = source.indexOf('{')
  let json = null
  if (start >= 0) {
    const end = source.lastIndexOf('}')
    if (end > start) {
      try { json = JSON.parse(source.slice(start, end + 1)) } catch (_) { json = null }
    }
  }
  const abilities = []
  const pushAbilities = (holder) => {
    if (!holder || !Array.isArray(holder.abilities)) return
    for (const ability of holder.abilities) {
      if (ability && typeof ability.name === 'string' && abilities.length < 64) abilities.push(ability.name)
    }
  }
  let mainAbility = ''
  let moduleName = ''
  if (json) {
    pushAbilities(json)
    if (typeof json.mainElementName === 'string' && json.mainElementName) mainAbility = json.mainElementName
    if (!mainAbility && typeof json.mainAbility === 'string' && json.mainAbility) mainAbility = json.mainAbility
    const modules = Array.isArray(json.hapModuleInfos) ? json.hapModuleInfos : []
    for (const mod of modules) {
      if (!mod || typeof mod !== 'object') continue
      pushAbilities(mod)
      const candidate = typeof mod.mainElementName === 'string' && mod.mainElementName
        ? mod.mainElementName
        : (typeof mod.mainAbility === 'string' ? mod.mainAbility : '')
      if (!mainAbility && candidate) {
        mainAbility = candidate
        if (typeof mod.moduleName === 'string') moduleName = mod.moduleName
      }
    }
  }
  return { bundle, json, raw: source.slice(0, rawCap), abilities, mainAbility, moduleName }
}

/**
 * `aa start` device command. `-D` asks the runtime to launch in debug mode
 * (the same switch DevEco uses before attaching its debugger).
 *
 * @param {object} opts
 * @param {string} opts.bundle
 * @param {string} [opts.ability]
 * @param {string} [opts.module]
 * @param {boolean} [opts.debug]
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
export function buildStartAbilityCommand (opts = {}) {
  if (!isBundleName(opts.bundle)) return { ok: false, error: 'invalid bundle name' }
  const parts = ['aa', 'start', '-b', shellQuote(opts.bundle)]
  if (opts.ability !== undefined && opts.ability !== null && opts.ability !== '') {
    if (!isAbilityName(opts.ability)) return { ok: false, error: 'invalid ability name' }
    parts.push('-a', shellQuote(opts.ability))
  }
  if (opts.module !== undefined && opts.module !== null && opts.module !== '') {
    if (!MODULE_RE.test(String(opts.module))) return { ok: false, error: 'invalid module name' }
    parts.push('-m', shellQuote(opts.module))
  }
  if (opts.debug) parts.push('-D')
  return { ok: true, command: parts.join(' ') }
}

/**
 * `aa force-stop <bundle>` device command.
 * @param {string} bundle
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
export function buildForceStopCommand (bundle) {
  if (!isBundleName(bundle)) return { ok: false, error: 'invalid bundle name' }
  return { ok: true, command: `aa force-stop ${shellQuote(bundle)}` }
}

/**
 * `aa appdebug -b <bundle>` device command — the "wait for a debugger" marker
 * the ArkVM uses to register a live debugger instance for the next launch.
 *
 * @param {string} bundle
 * @returns {{ ok: true, command: string } | { ok: false, error: string }}
 */
export function buildAppDebugCommand (bundle) {
  if (!isBundleName(bundle)) return { ok: false, error: 'invalid bundle name' }
  return { ok: true, command: `aa appdebug -b ${shellQuote(bundle)}` }
}

/** @returns {string} `ps -ef` device command used for pid discovery. */
export function buildProcessListCommand () {
  return 'ps -ef'
}
