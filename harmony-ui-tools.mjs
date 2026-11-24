/**
 * dsh-deveco — ArkUI 调试源的 agent 工具定义（`harmony_ui_tree` / `harmony_ui_node`）。
 *
 * 两个工具共用同一条取树链路（DevEco 开发调试源：应用侧 inspector socket），
 * 但工具 spec 必须住在**零依赖模块**里，不能住在 `index.js`——DSH 的
 * `output.schema` 是 `additionalProperties:false` 的**严格** schema（运行时
 * 出现未声明的键直接判 INVALID_TOOL_OUTPUT），而住在 `index.js` 里的定义
 * self-test 一行都覆盖不到（历史上 `-0` 负零就是这样悄悄炸掉整棵树的）。
 * 搬到这里之后，self-test 用自带的严格 schema 校验器逐键比对两个工具的返回值。
 *
 * 取树本身是 Host 编排（`index.js` 的 `_fetchDevEcoTree`：hdc fport + 裸 socket
 * WS），这里只通过一个 **host 端口**拿树，工具定义因此可脱离 DSH 单测：
 *
 *   host.fetchDevEcoTree({ device, pid, packageName })
 *     → Promise<{ ok: true, value: { nodes, source, pid, packageName } }
 *              | { ok: false, error: { code, message } }>
 *
 * `nodes` 是 `parseDevEcoTree` 的扁平 parse 节点数组（DFS 序，index/parentIndex/depth）。
 */

import {
  devEcoAncestorChain,
  devEcoNodeSummary,
  devEcoSubtreeNodes,
  devEcoToolNodes,
  devEcoTreeLines,
  findDevEcoNodeById,
} from './harmony-device.mjs'

/**
 * canonical 节点 schema（两个工具共用）：`harmony_ui_tree` 的 `nodes[]` 与
 * `harmony_ui_node` 的 `node` 都是它的投影（`devEcoNodeSummary` 的紧凑字段）。
 * `childCount` 由工具层从 parse 节点补上（`devEcoNodeSummary` 自己不产）。
 */
const sidesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    top: { type: 'number', required: true },
    right: { type: 'number', required: true },
    bottom: { type: 'number', required: true },
    left: { type: 'number', required: true },
  },
}
const boundsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    left: { type: 'number', required: true },
    top: { type: 'number', required: true },
    right: { type: 'number', required: true },
    bottom: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
  },
}
const nodeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    depth: { type: 'integer', required: true },
    parentIndex: { type: 'integer', required: true },
    name: { type: 'string', required: true, description: '展示名：组件名 → 开发者 .id() → 真实类型（沿用 UI 标签规则）' },
    componentName: { type: 'string', required: true },
    className: { type: 'string', required: true },
    kind: { type: 'string', enum: ['custom', 'build-in'], required: true },
    text: { type: 'string', required: true },
    devId: { type: 'string', required: true },
    accessibilityId: { type: 'string', required: true },
    bounds: { ...boundsSchema, required: true },
    visible: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    clickable: { type: 'boolean', required: true },
    scrollable: { type: 'boolean', required: true },
    childCount: { type: 'integer', required: true, description: '原始树中的直接子节点总数；Swiper/不可见/max_nodes 裁剪后仍保持原值' },
    childrenOmitted: { type: 'boolean', description: 'true = 该节点的直接子节点因裁剪未返回' },
    hiddenDirect: { type: 'integer', description: '被省略的直接子节点数（childrenOmitted 时有值）' },
    padding: sidesSchema,
    margin: sidesSchema,
    borderWidth: { type: 'number' },
    borderRadius: { type: 'number' },
    borderColor: { type: 'string' },
    backgroundColor: { type: 'string', description: '背景色声明值（有值才出现）' },
    attrs: { type: 'json', description: 'include_attrs 时附带的全部原始属性' },
  },
}

/**
 * 按 id 查节点失败时的可操作错误消息：`ambiguous` 列候选、`not-found` 列当前树
 * 里可用的 id（id 取自 `harmony_ui_tree` / `harmony_ui_node` 的输出）。
 *
 * @param {string} id 调用方给的 id
 * @param {object} hit `findDevEcoNodeById` 的失败结果
 * @param {Array<object>} nodes 当前树的扁平 parse 节点（列可用 id 用）
 * @returns {Error} 可直接 throw 的错误
 */
function devEcoNodeLookupError (id, hit, nodes) {
  const cands = Array.isArray(hit && hit.candidates) ? hit.candidates : []
  if (hit && hit.reason === 'ambiguous') {
    const list = cands.slice(0, 5).map((c) => `#${c.accessibilityId} ${c.name || c.className || ''}`.trim()).join('、')
    return new Error(
      `id "${id}" 在当前组件树里命中多个节点，无法唯一定位。候选：${list || '（无）'}。`
      + '请改用其中任一 accessibilityId（形如 #123）重试。',
    )
  }
  const avail = (Array.isArray(nodes) ? nodes : [])
    .filter((n) => n && n.accessibilityId)
    .slice(0, 8)
    .map((n) => `#${n.accessibilityId} ${n.componentName || n.devId || n.className || ''}`.trim())
    .join('、')
  return new Error(
    `当前组件树里找不到 id "${id}"。当前可用 id：${avail || '（无）'}。`
    + 'id 取自 harmony_ui_tree / harmony_ui_node 的输出（设备 accessibility id，形如 #123，或开发者 .id() 值）。',
  )
}

/**
 * Agent 工具面：`harmony_ui_tree` —— DevEco 开发调试源取树，注册进 DSH 的
 * `ctx.tools`（`@deepseek-ai/dsh-tools` 的 `defineTool`），让对话里的 agent
 * 直接调用。canonical 输出是紧凑节点数组（`devEcoNodeSummary`），`render`
 * 投影为缩进树文本（或 json 格式时输出完整 JSON）。
 *
 * @param {Function} defineTool dsh-tools 的 defineTool（运行期动态导入）
 * @param {{ fetchDevEcoTree: Function }} host host 端口（取树由 Host 编排）
 */
export function buildHarmonyUiTreeTool (defineTool, host) {
  return defineTool({
    name: 'harmony_ui_tree',
    description: "Fetch the ArkUI component tree of a HarmonyOS app on a connected device/emulator through the DevEco development-debug channel — the same data DevEco Studio's ArkUI Inspector shows, including component/Builder names (viewTag) and declared padding/margin/border values (uitest dumps lack these). Invisible nodes (visible=false / Visibility.Hidden / Visibility.None) are kept as leaf stubs (visible=false) while their whole subtrees are pruned — e.g. a home page hidden behind a pushed NavDestination stays inspectable as one stub row. For Swiper with displayCount absent or <= 1, only the currentIndex page is returned in full; other pages keep only their root, plus one child level for TabContent. Requires a debuggable app; the app-side inspector socket is single-client, so close DevEco Studio's ArkUI Inspector panel first if it is open (the error message lists all prerequisites). By default targets the foreground window's app. Returns an indented tree of nodes with bounds, text and box-model declarations. Pass root_id to get only the subtree rooted at that node instead of the whole tree.",
    parameters: {
      device: { type: 'string', description: 'Device/emulator serial as listed by hdc targets (e.g. 127.0.0.1:5555). Omit for the default target.' },
      pid: { type: 'integer', description: "Target app process id. Omit to use the foreground window's app." },
      package_name: { type: 'string', description: 'Target app package name (e.g. com.example.app). Derived from /proc/<pid>/cmdline when omitted.' },
      format: { type: 'string', enum: ['tree', 'json'], default: 'tree', description: 'tree = compact indented text lines (default); json = the full node objects as JSON.' },
      include_attrs: { type: 'boolean', description: "Include every node's full raw attribute map (very verbose; off by default)." },
      max_nodes: { type: 'integer', description: 'Maximum number of nodes returned (default 400, capped at 4000). Truncation drops whole subtrees — the boundary parent is flagged with childrenOmitted/hiddenDirect so no half-subtree is ever returned.' },
      root_id: { type: 'string', description: "Only return the subtree rooted at this node id. Accepts the device accessibility id (the '#123' shown in the UI tree, '#' optional) or a developer .id() value." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', const: 'deveco', required: true },
          pid: { type: 'integer', required: true },
          packageName: { type: 'string', required: true },
          nodeCount: { type: 'integer', required: true, description: '树中全部节点数（截断前）' },
          truncated: { type: 'boolean', required: true },
          nodes: { type: 'array', items: nodeSchema, required: true },
          rootId: { type: 'string', description: '仅传 root_id 时出现：命中节点的 id' },
          rootMatchedBy: { type: 'string', enum: ['accessibilityId', 'devId', 'componentName'], description: '仅传 root_id 时出现：按哪一层命中的' },
        },
      },
      render (args, value) {
        if (args && args.format === 'json') {
          return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
        }
        const rootNote = (args && args.root_id)
          ? ` root=#${value.rootId !== undefined ? value.rootId : args.root_id} (${value.rootMatchedBy || '?'})`
          : ''
        const head = `ArkUI 组件树（DevEco 调试源） pid=${value.pid} ${value.packageName} 共 ${value.nodeCount} 节点`
          + rootNote
          + (value.truncated ? `（已截断至 ${value.nodes.length}，加 max_nodes 看更多）` : '')
        return [{ type: 'text', text: [head, ...devEcoTreeLines(value.nodes)].join('\n') }]
      },
    },
    async execute (args) {
      const res = await host.fetchDevEcoTree({
        device: args.device,
        pid: args.pid,
        packageName: args.package_name,
      })
      if (!res.ok) {
        throw new Error((res.error && (res.error.message || res.error.code)) || 'harmony_ui_tree failed')
      }
      const all = Array.isArray(res.value.nodes) ? res.value.nodes : []
      let cap = Number.isFinite(args.max_nodes) ? Math.floor(args.max_nodes) : 400
      cap = Math.max(1, Math.min(cap, 4000))
      // 整棵子树省略式裁剪：绝不发半棵；childCount/childrenOmitted/hiddenDirect
      // 告诉前端与 agent 被省略处内部还有多少直接子节点。
      let source = all
      let rootId
      let rootMatchedBy
      if (typeof args.root_id === 'string' && args.root_id.trim()) {
        const hit = findDevEcoNodeById(all, args.root_id)
        if (!hit || !hit.ok) throw devEcoNodeLookupError(args.root_id, hit || {}, all)
        source = devEcoSubtreeNodes(all, hit.node)
        rootId = hit.id === undefined || hit.id === null ? '' : String(hit.id)
        rootMatchedBy = hit.matchedBy
      }
      const trimmed = devEcoToolNodes(source, cap, args.include_attrs === true)
      const out = {
        source: 'deveco',
        pid: res.value.pid,
        packageName: res.value.packageName,
        nodeCount: trimmed.nodeCount,
        truncated: trimmed.truncated,
        nodes: trimmed.nodes,
      }
      if (rootId !== undefined) {
        out.rootId = rootId
        out.rootMatchedBy = rootMatchedBy
      }
      return out
    },
    isConcurrencySafe () { return true },  // 只读、无共享状态，可并行
  })
}

/**
 * Agent 工具面：`harmony_ui_node` —— 按唯一 id 取**单个组件的全部属性**
 * （省 token 的替代路径）：只回那一个节点的 canonical 投影 ＋ 设备全量原始属性
 * ＋ 根→父的祖先链，而不是整棵树。与 `harmony_ui_tree` 同源同前置条件
 * （复用 host 端口的 `fetchDevEcoTree`）。
 *
 * @param {Function} defineTool dsh-tools 的 defineTool（运行期动态导入）
 * @param {{ fetchDevEcoTree: Function }} host host 端口（取树由 Host 编排）
 */
export function buildHarmonyUiNodeTool (defineTool, host) {
  return defineTool({
    name: 'harmony_ui_node',
    description: "Fetch ONE component's full attribute set by id — a token-frugal alternative to harmony_ui_tree: returns that node's every raw device attribute (font size, colours, sizes, states) plus its ancestor path, instead of the whole tree. Requires a debuggable app; the app-side inspector socket is single-client, so close DevEco Studio's ArkUI Inspector panel first if it is open (the error message lists all prerequisites). By default targets the foreground window's app.",
    parameters: {
      id: { type: 'string', required: true, description: "Device accessibility id of the node (e.g. 123 or #123, '#' optional) or a developer .id() value." },
      device: { type: 'string', description: 'Device/emulator serial as listed by hdc targets (e.g. 127.0.0.1:5555). Omit for the default target.' },
      pid: { type: 'integer', description: "Target app process id. Omit to use the foreground window's app." },
      package_name: { type: 'string', description: 'Target app package name (e.g. com.example.app). Derived from /proc/<pid>/cmdline when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', const: 'deveco', required: true },
          pid: { type: 'integer', required: true },
          packageName: { type: 'string', required: true },
          matchedBy: { type: 'string', enum: ['accessibilityId', 'devId', 'componentName'], required: true, description: '按哪一层命中的' },
          id: { type: 'string', required: true, description: '命中的节点 id' },
          node: { ...nodeSchema, required: true, description: '命中节点的 canonical 投影（带全部原始属性 attrs）' },
          path: {
            type: 'array',
            required: true,
            description: '根→父的祖先链（不含节点自身）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                className: { type: 'string', required: true },
                accessibilityId: { type: 'string', required: true },
                devId: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render (args, value) {
        const n = (value && value.node) || {}
        const b = n.bounds || {}
        const head = `ArkUI 组件 #${n.accessibilityId || ''} ${n.name || n.className || ''}`
          + (n.className && n.className !== n.name ? ` [${n.className}]` : '')
          + ` kind=${n.kind || ''}`
          + ` (${b.left ?? 0},${b.top ?? 0},${b.right ?? 0},${b.bottom ?? 0})`
          + (n.text ? ` text=${JSON.stringify(n.text)}` : '')
        const chain = (Array.isArray(value.path) ? value.path : [])
          .map((p) => `#${p.accessibilityId || ''} ${p.name || p.className || ''}`.trim())
        const pathLine = `路径：${chain.length ? chain.join(' > ') : '（根节点，无祖先）'}`
        const attrs = (n.attrs && typeof n.attrs === 'object') ? n.attrs : {}
        const attrLines = Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`)
        const body = attrLines.length
          ? [`原始属性（${attrLines.length} 项）：`, ...attrLines]
          : ['原始属性：（无）']
        return [{ type: 'text', text: [head, pathLine, ...body].join('\n') }]
      },
    },
    async execute (args) {
      const res = await host.fetchDevEcoTree({
        device: args.device,
        pid: args.pid,
        packageName: args.package_name,
      })
      if (!res.ok) {
        throw new Error((res.error && (res.error.message || res.error.code)) || 'harmony_ui_node failed')
      }
      const all = Array.isArray(res.value.nodes) ? res.value.nodes : []
      const hit = findDevEcoNodeById(all, args.id)
      if (!hit || !hit.ok) throw devEcoNodeLookupError(args.id, hit || {}, all)
      const node = devEcoNodeSummary(hit.node, true)
      if (!node) throw new Error(`id "${args.id}" 命中的节点无法解析`)
      // `devEcoNodeSummary` 不产 childCount，而 canonical 节点 schema 要求它必填
      node.childCount = Number.isFinite(hit.node.childCount) ? hit.node.childCount : 0
      const chain = devEcoAncestorChain(all, hit.node)
      const matchedBy = ['accessibilityId', 'devId', 'componentName'].includes(hit.matchedBy)
        ? hit.matchedBy
        : 'accessibilityId'
      return {
        source: 'deveco',
        pid: res.value.pid,
        packageName: res.value.packageName,
        matchedBy,
        id: hit.id === undefined || hit.id === null ? '' : String(hit.id),
        node,
        path: (Array.isArray(chain) ? chain : []).map((p) => ({
          index: Number(p.index) || 0,
          name: String(p.name || ''),
          className: String(p.className || ''),
          accessibilityId: String(p.accessibilityId || ''),
          devId: String(p.devId || ''),
        })),
      }
    },
    isConcurrencySafe () { return true },  // 只读、无共享状态，可并行
  })
}
