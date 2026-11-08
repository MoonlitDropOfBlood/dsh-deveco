// dsh-deveco — real Hvigor Source Map integration probe (no device/DSH needed).
//
//   node scripts/e2e-source-map.mjs --project /path/to/app \
//     --source entry/src/main/ets/pages/Index.ets --line 296
//
// Exit 0 means the source line resolved to an exact ArkVM script/generated
// location and that generated location mapped back to the same .ets source.

import { inspectHarmonyProject } from '../harmony-project.mjs'
import { assertSourceBreakpointFresh, loadHarmonySourceMapIndex } from '../harmony-source-map.mjs'

function arg (name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const projectPath = arg('project', process.cwd())
const sourcePath = arg('source')
const sourceLine = Number(arg('line', '1'))
const buildMode = arg('mode', 'debug')

if (!sourcePath || !Number.isInteger(sourceLine) || sourceLine < 1) {
  console.error('Usage: node scripts/e2e-source-map.mjs --project <project> --source <Index.ets> --line <1-based> [--mode debug|release]')
  process.exit(2)
}

try {
  const project = await inspectHarmonyProject(projectPath)
  const index = await loadHarmonySourceMapIndex(project, { buildMode })
  const resolved = index.resolveSourceBreakpoint({ sourcePath, sourceLine: sourceLine - 1 })
  if (!resolved) throw new Error(`No executable mapping for ${sourcePath}:${sourceLine}; build the project or choose a statement line.`)
  await assertSourceBreakpointFresh(resolved, sourcePath, project.root)
  const frame = index.mapFrame({ index: 0, functionName: '<probe>', url: resolved.url, lineNumber: resolved.line, columnNumber: resolved.column })
  if (!frame.sourcePath) throw new Error('Forward mapping succeeded but reverse mapping returned no source location.')
  console.log(JSON.stringify({
    ok: true,
    project: { root: project.root, name: project.name, bundleName: project.bundleName },
    buildMode,
    indexedScripts: index.scriptCount,
    requested: { sourcePath, sourceLine },
    breakpoint: resolved,
    reverse: { sourcePath: frame.sourcePath, sourceLine: frame.sourceLine, sourceColumn: frame.sourceColumn },
    warnings: index.warnings,
  }, null, 2))
} catch (error) {
  console.error(`Source Map probe failed: ${error && error.message ? error.message : error}`)
  process.exit(1)
}
