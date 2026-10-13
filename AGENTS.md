# AGENTS.md — dsh-deveco

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）bundle 插件**：在 DSH Web UI 提供完整的 HarmonyOS 开发能力。

- **官方右侧边栏（`ctx.sidebarRightTabs`）注册两个页面 Tab**：
  - **HiLog 检查器**（id `dsh-deveco:hilog`，guide order 50）：实时日志流（级别/包名/关键词过滤），基于 `devecocli log --follow` 封装
  - **ArkUI Inspector**（id `dsh-deveco:arkui`，guide order 51）：**Chrome Elements 风格**——左侧设备截图（`uiScreenshot` 内联 dataUrl，点击截图命中节点并以**像素级 overlay** 按 `origBounds` 真实矩形高亮），右上 **可折叠** UI 树（层级引导线 + 自定义组件单独标注 + tap/scroll 标记 + 折叠全部/展开全部），右下节点属性（**全部设备原始属性** + **属性名/值搜索**）与盒子模型；顶部**窗口下拉**切换窗口；底部 Tap/Swipe/Text 操作
  - **Projects** 项目浏览器为 v1.0 占位（listProjects 返回空数组；v1.1 路线）
- **官方右侧边栏注册 `.ets` 文件查看器**（id `dsh-deveco:arkts`，`patterns: ["dsh-resource://file/**"]` + `canOpen` 按扩展名过滤，priority `extension` 优先于内置 text editor）。提供 ArkTS 语法高亮（关键字 + 装饰器 + 注释 + 字符串 + 数字）；内容经官方 `remote.workspaceFiles.read` 分页读取（绝对路径回退插件自有 `readTextFile` Remote）。
- **设置面板新增「HarmonyOS Suite」页**（`settings.section`，order 40），分「工具链」「设备管理」两区。工具链区管理 DevEco Studio 与 HarmonyOS Command Line Tools 路径（三平台自发现、Studio/CLT 互斥、CLT 最低版本 26.0.0 校验）；设备管理区含**设备列表**（USB/网络目标，网络 `ip:port` 目标可一键断开）与 **IP 网络连接**表单（`hdc tconn <ip>:<port>`）。

## 目录结构

```
dsh-deveco/
├── package.json              # ESM 双面包：dsh.bundle.patch + dsh.client.web + exports(., /client, /typert, /package.json)
├── index.js                  # Host 半：HarmonyDevEcoService（TypertRemoteService 子类，21 个 Remote 方法）
├── client.js                 # Client 半：__ModuleLoader__ bundle（Tab + Viewer + Settings + Remote mount）
├── typert.host.js            # Typert Host manifest：harmonyDevEco Remote 服务全部 invocation 的 zod schema
├── harmony-studio.mjs        # 零依赖：工具链路径探测（devecocli > CLT ≥26.0.0 > Studio）+ 版本解析 + 三平台默认路径
├── harmony-config.mjs        # 零依赖：配置持久化 + Studio/CLT 互斥 + 自发现调度
├── harmony-device.mjs        # 零依赖：devecocli 进程封装 + hdc IP 连接（tconn）+ HiLog/ui-layout JSON 解析
├── cordis.patch.yml          # dsh bundle patch（挂载行）
├── scripts/self-test.mjs     # 86 个独立核心单元测试（路径探测 + 配置互斥 + HiLog/ui 解析 + hdc IP 连接/空格路径 spawn/超时判定 + 盒子模型/contentBox/hitTest/PNG 尺寸 + 窗口/原始 dump/DevEco 调试树/裸 WS 握手/agent 工具投影与子树截断/mac .app 路径补全/自定义组件/字体属性/devId 解析）
├── .github/workflows/release.yml  # v* tag → 构建 + 发布 GitHub Release
├── AGENTS.md                 # 本文件
├── README.md                 # 用户面向
└── LICENSE                   # MIT
```

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

| 文件 | 作用 | 被谁加载 |
|---|---|---|
| `index.js` | Host：Cordis **类插件**（`export class HarmonyDevEcoService extends TypertRemoteService`），服务键 `harmonyDevEco` | cordis loader（composition `insert` 行） |
| `client.js` | Client：`window.__ModuleLoader__.load({id, factory})` bundle | `client-modules`（扫描 `dsh.client` 声明 → 注入 `window.__DSH_BOOT__`） |
| `typert.host.js` | `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[], objects:[]} }` | `typert-loader`（扫描包的 `./typert` 导出） |

**关键名字必须一致**：类名 `HarmonyDevEcoService`、服务键 `harmonyDevEco`、invocation id `dsh-deveco#harmonyDevEco/<method>`、`package.json` exports 含 `./package.json`。

### 2. Host 半：类插件 + Remote 方法

```js
export class HarmonyDevEcoService extends TypertRemoteService {
  static inject = [];
  constructor(ctx, config) {
    super(ctx, "harmonyDevEco");  // 必须传精确服务键，否则 validateName 抛错
  }
  async [Service.init]() {
    markRemoteMethod(this, "getConfig", "getConfig");
    // ...其余 18 个方法
  }
  async getConfig() { /* ... */ }
}
```

- 文件 I/O 直接 `import ... from "node:fs/promises"`。正式插件的 Host 半由 loader 用标准 `import()` 加载，拥有完整 Node 权限，和 DSH 核心写 `~/.dsh` 一样，**不需要**走 `ctx.shell` 沙箱。配置 / 发现缓存目录在 `<DSH_HOME>/data/dsh-deveco/`。
- Remote 标记用 `markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote()` 装饰器（Node ESM 不支持装饰器），在 `[Service.init]()` 中调用。

### 3. Client 半：bundle + 自挂载 Remote + Slot 注册

- `window.__ModuleLoader__.load({ id, factory })` 格式；`exports.inject = ["slots", "remote"]`。
- **必须自挂载** Remote 命名空间：`await ctx.remote.$mount(CLIENT_REMOTE)`（`dsh-api-remotes` 只挂载官方命名空间）。调用走 `ctx.get('remote.harmonyDevEco')`（**不要**写进 inject）。codecs 用 passthrough schema（`{ parse: (v) => v }`，浏览器没有 zod）。
- **官方右侧边栏集成（DSH 0.2.0 `sidebarRightTabs`）**：两阶段注册——① `ctx.inject(["sidebarRightTabs"], (injected) => { const tabs = injected.get("sidebarRightTabs"); ... tabs.register({id, kind, patterns?, canOpen?, priority:"extension", title, guide?}) })` 声明 tab 类型；② `ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({name:"sidebar.right.pane.tab", key:<同 id>, inject:(sessionId)=>({sessionId})}, BodyComponent))` 绑定 body。slot 注册可能在 type 注册成功后失败（dispose 竞态），disposer 收集后失败回滚。**tab 定义 id 与 slot key 必须相同**。body 组件由 slot 系统自动注入 `props.useTabInfo()`（`info.tab.navigation.address` 取文件地址），inject 回调只提供自定义 props。
- **设置页注册**：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'harmony-deveco', order: 40, label: () => 'HarmonyOS Suite' }, HarmonySettingsPage))`。0.2.0 移除了 `settingsScope` 与 `settings.plugin.item`；路径读写走 `setStudioPath`/`setCltPath`/`getConfig` Remote，Host 侧经 harmony-config.mjs 持久化到 config.json。
- **设置导航图标**：DSH 0.1.x `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮。`client.js` 的 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-deveco-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 smartphone Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path。
- CSS 用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`；颜色一律 `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-shadow-*`。
- **Component 一律 bundle 作用域定义**（不内联创建）：内联创建会在每次父级 re-render 时拿到新的 component identity，导致 React 卸载并重建子树、丢失输入态。

### 4. Remote 返回包络

网关对 Remote 返回值的包裹在不同插件里有两种形态（archive-manager 直接读 `res.ok`，token-stats 说 `res.value` 才是 Host 返回包络）。**不要赌形态**，客户端统一用 `unwrap(res)`：

```js
function unwrap(res) {
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || { code: "transport", message: "调用失败" } };
  }
  const v = res.value;
  if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
  return { ok: true, value: v };
}
```

Host 方法一律返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

### 5. 21 个 Remote 方法

| 方法 | 用途 |
|---|---|
| `getConfig` | 取当前配置 + resolved + discovery |
| `setStudioPath` | 设置 Studio 路径（清空 cltPath） |
| `setCltPath` | 设置 CLT 路径（清空 studioPath） |
| `rescan` | 重跑自发现 |
| `deviceList` | 列出设备/模拟器 |
| `deviceInfo` | 设备详情 |
| `deviceConnectIp` | IP 网络连接：`hdc tconn <ip>:<port>`（端口必填——hdc 无默认端口，须与设备开启调试后暴露的端口一致；HarmonyOS 直接在设备「设置 → 开发者选项」开启调试，无需 Android 那套 `hdc tmode`；devecocli 无对应能力，Host 直连 SDK 自带 hdc） |
| `deviceDisconnectIp` | 断开 IP 设备：`hdc tconn <ip>:<port> -remove` |
| `hilogList` | 历史 hilog（一次性） |
| `hilogStreamStart` | 启动实时流（返回 streamId） |
| `hilogStreamRead` | 读取缓冲区（drain maxLines） |
| `hilogStreamStop` | 停止流 |
| `uiDump` | ArkUI UI 树（**uitest 无障碍树**，适合已发布应用）：优先走 `hdc shell uitest dumpLayout` 原始 dump（含 `origBounds` 真实矩形、`hostWindowId` 窗口归属及 zIndex/selected/checked 等属性），hdc 不可用时回退 `devecocli ui layout` |
| `uiDevEcoTree` | **DevEco 开发调试源**：`aa attach -b <pkg>` → 全新端口 `hdc fport tcp:<p> ark:<pid>@<pkg>` → **裸 socket WS**（极简 6 头握手，`connected`→`inspectorAbilities`→`tree` → 应用回 `type:root` 树）。唯一带 padding/margin/border 声明值（vp/px 单位）与 viewTag 组件名的源；应用侧 socket **单客户端**（DevEco Inspector 面板开着会被占用） |
| `uiWindowList` | 列出 UI 窗口（`{id,name,pid,displayId,focused}`），供 Inspector 窗口下拉使用 |
| `uiScreenshot` | 截图：Host 落盘后回读 PNG，返回 `savedTo` + 内联 `dataUrl`（≤4 MiB）+ `imageWidth/imageHeight`（IHDR 解析）+ `byteSize` |
| `uiTap` | 点击 |
| `uiSwipe` | 滑动 |
| `uiText` | 输入文本 |
| `listProjects` | 列出鸿蒙工程（v1.0 返回空） |
| `readTextFile` | 读取 UTF-8 文本文件（2 MiB 截断），.ets 查看器绝对路径回退用 |

### 6. 工具链解析优先级（用户决策）

1. `PATH` 存在 `devecocli`（或 `DSH_DEVECO_CLI` 环境变量） → 优先使用，**忽略设置路径**
2. CLT 路径 ≥ `MIN_CLT_VERSION = [26, 0, 0]` → 用 CLT（与 Studio 互斥）
3. DevEco Studio 路径 → 兜底
4. 无 → `source: 'none'`，错误提示去设置

互斥规则（用户决策）：`setCltPath` 清空 `studioPath`；`setStudioPath` 清空 `cltPath`。即使 CLT 版本不达标也优先 CLT（`minVersionOk:false` 让 UI 提示升级，不静默回退 Studio）。

### 7. 三平台默认安装路径

- **Studio**（首次启动自动发现）：
  - Windows: `C:\\Program Files\\Huawei\\DevEco Studio`、`C:\\Program Files (x86)\\Huawei\\DevEco Studio`、`C:\\DevEco Studio`
  - macOS: `/Applications/DevEco Studio.app/Contents`、`/Applications/Huawei DevEco Studio.app/Contents`、`~/Applications/DevEco Studio.app/Contents`
  - Linux: `/opt/deveco-studio`、`/opt/Huawei DevEco Studio`、`~/deveco-studio`
- **CLT 根**（扫描 `<root>/<version>` 子目录）：
  - Windows: `C:\\Program Files\\Huawei\\Command Line Tools`、`%LOCALAPPDATA%\\Huawei\\Command Line Tools`
  - macOS: `/Applications/Command Line Tools.app/Contents`、`~/Library/Huawei/Command Line Tools`
  - Linux: `/opt/Huawei/Command Line Tools`、`~/Huawei/Command Line Tools`

### 8. 持久化

- 配置：`<DSH_HOME>/data/dsh-deveco/config.json`
- 自发现缓存：`<DSH_HOME>/data/dsh-deveco/discovery.json`
- 写入：原子 `tmp + rename`，避免半截文件
- 首次启动（discovery.json 不存在）自动触发 `ensureDiscovery`，并把结果缓存

### 9. Agent 工具面（ctx.tools，让对话里的 agent 可调用）

**`harmony_ui_tree`** —— DevEco 调试源取树，注册进 DSH 的 `ctx.tools`（`@deepseek-ai/dsh-tools` 的 `defineTool`），agent 可直接调用：

- **参数**：`device`（序列号，省略用默认目标）、`pid` / `package_name`（省略取前台窗口应用）、`format`（`tree` 缩进树文本＝默认 / `json` 完整节点 JSON）、`include_attrs`（附带全部原始属性，占篇幅，默认关）、`max_nodes`（默认 400、上限 4000）。截断**整棵子树省略，绝不发半棵**：被省略节点的最近保留祖先带 `childrenOmitted: true` + `hiddenDirect`（省略的直接子节点数），每个节点带 `childCount`（完整树口径的直接子节点总数）——前端/agent 由此知道内部还有多少孩子。
- **canonical 输出**（`output.schema` 严格校验）：`{ source:"deveco", pid, packageName, nodeCount, truncated, nodes[] }`，节点是 `devEcoNodeSummary` 的紧凑投影（展示名沿用 UI 标签规则：组件名→开发者 id→真实类型；声明值**有值才挂 key**）；`render` 把 nodes 投影成缩进树文本行（`devEcoTreeLines`），`format=json` 时输出完整 JSON。
- **注册模式**（Host `[Service.init]`）：动态 `import("@deepseek-ai/dsh-tools")` → `this._ctx.inject(["tools"], ...)` → `tools.register(buildHarmonyUiTreeTool(...))`，注册器返回的 disposer 用 `this._ctx.effect(() => off)` 挂到插件生命周期。**全链路 try/catch 优雅降级**：dsh-tools / ctx.tools 任一不可用就静默跳过，Remote/UI 面不受影响。`peerDependencies` 加 `@deepseek-ai/dsh-tools`（双段范围，过兼容性 gate）。
- **实现复用**：工具走 `service._fetchDevEcoTree()`（rich：nodes + source + pid + packageName）；Remote `uiDevEcoTree` 是它的薄包装（严格按 TYPERT 契约只回 `{nodes, source}`）。同一份取树链路两面共用。
- **边界同 DevEco 调试源**：需 debug 应用 + IDE Inspector 面板未占用（单客户端）；失败时抛错（registry 转 isError 文本），错误信息含全部前置条件指引。`isConcurrencySafe: true`（只读无共享状态，可并行）。

## 开发 / 验证

```bash
npm run check              # 全部 JS 语法检查
npm test                   # 86 个单元测试（路径探测 + 配置互斥 + HiLog/ui 解析 + hdc IP 连接/空格路径 spawn/超时判定 + 盒子模型/contentBox/hitTest/PNG 尺寸 + 窗口/原始 dump/DevEco 调试树/裸 WS 握手/agent 工具投影与子树截断/mac .app 路径补全/自定义组件/字体属性/devId 解析）
dsh plugin --profile web add .   # 本地安装/重装
```

**改插件后必须重启 DSH** 生效（Host 加载、typert 注册、client bundle 注入都在启动时发生）。

端到端验证清单：
1. 设置 → 侧栏导航出现 **HarmonyOS Suite**（图标：手机，smartphone Lucide）
2. 打开 HarmonyOS Suite 设置页：能看到「未配置」状态徽章（红色 err）
3. 输入一个 CLT 路径（含版本号如 `26.0.0`）→ 点「应用」→ 状态变绿；输入 Studio 路径 → 状态变 Studio
4. 设置面板的「HarmonyOS Suite」页 → 验证「DevEco Studio 路径」「HarmonyOS Command Line Tools 路径」互斥（应用 CLT 清空 Studio，反之亦然）
5. 官方右侧边栏 Guide 菜单看到「HiLog 检查器」「ArkUI Inspector」两个入口 → 各打开 Tab
6. HiLog Tab：选设备（先点「刷新设备」）→ 设过滤 → 「开始」→ 日志流出现；点击级别 chip 可过滤
7. ArkUI Tab：「Dump UI」→ **自动截图 + 当前树源的 UI 树** → 顶部**「树源」下拉**两选一切换即重抓（DevEco 调试源＝应用侧 ark socket，带盒模型声明值与组件名，窗口下拉此时禁用——该源按应用抓取；无障碍树＝uitest，适合已发布应用）、**「窗口」下拉**（**自动选中前台窗口**、**无「全部窗口」选项**，切换即重抓）→ 树上**折叠/展开**、层级引导线（**线性缩进不封顶**）、**名字为主标签**（能提取组件名就只显示组件名，如 `ImageKnifePro`；提取不到的 compid 照 DevEco 原样显示，如 `mainNavigationId`/`tab_0`；再没有显示真实类型含 `__Common__`，不显示 id、不编造占位文案）、`#accessibilityId` 标识、**「仅组件」过滤** → 点节点或**点截图**（树自动展开并滚动定位）→ 蓝框高亮 → 属性面板**搜索框**过滤、列出**全部设备原始属性** → 盒子模型显示**组件区域 / 内容区域 / 四边内缩实测值**；padding/margin/border/圆角在 DevEco 调试源下显示**声明值**，uitest 源显示「未提供」
8. 打开任意 `.ets` 文件 → ArkTS 高亮查看器打开（文件名作为 tab 标题）
9. Projects 能力：v1.0 占位（listProjects 返回空数组）
10. 设置页「设备管理」区：设备列表出现（或空态文案）→ IP 连接后列表出现「网络」徽章的 ip:port 目标 → 点行内「断开」→ 列表自动刷新

## 发布

打 `v*` 标签推送到 Git，`.github/workflows/release.yml` 自动构建并发布 GitHub Release。

## 常规注意事项

- **必须 `export default HarmonyDevEcoService`**（继承自 dsh-git-manager/memory-manager 经验）：cordis loader 的 `unwrapExports` 取 `exports.default ?? exports`，ESM 命名空间对象不是合法 plugin，registry 报 `invalid plugin, expect function or object with an "apply" method, received object`，**整个 DSH 起不来**。node --check 与 self-test 都发现不了，只有真实 boot 才暴露。
- **必须导出 `TYPERT` 对象且 shape 严格**（实测）：dsh-typert-loader 的 `validateTypertManifest` 要求 `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[...], objects:[...]} }`。`events`/`objects` 必须是数组（哪怕空）；缺 `model.events` 报 `TYPERT.model.events must be an array`。invocation 的 parameters/result codec 必须 `mode:"strict"` 且 schema 是 zod v4 实例。
- **profile package.json 绝不能写 BOM**（大坑，实测）：DSH 的 `readProfileManifest` 直接 `JSON.parse` profile 的 `package.json`；任何 UTF-8 BOM 都会让它抛 `Unexpected token '﻿'` 崩溃——**整个 profile 起不来**。Windows PowerShell `Set-Content -Encoding UTF8` 默认带 BOM；改 `~/.dsh/profiles/web/package.json` 必须用无 BOM 编码（`.NET WriteAllText + UTF8Encoding(false)`，或 `dsh plugin add` 官方路径）。
- **Remote 返回值必须「网关 JSON-safe」**：可选字段**有值才挂 key**（`if (x !== undefined) out.x = x`），union 里的空值用 `false`/`""` 不要用 `null`；不可有循环引用或函数。self-test 跑真实 git/工具仓的返回值跑 strict schema + 等价 assertJsonSafe 复刻——**新增/修改 Remote 方法的返回结构必须过它**。
- **路径归一化**：Windows 路径用 `node:path.resolve` 归一化为反斜杠；用户粘贴带前导/尾随空格或引号时，`harmony-studio.normalizeStudioPath` 会清洗。
- **HiLog 流管理**：`_streams` Map 持有 `child`（spawn 进程）+ `buffer`（已解析的 hilog 行）；buffer 上限 5000 行防内存膨胀；`ctx.effect(() => () => killAll())` 在 plugin dispose 时清理。
- **ArkUI 窗口机制（实测）**：dump 里每个窗口以 `type:"WindowScene"`、`id:"session<NN>"` 开头，该 NN 就是 `devecocli ui window list` 报的 window id（`session11` ↔ id 11）；`parseUiLayoutJson` 据此给每个节点打 `windowId`，下后代继承。**客户端按 `windowId` 过滤，不要靠 `--window` 重抓**——实测 `--window 11`（桌面）返回空根（`[0,0,0,0]`），而 `--all-windows` 一次抓全再前端过滤才稳。
- **ArkUI 标注必须用 `origBounds`，`bounds` 只是可见区域（实测，重要）**：设备 dump 里 `bounds` 是**被滚动父容器裁剪、被其他窗口遮挡后**的可见矩形，`origBounds` 才是真实布局矩形。实测同一屏 328 个节点有 92 个两者不同，List 尤其严重：`ListItem bounds=[117,286][1216,515]`（可见切片仅 229px）而 `origBounds=[0,-1530][1216,515]`（真实高 2045px）。规则：**标注 overlay / 盒子模型 / 属性里的位置尺寸用 `origBounds`；tap 坐标用 `bounds` 的中心**（origBounds 可能整体在视口外）。
- **`origBounds` 只有设备端 dump 才有，devecocli 会过滤掉**：`devecocli ui layout` 只透传 `id/type/text/bounds/children/clickable/longClickable/scrollable/hitTestBehavior`，`origBounds` 与大部分属性（hostWindowId/zIndex/opacity/selected/checked/hierarchy…）全部丢失。所以 `uiDump` 改走 `hdc shell uitest dumpLayout -p <devicePath>` + `hdc file recv` + 读本地文件，用 `parseUiRawDump` 解析；**hdc 不可用时回退 devecocli**。成功判据是设备端那行 `DumpLayout saved`（hdc 失败也 exit 0）；带 `-t <serial>` 指定目标；结束后 `rm -f` 设备侧临时文件。
- **窗口必须固定选中一个（自动选前台），禁用「全部窗口」**（用户决策）：全部窗口渲染数量太多会卡顿。客户端窗口下拉**不提供「全部窗口」选项**，`useEffect` 自动选中 `uiWindowList` 里 `focused: true` 的窗口（前台窗口变化时跟随）；Host 侧 `uiDump` 未指定 `windowId` 时也**只抓前台窗口**（`allWindows:true` 保留为逃生舱）。注意 `uitest dumpLayout -w <id>` 对 **app 窗口不生效**（实测 `-w 826` 只回 1 个节点，`-w 31` 系统窗口才正常），所以 uitest 侧仍抓全量、由 Host 解析后按 `windowId` 过滤再返回。
- **两套 UI 树源，定位不同（用户决策）**：① **uitest 无障碍树**（`uiDump`）——**已发布应用**的通用选择，属性最全（origBounds/visible/enabled/…）；② **DevEco 开发调试源**（`uiDevEcoTree`）——**反编译 DevEco jar 复刻的同款链路**：`aa attach -b <pkg>`（每次连接前都执行，幂等）→ **全新端口** `hdc fport tcp:<p> ark:<pid>@<pkg>`（每次会话新建规则不复用，失败退 `localabstract:<pid><pkg>` 旧协议）→ **裸 socket WS**（极简 6 头握手！见下条）发 `connected`→`inspectorAbilities`→`tree` → 应用回 `{"type":"root",…}`（节点 `$type/$ID/$attrs/$rect/$children/viewTag/type`），**唯一带 padding/margin/border 声明值与 viewTag/label 组件名的源**。客户端「树源」下拉切换，**只抓当前树源**；该源按**应用**抓取（节点 windowId 全 0），窗口下拉禁用、不做窗口过滤。hidumper 通路（原 `uiInspectorDump`）已废弃删除（deveco 源全面取代）。
- **DevEco 调试源：WS 握手必须裸 socket 极简 6 头（2026-10 模拟器实测，大坑已破）**：应用侧 inspector 服务（ets_runtime ConnectServer/HttpHandShake）是**手写的极简 HTTP 解析器**，Node 自带 WebSocket（WHATWG）的握手头含 `sec-websocket-extensions: permessage-deflate`、`sec-fetch-mode`、`user-agent`、小写头名等，直接被判「**HTTP upgrade parameters failure**」秒拒（hilog 实证）——此前所有「WS error + 1006 秒拒」的真因就是它，不是 socket 缺失！**裸 socket 发 Java-WebSocket 风格恰好 6 个头**（GET /、Connection: Upgrade、Host、Sec-WebSocket-Key、Sec-WebSocket-Version: 13、Upgrade: websocket）一次通过（101），应用主动推 `addInstance` + `root`（186KB 真实树）。帧编解码手写（客户端帧必须 MASK）：`buildDevEcoWsHandshake`/`encodeWsClientTextFrame`/`decodeWsServerFrames`（harmony-device.mjs）。**仍然存在的边界**：应用侧 socket **单客户端**——DevEco Studio 的 Inspector 面板连着时会被占用（其 `ConnectServerSession` 200ms×20 自动重连），需先关掉面板；`hdc fport ls` 可查 IDE 建的规则（`tcp:15037 ark:<pid>@<pkg>` 等），`fport rm` 可踢；`track-jpid` 是 hdc **顶层命令**（不是 shell 命令）。真实树节点：`$rect` 是字符串 `"[l,t],[r,b]"`、盒模型值带 **vp/px 单位**（`"12.00vp"`）、margin 可为 JSON 字符串、borderRadius 是四角对象（取最大角）、Text 文本在 `$attrs.content`、Button 在 `$attrs.label`、开发者 `.id()` 在 `$attrs.id`、visibility 是枚举串。
- **uitest dumpLayout 的两种文档形态**：不带 `-i` 是**单个对象** `{attributes:{…},children:[…]}`（窗口已合并）；带 `-i` 是**数组**，每个窗口一个根元素。`parseUiRawDump` 两种都支持（先整体 `JSON.parse`，再退到括号切片）。属性值全是**字符串**（`"true"` / `"[l,t][r,b]"` / `"1.000000"`），需自行转换；窗口归属取每个节点的 `hostWindowId`（比 WindowScene 的 `session<NN>` 更可靠），缺失时回退 `session<NN>` 或 `hierarchy` 的 `ROOT<NN>` 前缀。
- **UI 树行标签：能提取组件名就显示组件名，否则显示真实类型（含 `__Common__`）**（用户确认的呈现规则）：ArkUI 工具链生成的 id 形如 **`组件名-实例_类型_字段`** / **`组件名_序号`**（实测 `SignalComponent-SignalOperatorInfo_Text_operator`、`ImageKnifePro_1447`、`StatusBarBackground_Row_0`、`BatteryComponent-batteryIcon_Image_batteryIcon`），**id 的第一段就是组件名**（`extractComponentName`：首段首字母大写者；snake_case/lowerCamel 是开发者 `.id()`，小写开头是 @Builder 插槽名 `left`/`center`/`right`）。呈现规则（用户三次纠正后确认）：**能提取组件名就只显示组件名**（`ImageKnifePro` 而非 `ImageKnifePro_1447`）+ 渲染类型作次要文字 + 「组件」徽标；**提取不到的 compid 照 DevEco 原样显示**（`left`、`linearGradient_bg`、`task_title`、`mainNavigationId`、`__badge__`……—— 只认大写开头会把 **53/81** 的名字丢掉，那正是"名字显示不出来"的原因）；再没有才显示真实类型名（含 `__Common__`）。**绝不显示编造的占位文案**（曾用「自定义组件」被否）、**不显示 id 字符串**。`#accessibilityId` 保留（与属性面板同值）。
- **`__Common__` 是工具链额外生成的包装节点（官方文档 + DevEco 源码双重确认）**：华为文档原文「**若设置通用属性或通用事件，编译工具链会额外生成节点 `__Common__`**」，实测每个恰好包一个子节点，id 常是**插槽名**（`left`/`center`/`right`/`rewardAd`）或为空。DevEco 的 ArkUI Inspector 源码（`plugins/openharmony/arkui-inspector/static/js/main.*.js`）证实其数据来自**应用侧 inspector 树**（`$type/$ID/$attrs/$rect/$children`），自定义组件判定是 **`$type === "JsView"`** 或 `type ∈ {"custom","build-in"}`，组件名取 **`viewTag` / `$attrs.label`**，图标用 `CustomisedComponent.svg`。**呈现规则（用户确认）**：`__Common__` 若能从 id 提取出组件名（如 `StatusBarBox`）就显示组件名；**提取不到就直接显示 `__Common__`（真实类型名），绝不编造占位文案**（曾用「自定义组件」被否）。DevEco 连的是 `ws://127.0.0.1:<port>/LayoutPlugin/<sid>`（命令 `getComponentJson` → `{content: 树}`），服务由 IDE 按需启动、需 debug 连接，第三方 release 应用外部无法复用。
- **ArkUI 盒子模型声明值：两条 dump 路永远没有，DevEco 调试源有（2026-10 穷尽核对 7 条路 + 反编译确认）**：① `uitest dumpLayout` 全部开关（v7.0.0.1，30 个属性；`-e` 仅接受 `uniqueId`；`-a` 只加字体，放兄弟节点 `extraAttrs:{extra:{…}}`，且与 `-i` 互斥）；② `devecocli ui layout` 三种 `--format` + `--id` 单节点 + `--mode full`（只比 simplified 多 `hitTestBehavior`）；③ 表格式 `--format default` 只有 bounds；④ `hidumper -ls` 服务表无 ArkUI/Ace 布局 dump；⑤ `devecocli serve mcp` 只有 LSP 工具（check/hover/definition…）无 UI 检查；⑥ `devecocli skills` 44 个技能全是代码/知识类；⑦ `uiRecord -W` 是事件 CSV 不是属性 dump。**返回样式声明值的外部通道只有 DevEco Studio ArkUI Inspector 的调试连接**（`UIContext.getFilteredInspectorTree` 是应用内 API，不算外部）——即 `uiDevEcoTree`。规则：**uitest 源下这三项显示「未提供」，绝不用 0 或内缩冒充**；deveco 源下显示 `$attrs` 声明值（`toBoxSides` 归一化：带 vp/px 单位字符串→数字、对象→逐边、JSON 字符串→解析、CSS 四值串→解析，非数字如 `"auto"` 放弃不造假；圆角四角对象取最大角）；所有源都提供**实测几何**：`contentBox`＝子节点矩形并集，与 `origBounds` 的差即实测内缩（容器未填满/滚动溢出时会偏大或越界，UI 据实标注「溢出」）。
- **自定义组件名从 id 提取（实测）**：ArkUI 给组件实例生成 id 且**第一段就是组件名**（`SignalComponent-SignalOperatorInfo_Text_operator` → `SignalComponent`；`ImageKnifePro_1447` → `ImageKnifePro`），而 `type` 只是渲染节点类型（`MyRow` → `Row`、`StatusBarBox` → `__Common__`）。判据 `extractComponentName`：首段首字母大写者才含组件名；snake_case（`tv_stock_name`/`icon_layout`）和 lowerCamel（`mainNavigationId`）是开发者 `.id('…')`，小写开头的（`left`/`center`/`right`）是 @Builder 插槽名。实测一屏 593 节点里 66 行可提取出 12 个组件名。
- **UI 树缩进不许封顶（实测深度可达 36 层，且 10 层以下的节点占多数）**：真机 dump 的 `depth` 分布一直延到 36，10 层以上的节点有 240+ 个。把缩进封顶在 10 层会把这 2/3 的节点全压平，表现就是「缩进消失」。正确做法：`INDENT_STEP=8 / INDENT_BASE=6` **线性缩进不封顶**（depth 36 = 294px），行 `min-width: max-content; white-space: nowrap`，容器 `.harm-tree2` `overflow: auto` 提供横向滚动（与 Chrome DevTools 一致）。两次不同的失败都不能再犯：① 无上限 12px/层导致内容溢出不可见；② 封顶 10 层导致层级被压平。
- **层级引导线用单个元素的 repeating-linear-gradient，不要每层一个 span**：旧实现按 depth 生成 N 个绝对定位 span，depth 36 的单行就是 36 个节点、整屏数千个 DOM；现为每行 1 个 `.harm-nodeGuides`（`left=INDENT_BASE` 对齐行左缘，`width=depth*INDENT_STEP`）。
- **ArkUI 高亮框必须用像素坐标，不要用百分比**：overlay 用 `%` 相对 `.harm-shotFrame`（inline-block 包裹 `max-height:100%` 的 img）解析，图片被限高时 frame 与 img 实际盒子不一致 → 蓝框偏移；点击命中却走 `getBoundingClientRect` 所以两者会分叉。现在 `useLayoutEffect` + `ResizeObserver` 量出 img 的**帧内偏移与渲染尺寸**，overlay 与 hit-test 共用同一份 `imgBox`，保证所见即所点。
- **hdc tconn 的三个坑（实测）**：① `hdc tconn <不可达 IP>` **不返回也不报错**，一直挂着直到被我们的超时杀掉，被杀进程**没有任何输出**（Windows 上 Node 报 `code=null`），所以 `_runHdc` 靠 `err.timedOut` 判定并回「连接超时」而非「无输出」；② 目标是已连接状态时 hdc 打印 **`[Info]Target is connected, repeat operation`**（不是 `Connect OK`），`parseTconnResult` 必须把 `[Info]`/`Target is connected` 当成功；③ `[Fail]...` 与成功都 **exit 0**，不能靠退出码判断成败。
- **Windows spawn 含空格路径（实测坑）**：`shell:true`（cmd.exe）不会自动给可执行路径加引号，`...\DevEco Studio\...` 这类路径会在第一个空格处截断导致启动失败。`spawnCollect` 对 shell 模式自行给 cmd 加引号；`execHdc`（真 .exe）一律 `shell:false` 交给 libuv 处理引号。
- **hdc 路径解析的 macOS：`.app` 包根要补 `/Contents`（主修复，用户纠正过）**：mac 上 DevEco Studio / Command Line Tools 常以 `.app` 包形态给出（Finder 复制出来只有 `/Applications/DevEco Studio.app`），而工具链根在其 `Contents/` 下——直接拼 `sdk/…` 必然落空。两层修复：`harmony-studio.normalizeStudioPath`（配置入口）与 `resolveHdc` 的 `cleanRoot`（解析时）都把以 `.app` 结尾的根补成 `<path>/Contents`；**兜底**是固定候选失败后在工具链根的 `sdk/`、`$DEVECO_SDK_HOME`、`~/Library/OpenHarmony`、`~/Library/Huawei` 里**限深扫描** hdc（限深 6、限 500 目录——覆盖 SDK Manager 下载到 `~/Library` 的版本号布局）。
- **CSS 用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`**：动态插件专属的 `styles.insert` 在这里不存在。
- **颜色一律 dsw token**：禁止硬编码 hex/rgba（亮/暗主题下必有一边翻车）。需要透明色用 `color-mix(in srgb, var(--dsw-...) 15%, transparent)`。
- **`Component.createElement` 必须 bundle 作用域定义**：内联创建（如 `() => React.createElement(...)` 返回值直接传给 slots.register）会每次 render 重新创建 component identity，导致 React 卸载并重建子树、丢失输入态。
- **sidebarRightTabs 不可用时跳过 tab/viewer 注册**（graceful degrade）：`ctx.inject(["sidebarRightTabs"], ...)` 回调里 `tabs === undefined` 直接返回；不影响 settings 与 Remote 通信。
- **兼容性 gate（0.2.0 实测）**：`dsh-app-boot` 的 `evaluatePluginCompatibility` 只检查 peerDependencies 中名字以 `@deepseek-ai/dsh` 开头的条目；`^0.2.0` **不匹配** `0.2.0-rc.2` 这类 prerelease（node-semver 只放行「同 tuple 且带预发布标签的比较符」匹配预发布版），范围要写 `^0.2.0-rc.1` 这类**预发布起点**形式，peers 与 `engines.dsh` 保持同步。不通过则插件在任何代码加载前被静默禁用。**支持范围只写 `^0.2.0-rc.1`（用户决策）**：本插件深度依赖 0.2.0 API（`sidebarRightTabs` / `settings.section` / `ctx.tools` / workspaceFiles），**0.1.x 连右侧边栏都没有，禁止声称支持**（曾误写 `^0.1.0-rc.7 || ^0.2.0-rc.1` 双段范围被用户纠正）。
- **codec 双形态（0.2.0 实测）**：TYPERT invocation 的 codec 对象必须同时带 `schema`（≤0.1.5 校验器读）与 `create: () => schema`（≥0.1.7 / 0.2.0 调 `codec.create()`）；只给 `schema` 会在 0.2.0 下挂掉。
- **`dsh.client.external` 已废弃**：0.2.0 无消费者，package.json 不再声明。
- **npm 发布必须 `--registry=https://registry.npmjs.org`**（本机默认 registry 被 npmmirror 覆盖）。
- **DSH sandbox EPERM 限制**：`node --test` 默认会 spawn 子进程跑测试文件，在 workspace-write 下会撞 EPERM。`npm test` 已配置 `--test-isolation=none` 绕过；CI 环境无此限制。
- **`npm test` 使用 `--test-isolation=none`**：因 DSH sandbox 在隔离子进程里禁止打开命名管道。如需更严格隔离，CI 环境去掉此标志。