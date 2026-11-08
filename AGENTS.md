# AGENTS.md — dsh-deveco

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）bundle 插件**：在 DSH Web UI 提供完整的 HarmonyOS 开发能力。

- **官方右侧边栏（`ctx.sidebarRightTabs`）注册两个页面 Tab**：
  - **HiLog 检查器**（id `dsh-deveco:hilog`，guide order 50）：实时日志流（**级别/包名/关键词过滤**——级别 chips 是进缓冲的门槛（读取环）；**关键词与包名是客户端实时视图过滤**：流跑着随时改随时生效、清空即回溯，包名经 `deviceProcessPids` 把 bundle 映射成 pid 集合后按行 pid 过滤；**日志内查找**：HiLog Tab 可见时接管 Ctrl/Cmd+F 弹出查找栏——当前视图内全部命中 `<mark>` 高亮 + 计数，Enter/↓/› 下一个、Shift+Enter/↑/‹ 上一个（循环）、Esc/× 关闭，当前命中行整行描边并平滑滚动定位，定位 effect 只 keyed on 查找状态不挂 lines（日志每秒追加不得拽回视图）），基于 `devecocli log --follow` 封装（未安装 devecocli 时自动降级 `hdc shell hilog`，见 §12）
  - **ArkUI Inspector**（id `dsh-deveco:arkui`，guide order 51）：**Chrome Elements 风格**——左侧设备截图（`uiScreenshot` 内联 dataUrl，点击截图命中节点并以**像素级 overlay** 按 `origBounds` 真实矩形高亮），右上 **可折叠** UI 树（层级引导线 + 自定义组件单独标注 + tap/scroll 标记 + 折叠全部/展开全部 + **树搜索**），右下节点属性（**全部设备原始属性** + **属性名/值搜索**）与盒子模型；顶部**窗口下拉**切换窗口；底部 Tap/Swipe/Text 操作
  - **Projects 数据面**：`listProjects` 识别 Host 工作目录中的 HarmonyOS 工程并保持紧凑 Remote 契约；完整工程模型走 agent 工具 `harmony_project`（当前无独立 Projects 图形页）
- **官方右侧边栏注册 `.ets` 文件查看器**（id `dsh-deveco:arkts`，`patterns: ["dsh-resource://file/**"]` + `canOpen` 按扩展名过滤，priority `extension` 优先于内置 text editor）。提供 ArkTS 语法高亮（关键字 + 装饰器 + 注释 + 字符串 + 数字）；内容经官方 `remote.workspaceFiles.read` 分页读取（绝对路径回退插件自有 `readTextFile` Remote）。
- **给对话里的 agent 提供工程模型与 ArkTS 运行时调试器**（`ctx.tools` 的 `harmony_project` / `harmony_debug`）：工程根/模块/Ability/权限/产物只读解析；调试支持 Hvigor Source Map 驱动的 `.ets` 源码断点与源码调用栈，底层通道＝`hdc fport ark:<pid>@Debugger` + 裸 socket 6 头 WS + CDP 风格 JSON-RPC，与 DevEco Studio 同款。**不重复造 devecocli 的轮子**：日志走 `devecocli log`，应用管理走 `devecocli device app`，UI 树走本插件的 `harmony_ui_tree`。
- **设置面板新增「HarmonyOS Suite」页**（`settings.section`，order 40），分「工具链」「设备管理」两区。工具链区管理 DevEco Studio 与 HarmonyOS Command Line Tools 路径（三平台自发现、Studio/CLT 互斥、CLT 最低版本 26.0.0 校验）；设备管理区含**设备列表**（USB/网络目标，网络 `ip:port` 目标可一键断开）与 **IP 网络连接**表单（`hdc tconn <ip>:<port>`）。

## 目录结构

```
dsh-deveco/
├── package.json              # ESM 双面包：dsh.bundle.patch + dsh.client.web + exports(., /client, /typert, /package.json)
├── index.js                  # Host 半：HarmonyDevEcoService（TypertRemoteService 子类，22 个 Remote 方法 + harmony_ui_tree/harmony_project/harmony_debug 注册）
├── client.js                 # Client 半：__ModuleLoader__ bundle（Tab + Viewer + Settings + Remote mount）
├── typert.host.js            # Typert Host manifest：harmonyDevEco Remote 服务全部 invocation 的 zod schema
├── harmony-studio.mjs        # 零依赖：工具链路径探测（devecocli > CLT ≥26.0.0 > Studio）+ 版本解析 + 三平台默认路径
├── harmony-config.mjs        # 零依赖：配置持久化 + Studio/CLT 互斥 + 自发现调度
├── harmony-device.mjs        # 零依赖：devecocli 进程封装 + hdc 降级命令（list targets / hilog / hidumper / uitest / screenCap）+ IP 连接（tconn）+ HiLog/ui-layout JSON 解析 + 裸 WS 帧编解码
├── harmony-tools.mjs         # 零依赖：调试器所需的设备命令构造/解析（bm dump 签名探测、aa appdebug/start/force-stop、ps -ef）+ 注入安全（shellQuote + 白名单正则）
├── harmony-debugger.mjs      # 零依赖：ArkTS 运行时调试器会话（裸 socket WS + CDP 风格 JSON-RPC；断点/暂停/单步/求值/属性；帧展示支持源码投影）
├── harmony-project.mjs       # JSON5：HarmonyOS 应用根发现、产品/模块/Ability/权限/依赖/产物模型；签名材料脱敏
├── harmony-source-map.mjs    # 零依赖：Hvigor Source Map v3 VLQ 解码、源码断点定位与调用栈反解
├── harmony-agent-tools.mjs   # agent 工具定义（harmony_project / harmony_debug），执行经 host 端口注入
├── cordis.patch.yml          # dsh bundle patch（挂载行）
├── scripts/self-test.mjs     # 138 个独立核心单元测试（含工程模型、Source Map 与源码断点/通知）
├── scripts/e2e-agent-tools.mjs  # 模拟器跑 agent 工程/调试工具的端到端探针（不依赖 DSH）
├── scripts/e2e-source-map.mjs   # 真实 Hvigor 工程 Source Map 双向映射探针（不依赖设备/DSH）
├── scripts/e2e-breakpoint-notify.mjs  # 断点通知链路端到端探针（假 ArkVM 服务端，不依赖设备/DSH）
├── scripts/extract-release-notes.mjs # 按发布标签提取 CHANGELOG 对应版本段落（缺失/重复/为空即失败）
├── docs/arkts-debug-recon.md        # ArkTS 调试协议与 Source Map 实测调研（每条结论带证据与置信度）
├── docs/recon-scripts/               # 调研用探针（arkts-debug-probe*.mjs、jar 常量池提取脚本）
├── .github/workflows/release.yml  # v* tag → 构建 + 发布 GitHub Release（正文取 CHANGELOG 对应版本）
├── CHANGELOG.md                # 版本变更记录与 GitHub Release 正文来源
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
- **设置导航图标（DSH 0.2.2-rc.1 起）**：新增 `settings.section.icon` slot 类型——插件以**与 `settings.section` 相同的 id** 注册图标组件，设置壳就用它替换通用齿轮：`ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'harmony-deveco', label: () => 'HarmonyOS Suite' }, HarmonySettingsNavIcon))`。壳把图标渲染进自己的 `span.navIcon` 装饰容器（`aria-hidden`），**外壳负责按钮、标签、容器，插件只画字形**；owner props 只有 `{ size: number, active: boolean }`。**只有 `id` 起作用**——图标组件的 `label` 不显示、`order` 对图标无意义（壳按 `only: row.id` 过滤图标账本），别照抄 section 的 `order` 免得误导读者。**旧壳（无此 slot）行为**：inject 回调永不触发（slot 由设置壳声明，老版本不声明），壳继续画齿轮——不报错、不重复图标，**无需 try/catch**。
  - **2026-11 修复（双图标 bug）**：0.2.0 的实现用 MutationObserver 给 nav 按钮打 `data-dsh-deveco-settings-nav` 标记 + CSS `[data-dsh-deveco-settings-nav]>svg:first-child{display:none}` 隐藏齿轮。0.2.2-rc.1 把齿轮挪进了 `span.navIcon`，`>svg:first-child` **匹配不到齿轮**（`>svg` 是 span 的子元素，不是 button 的），于是自定义图标与核心齿轮**同时显示**。现已删除整套 MutationObserver + CSS 补丁，改用官方 slot。**教训：DOM 形状类补丁对上游壳的 DOM 改动极其脆弱；上游一旦提供正式 API 就立即迁移并删掉 hack**（留着 hack 只会在新版壳上双图标）。
  - **图标字形规格**：与 `dsh-client-ui-primitives` 的 outline 图标一致——16×16 viewBox、`fill:none`、`stroke:currentColor`、`strokeWidth:1.3`（ICON_MEDIUM_STROKE）、`strokeLinecap/Linejoin:round`。`currentColor` 让它自动跟随 nav 行的 hover/active 颜色，无需自己写颜色变量。（规格从 **web-frontend 打包产物**核对：`dsh-web-frontend/dist/assets/index-*.js` 里 `ICON_MEDIUM_STROKE=1.3`、图标工厂 `viewBox:"0 0 16 16"` + `fill:"none"` + `stroke:"currentColor"`——primitives 本身没有以独立包形式装在 node_modules 里，只有打包产物。）
  - **版本下限**：自定义图标需要 **DSH ≥ 0.2.2-rc.1**（`settings.section.icon` 才有）；0.2.0 / 0.2.1 上 inject 永不触发 → 壳画通用齿轮（**功能不缺失，只是图标回退**，页面与工具链全部照常）。若要连 0.2.0/0.2.1 也保留手机图标，就得把整套 DOM 补丁留着——**不值得**：那个补丁正是双图标 bug 的成因，且它对上游壳的 DOM 形状零容错。
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

### 5. 22 个 Remote 方法

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
| `deviceProcessPids` | 解析包名→pid 集合：`hdc shell ps -ef` + Host 精确/`:后缀` 匹配（HiLog 行只有 pid 没有包名，客户端实时包名过滤靠它映射） |
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
| `listProjects` | 识别 Host cwd 中的鸿蒙应用根，按既有 schema 返回 `{name,path,bundleName,moduleCount}`；完整模型用 `harmony_project` |
| `readTextFile` | 读取 UTF-8 文本文件（2 MiB 截断），.ets 查看器绝对路径回退用 |

### 6. 工具链解析优先级（用户决策）

1. `PATH` 存在 `devecocli`（或 `DSH_DEVECO_CLI` 环境变量） → 优先使用，**忽略设置路径**
2. CLT 路径 ≥ `MIN_CLT_VERSION = [26, 0, 0]` → 用 CLT（与 Studio 互斥）
3. DevEco Studio 路径 → 兜底
4. 无 → `source: 'none'`，错误提示去设置

**但 `source` 不等于「devecocli 可用」**（2026-11 修复，用户报「未安装 devecocli 就没法用」的根因）：

- **`devecocli` 是独立的 npm 包 `@deveco/deveco-cli`，不随 DevEco Studio / Command Line Tools 安装**（本机 Studio 26.0.0.821 的 `bin/` 里没有它；devecocli 自己的 tool provider 也只解析 node/ohpm/hvigor/hdc，不解析 devecocli）。旧实现把 `source:'studio'|'clt'` 当成「有 CLI」，`devecoExec` 还会凭空拼 `<root>/bin/devecocli`，于是每次操作都 spawn ENOENT。
- `resolveCli` 现在对 studio/clt **探测** `<root>/bin/devecocli[.cmd|.exe]`：存在才填 `exec`、`cliAvailable:true`；否则 `cliAvailable:false` 并进入 hdc 降级。`source:'devecocli'`（PATH）恒为 true，`source:'none'` 恒为 false。
- `HarmonyDevEcoService._cliExec()` 再把一次 `existsSync`（任何 source 都验），确认「真的能 spawn」；**所有设备/UI 方法都先问 `_cliExec()`，为 null 就走 hdc 降级**（矩阵见 §12）。
- `getConfig().resolved` 额外带 `cliAvailable` / `hdcAvailable`，客户端据此显示「hdc 降级（未安装 devecocli）」徽章，而不是健康的「DevEco Studio」徽章。
- `_resolveHdcPath()` 现在把**设置里配置的** `studioPath`/`cltPath` 也加入 hdc 探测根：`source:'devecocli'` 时 `resolved.path` 为空，自定义安装目录（如 `D:\Application\Huawei\DevEco Studio`）否则永远找不到 hdc。

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

- **参数**：`device`（序列号，省略用默认目标）、`pid` / `package_name`（省略取前台窗口应用）、`format`（`tree` 缩进树文本＝默认 / `json` 完整节点 JSON）、`include_attrs`（附带全部原始属性，占篇幅，默认关）、`max_nodes`（默认 400、上限 4000）。截断**整棵子树省略，绝不发半棵**：被省略节点的最近保留祖先带 `childrenOmitted: true` + `hiddenDirect`（省略的直接子节点数），每个节点带 `childCount`（原始未裁剪树口径的直接子节点总数，Swiper/不可见/max_nodes 裁剪后均保持原值）——前端/agent 由此知道内部还有多少孩子；结构性裁剪也通过 `childrenOmitted`/`hiddenDirect` 标记，不得把被裁成叶子的节点误报成 `childCount:0`。
- **Swiper 裁剪（Inspector 与 agent 共用 `parseDevEcoTree`）**：`displayCount` 未配置按 1；未配置或 ≤1 时，仅 `currentIndex` 对应的直接子页面完整保留，非当前页若是 `TabContent` 最多保留两层（页根 + 直接子节点），其他类型只保留页根一层；`displayCount>1` 完全不做这套 Swiper 裁剪。不可见存根规则与 `max_nodes` 截断仍照常生效。
- **canonical 输出**（`output.schema` 严格校验）：`{ source:"deveco", pid, packageName, nodeCount, truncated, nodes[] }`，节点是 `devEcoNodeSummary` 的紧凑投影（展示名沿用 UI 标签规则：组件名→开发者 id→真实类型；声明值**有值才挂 key**）；`render` 把 nodes 投影成缩进树文本行（`devEcoTreeLines`），`format=json` 时输出完整 JSON。
- **注册模式**（Host `[Service.init]`）：动态 `import("@deepseek-ai/dsh-tools")` → `this._ctx.inject(["tools"], ...)` → `tools.register(buildHarmonyUiTreeTool(...))`，注册器返回的 disposer 用 `this._ctx.effect(() => off)` 挂到插件生命周期。**全链路 try/catch 优雅降级**：dsh-tools / ctx.tools 任一不可用就静默跳过，Remote/UI 面不受影响。`peerDependencies` 加 `@deepseek-ai/dsh-tools`（双段范围，过兼容性 gate）。
- **实现复用**：工具走 `service._fetchDevEcoTree()`（rich：nodes + source + pid + packageName）；Remote `uiDevEcoTree` 是它的薄包装（严格按 TYPERT 契约只回 `{nodes, source}`）。同一份取树链路两面共用。
- **边界同 DevEco 调试源**：需 debug 应用 + IDE Inspector 面板未占用（单客户端）；失败时抛错（registry 转 isError 文本），错误信息含全部前置条件指引。`isConcurrencySafe: true`（只读无共享状态，可并行）。

### 10. Agent 工程与调试工具面（v0.6.0 合并）

Host 经 `buildHarmonyAgentTools` 注册 `harmony_project` 与 `harmony_debug`：**命令构造/解析/工程模型/Source Map/会话状态机全在 `harmony-*.mjs` 模块里**，`index.js` 只提供 cwd 与设备传输（`host.hdc` / `host.shell` / `host.sessions`），因此可脱离 DSH 单测。工具默认工程路径优先取 `exec.agent.session.header.cwd`，显式 `path` / `project_path` 优先。

| 工具 | 动作 | 底层 |
|---|---|---|
| `harmony_project` | path 可为工程根或内部任意路径 | `harmony-project.mjs`：JSON5 配置 + 模块/产物模型，签名脱敏 |
| `harmony_debug` | attach / status / scripts / set_breakpoint / remove_breakpoint / breakpoints / pause / resume / step / run / stack / evaluate / properties / exceptions / events / notify / detach | **ArkTS 运行时调试器 + Hvigor Source Map**（见 §10.2 / §11） |

- **不重复造 devecocli 的轮子（用户决策）**：`devecocli log` 已覆盖日志（`--level/--keyword/--bundle-name/--tail/--format json/--follow`），`devecocli device app` 已覆盖 list/info/start/stop/install/uninstall（`device app info --format json` 里就有 `applicationInfo.appProvisionType`＝debug 签名判定），`devecocli ui layout` 覆盖布局树。**因此不提供 `harmony_hilog` / `harmony_app` 工具**——agent 直接跑 CLI 即可；插件只补 devecocli 没有的那块：**ArkTS 运行时调试器**。
- **工具描述里要点明分工**（`harmony_debug.description` 末段）：日志走 `devecocli log`、应用管理走 `devecocli device app`、UI 树走 `harmony_ui_tree`——避免 agent 在三处重复试探。
- **`harmony_debug` 需要的两个非 devecocli 事实**由工具内部自己解决：① **debug 签名判定**（`bm dump -n` → `applicationInfo.appProvisionType == "debug"`；stage 模型应用的 mainAbility 在 `hapModuleInfos[]` 里，**顶层没有 `mainElementName`**，2026-11 实测踩过）；② **wait-for-debugger 启动**（`aa appdebug` → `aa force-stop` → `aa start -D`）。

### 10.1 断点命中 → 自动通知 agent（v0.5.0 新增）

**需求**：应用停在断点时 agent 应当**知道**——否则只能轮询 `harmony_debug(action=status)` 才知道它停了。

**机制**（与 harness 自带的 `@deepseek-ai/dsh-tool-jobs`「后台任务完成→通知 agent」同构，是官方认可的模式）：

1. **拿到 agent**：`harmony_debug` 的 `execute(args, exec)` 里 `exec.agent` 就是**当前这次调用所属的 agent**（agent loop 调 `tools.execute({agent: this, …})` 时注入；`exec.agent.id` 就是 session id）。工具把它记到会话上（`session.ownerAgent` / `session.ownerSessionId`），此后任何一次 `harmony_debug` 动作都会刷新属主（谁最后在用调试器谁就是属主）。
2. **监听暂停**：会话上挂 `Debugger.paused` 监听（`installPauseNotifier`，幂等）。暂停发生 → 组装通知（`formatPauseNotification`：应用名/pid/设备、暂停原因、命中断点、暂停位置、**最多 8 帧调用栈**、下一步动作建议）→ 交给 Host 投递。
3. **投递**（`index.js` 的 `_notifyDebugAgent`）：经 `ctx.get("agents")` 取**活的** agent（`registry.get(agent.id)`；会话已销毁则丢弃）→ 构造 notice 消息（`createDebugNoticeMessage`：`{id: uuid, role:'user', content:[{type:'text',…}], source:{kind:'dsh-deveco-debug', form:'notice', summary}}`）→ **idle 用 `followup`（开新一轮），running 用 `inject`（塞进下一步，不打断当前轮）**。
4. **抑制重复**：自己触发的暂停（attach 入口暂停、`action=pause`、`action=step`）已经由工具结果内联回报，**不再推送**——靠会话上的「期望暂停」计数器（`noteExpectedPause`/`consumeExpectedPause`，带 TTL，用完即清）。
5. **防死循环**：连续唤醒预算 `DEBUG_MAX_CONSECUTIVE_WAKES = 3`——超预算后只入队不唤醒（决策函数 `decideDebugNoticeDelivery`，纯函数可单测）。预算在**人类发言**（`agent/inbox/claimed` 且 `message.source.kind === 'user'`）或**agent 又用了调试器**（`host.noteAgentActivity`）时清零。
6. **可关闭**：`harmony_debug(action=notify, enabled=false)` 关闭本会话的自动通知；`attach(notify=false)` 同样。

**关键坑**：

- **`@deepseek-ai/dsh-llm` 不是本插件的依赖**（`createUserMessage` 用不到），所以 notice 消息**自己拼**（uuid + role + content + source）——与 `createUserMessage` 的产物形状一致（`brandString` 是运行时空操作）。
- **消息 source kind 是插件自定义的**（`'dsh-deveco-debug'`）：harness 的 `MessageSourceMap` 是**可扩展联合**（各生产者声明自己的 kind，客户端对未知 kind 走 default 分支＝普通「请求」触发器，不会渲染坏）。
- **不要用 `exec.deferContext`**：它只在**这次工具调用结束前**有效，而断点命中发生在调用之外（甚至 agent 空闲时）。异步通知只能走 agent 的 inbox（`followup`/`inject`）。
- **「已内联回报的暂停」不能重复推送**（2026-11-07 真机踩坑）：抑制机制有三层，缺一不可——① **期望暂停**（`noteExpectedPause`/`consumeExpectedPause`）带**原因限定**：`attach` 的期望只匹配启动类原因，绝不吞掉真正的断点命中；**attach 之后不要无条件 `clearExpectedPauses()`**——`waitForEntry` 一收到首个 `scriptParsed` 就返回，入口暂停可能**在它之后**才到，blanket clear 会让它漏网。② **启动类原因噪音过滤**（`isStartupPause`，见 §11）。③ **`markPauseReportedInline()`**：工具结果里已经带上的那一次暂停，给 `session.paused` 快照打标记（快照每次事件都是新对象 → 标记精确到那一次），通知器直接跳过。
- **`resume` 只能清「自己那一份」暂停快照**：`session.paused = null` 会把 resume **之后**新到的暂停一起抹掉——于是「通知到了但 `stack` 说当前未暂停」。改成 `if (session.paused === before) session.paused = null`（比对对象身份）。
- **`ctx.get("agents")` 不是 `ctx.agents`**：插件没 inject `agents` 服务，直接取属性拿不到；`ctx.get(name)` 才是「有就用、没有就 undefined」的写法。


### 10.2 `.ets` 源码断点与 Source Map（v0.6.0 新增）

- **真实映射，不猜行号**：Hvigor 的 `sourceMaps.json` / `sourceMaps.map` 是以 ArkVM `scriptParsed.url` 为 key 的 Source Map v3 字典；`harmony-source-map.mjs` 解码 VLQ `mappings`，不用固定偏移。真实回归样本：`Index.ets:296` → 编译 0 基 `339:4`（文件第 340 行），反向仍回 `.ets:296`。
- **发现顺序**：优先 `<module>/build/<product>/cache/<target>/default@CompileArkTS/esmodule/<debug|release>/sourceMaps.json`；缺失才回退 `intermediates/source_map`、`loader_out`、`outputs/.../mapping`。有模式专属 cache 时不重复读中间副本。
- **参数坐标严格分离**：源码 `source_path` + **1 基** `source_line/source_column`；兼容编译 `url` + **0 基** `line/column`。精确源码行优先；无精确映射才移到下一可执行行，并在结果/message 里报告实际行。多个 URL 有候选且没有已加载脚本可消歧时直接报错。
- **过期保护**：源文件 mtime 新于所选 Source Map 时拒绝设源码断点，提示先 build/run。没有 map、JSON 损坏、超过 32 MiB 都明确警告/报错。
- **会话级索引**：attach 时按当前 agent workspace/project_path 加载，保存在 `session.sourceMaps`；通知回调不做异步 I/O，直接同步映射当前帧。`attach/status/pause/step/stack` 与自动通知共享同一投影，帧保留原 `url/lineNumber/columnNumber` 并增加 `sourcePath/sourceLine/sourceColumn`。

### 11. ArkTS 运行时调试器（实测链路，docs/arkts-debug-recon.md 有完整证据）

- **通道**：`hdc fport tcp:<本地端口> ark:<pid>@Debugger` → **裸 socket 6 头 WS 握手**（`GET /` + Connection/Host/Sec-WebSocket-Key/Sec-WebSocket-Version/Upgrade，与 ArkUI Inspector **同一套**握手，复用 `harmony-device.mjs` 的 `buildDevEcoWsHandshake`/`encodeWsClientTextFrame`/`encodeWsPongFrame`/`decodeWsServerFrames`）→ **CDP 风格 JSON-RPC**（`{id,method,params}`/`{id,result}`，事件无 id）。
- **`ark:<pid>@<包名>` 是 Inspector 通道，`ark:<pid>@Debugger` 才是调试器**（混用会连上另一套协议）。hdc 内建帮助只写三段式 `ark:pid@tid@Debugger`，**两段式实测可用**。清理只用 `hdc fport rm tcp:<p> ark:<pid>@Debugger`（`--remove` 无效且会漏规则）。
- **错误不是 JSON-RPC error，而是 `result.code` / `result.message`**（如 `{"result":{"code":1,"message":"Can only perform operation while paused"}}`）——判定成功必须看 `result.code === undefined`（`isDebuggerError`）。
- **不支持**：`Runtime.evaluate`（`unknown method`）、`Debugger.getStackTrace`（`Unknown method`）、`Debugger.getScriptSource`（`not supported`）。所以**求值必须走 `Debugger.evaluateOnCallFrame`（仅暂停态）**，调用栈取 `Debugger.paused.callFrames`，源码读本地工程文件。
- **断点**：`url` 必须**逐字等于** `scriptParsed.url`（形态 `entry|<pkg/lib>|<version>|<工程内相对路径>`，用 `|` 分段），否则 `Unknown file name.`；行/列 **0 基**；`breakpointId` 形如 `id:<line>:<col>:<url>`；`scriptId` **每次连接重编号**，断点表按 url 存。Panda 系 `getPossibleAndSetBreakpointByUrl` 只接受 `{"locations":[{url,lineNumber,columnNumber}]}`（回 `id:"invalid"`＝该 url 暂无脚本可落点）。
- **实测可复现流程（唯一能拿到活的调试实例的方式）**：`aa appdebug -b <bundle>` → `aa force-stop <bundle>` → `aa start -a <ability> -b <bundle>` → 取 pid → `hdc fport` → 握手 → `Runtime.enable` + `Debugger.enable` → **`Runtime.runIfWaitingForDebugger`**（**关键**：放行等待调试器的应用后 runtime 才注册脚本并发出入口 `Debugger.paused`「Break on start」；不发明这条消息就是"空会话"：无 scriptParsed、pause 不触发）→ 之后 `Debugger.scriptParsed` 陆续到达。
- **单客户端**：同一 ark 目标并发第二条 WS **连 101 都拿不到**（静默挂起）——握手必须带超时（6s），超时报"被 DevEco/其它会话占用"。
- **求值实测**：`evaluateOnCallFrame("1+1")` 在入口暂停帧返回 `{"type":"undefined"}`（入口帧无局部变量），`globalThis` 返回带 `objectId` 的对象；**别把 undefined 当失败**。
- **ArkVM 对**每个加载的模块**都发一次 `Debugger.paused`（reason="Break on start"）**（2026-11-07 真机实测：`com.dukedsh.remotecontrol` attach 后依次收到 `scriptParsed` → `paused(Break on start)` → `resume` → `scriptParsed` → `paused(Break on start @ hrouter|hrouter|2.0.0|src/main/ets/api/ModuleLoader.ts:8)`——第二次是**库模块**的初始化暂停）。**这些启动类暂停是噪音**：入口那次由 attach 结果内联回报，库模块那些与 agent 的断点无关。规则：**reason 属于 `STARTUP_PAUSE_REASONS`（break on start / on start / on entry / entry / startup）的暂停一律不推送**；通知只关心 `break`（断点命中）、`exception`（异常）等。
- **ArkVM 对**每一个新加载的脚本**都发一次 `Debugger.paused(reason="Break on start")`**（2026-11-07 模拟器实测：远程控制 app 一次加载 **55 个脚本 = 55 次启动暂停**；不处理的话 app 永远卡在启动页，agent 要 resume 55 次才跑得起来）。**解法：`Debugger.setSkipAllPauses {skip:true}`**——必须在 `Runtime.runIfWaitingForDebugger` **之前**下发，实测 `scriptParsed=55 / paused=0`，app 一次跑完。**这个开关是 app 进程级状态**：上一轮会话开过 skip，同一个 app 再 attach 就会一直不暂停，所以「不跳过」必须**显式**下发一次 `skip:false`。插件侧：`attach` 默认 `skip_pauses=true`；`set_breakpoint`/`pause`/`step` 会先 `ensurePausesEnabled()` 再动作（跳过期间断点不命中）；另有独立动作 `skip_pauses` 手动开关。
- **底层 `url` 断点的行号仍是编译产物 0 基坐标，不是 .ets 源码行号**（2026-11-07 实测踩坑：源码 `onCreateSession` 在 296 行，编译后在 **340** 行；按源码行号直接设底层断点 → `id:"invalid"` 或永不命中）。现在 agent 应用 §10.2 的 1 基 `source_path/source_line/source_column` 经真实 Source Map 转换；只有诊断底层协议时才直接用 `url/line/column`。编译产物在 `app/entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/...`。runtime 上报的 url 形态 `<moduleName>|<moduleName>|<version>|<工程内相对路径>`——**第二段是模块名不是 bundle 名**，扩展名是 **`.ts`**。
- **断点命中的 `paused.reason` 是 `other`，不是 `break`**（实测 `paused reason=other @ entry|entry|1.0.0|src/main/ets/pages/Index.ts:341`）。通知文案要把「other + 有 hitBreakpoints」翻译成「断点命中」，别把 `other` 原样甩给 agent。
- **会话生命周期**：`index.js` 持有 `this._debugSessions`（pid → session），插件 dispose 时逐个 `close()` 并 `fport rm`（**漏规则会挡住下一次 attach**）。同一 pid 重复 attach 复用会话；多会话时工具要求显式给 `pid`。
- **端口**：`pickFreePort()` 取空闲端口；`hdc fport` 回 `[Fail]TCP Port listen failed at <p>` 说明端口被占（残留规则/别的会话），**换端口重试**（最多 3 次）而不是连进别人的端口。

### 12. devecocli 缺失时的 hdc 降级矩阵（2026-11 修复）

**背景**：`devecocli` 是独立 npm 包（`@deveco/deveco-cli`），用户只装 DevEco Studio / Command Line Tools 时**没有它**。旧实现里以下能力全部只走 CLI → 未安装时插件"看起来什么都没法用"。现在每个能力都有 hdc 等价实现（命令均取自 devecocli 自己的实现，见 `@deveco/deveco-cli-common/dist/cli.js`）：

| 能力 | 首选（有 devecocli） | 降级（hdc，SDK 自带） |
|---|---|---|
| 设备列表 | `devecocli device list --format json` | `hdc list targets`（`parseHdcTargets`；跳过 `[Empty]`/unauthorized） |
| 设备详情 | `devecocli device view -t <s>` | `hdc -t <s> shell param get const.*`（`HDC_DEVICE_PARAM_KEYS`） |
| 历史日志 | `devecocli log … --tail` | `hdc -t <s> shell hilog -x`（`-L`/`-e`；tail 在 Host 侧切） |
| 实时日志 | `devecocli log --follow` | `hdc -t <s> shell hilog`（客户端仍做关键词/包名/级别视图过滤） |
| 窗口列表 | `devecocli ui window list --format json` | `hdc -t <s> shell hidumper -s WindowManagerService -a -a`（`parseWindowManagerDump`，按 `Focus window:` 标 focused、`type===1` 为应用窗口） |
| 截图 | `devecocli ui screenshot --path` | `hdc … shell uitest screenCap -p <p>`，失败退 `snapshot_display -f <p>`，再 `hdc file recv` |
| Tap/Swipe/Text | `devecocli ui click/swipe/text` | `hdc … shell uitest uiInput click/swipe/text`（text 用 `quoteDeviceShellArg` 单引号转义） |
| UI 树（无障碍） | `devecocli ui layout`（hdc 不可用时） | `hdc shell uitest dumpLayout -p` + `file recv`（本来就是首选） |
| DevEco 调试树 / 调试器 / IP 连接 / pid 映射 | — | 本来就只走 hdc |

**关键约定**：

- **绝不再凭空拼 CLI 路径**：`_cliExec()` 对 `devecoExec(resolved)` 的结果做 `existsSync`，为 `null` 就走 hdc；`resolveCli` 的 `cliAvailable` 是"探测结果"，不是"配置了 Studio 就算有"。
- **hdc 也没有时**才返回 `no-toolchain`，错误信息同时给出两条路：安装 devecocli，或配置 Studio/CLT 路径（hdc 随 SDK）。
- **`uiDump` 的降级顺序**：hdc dump 优先（有 `origBounds`）；hdc 失败且有 CLI → `devecocli ui layout`；两者都没有 → `dump-failed`（不再误报 `no-toolchain`）。
- **`hdc … shell hilog` 的 `[Fail]` 检测**：hdc 失败也 exit 0。流在 close 时若从未产出过解析行且原始输出含 `[Fail]`，把该行写进 `stream.error`，客户端显示并停止"等待日志…"。
- **窗口下拉必须能降级**：客户端只有在 `windowId` 有值时才渲染树；若 `uiWindowList` 失败则 `windowId=""`，即使 `uiDump` 成功树也是空的——`hidumper` 兜底因此是 Inspector 可用性的必要条件，不能省。
- **`_capabilities()` / `resolved.cliAvailable` / `resolved.hdcAvailable`** 会随 `getConfig` 返回：客户端徽章显示「hdc 降级（未安装 devecocli）」，设备列表失败时把错误显示在 Tab 里（不再静默空下拉）。
- **所有新增 hdc 命令构造/解析放 `harmony-device.mjs` 纯函数**（`buildHdc*` / `parseHdcTargets` / `parseWindowManagerDump`），`index.js` 只做选择与执行；新增能力必须同时补 `scripts/self-test.mjs` 的命令串断言。

## 开发 / 验证

```bash
npm run check              # 全部 JS 语法检查（含工程模型/Source Map/e2e 模块）
npm test                   # 138 个单元测试（含 JSON5 工程模型、签名脱敏、VLQ、双向映射、过期保护、源码断点与通知）
node scripts/e2e-source-map.mjs --project <root> --source entry/src/main/ets/pages/Index.ets --line 296  # 真实 Hvigor Source Map 双向验证（不依赖设备/DSH）
node scripts/e2e-agent-tools.mjs --device 127.0.0.1:5555 --bundle <pkg> --project <root> --source entry/src/main/ets/pages/Index.ets --source-line 296 --attach   # 模拟器跑工程 + 源码断点工具（不依赖 DSH）
npm run e2e:notify             # 断点通知链路端到端（**不依赖设备**：假 ArkVM 服务端 + 真会话 + 真工具 + 真 Host 投递）
node docs/recon-scripts/arkts-debug-probe-skip.mjs --bundle <pkg>    # 探针：setSkipAllPauses 能不能压掉逐脚本启动暂停
node docs/recon-scripts/arkts-debug-probe-break.mjs --bundle <pkg>   # 探针：skip=false 后断点是否仍命中（配 devecocli ui click 触发）
dsh plugin --profile web add .   # 本地安装/重装
```

**改插件后必须重启 DSH** 生效（Host 加载、typert 注册、client bundle 注入都在启动时发生）。

端到端验证清单：
1. 设置 → 侧栏导航出现 **HarmonyOS Suite**（图标：手机，smartphone，16px `currentColor`；**只出现这一个图标**——壳的通用齿轮不应同时出现，出现即为双图标回归）
2. 打开 HarmonyOS Suite 设置页：能看到「未配置」状态徽章（红色 err）
3. 输入一个 CLT 路径（含版本号如 `26.0.0`）→ 点「应用」→ **装了 devecocli 时**徽章变绿；**只装了 CLT/Studio、没装 devecocli 时**徽章显示「hdc 降级（未安装 devecocli）」（info 色，不是错误）——这正是本次修复的默认形态
4. 设置面板的「HarmonyOS Suite」页 → 验证「DevEco Studio 路径」「HarmonyOS Command Line Tools 路径」互斥（应用 CLT 清空 Studio，反之亦然）
5. 官方右侧边栏 Guide 菜单看到「HiLog 检查器」「ArkUI Inspector」两个入口 → 各打开 Tab
6. HiLog Tab：选设备（先点「刷新设备」）→「开始」→ 日志流出现；**流跑着直接改过滤即时生效**：点击级别 chip、输入关键词（message/tag/domain/pid 不区分大小写子串）、输入包名（防抖 500ms 经 `deviceProcessPids` 解析 pid 集合后按行 pid 过滤；主进程 + `:render` 等后缀进程全收）→ 顶部出现「显示 M / N 行」计数；清空关键词/包名后已缓冲的行**立即全部回来**（视图过滤不丢历史）；包名未运行时提示「未找到运行进程」；**Ctrl+F**（HiLog Tab 可见时）→ 弹出查找栏 → 输入即高亮全部命中 + `n/N` 计数 → Enter/› 循环跳转（当前行描边+滚动跟随）→ Shift+Enter/‹ 反向 → Esc 关闭；切到其他 Tab 后 Ctrl+F 不被本插件接管
7. ArkUI Tab：「Dump UI」→ **自动截图 + 当前树源的 UI 树** → 顶部**「树源」下拉**两选一切换即重抓（DevEco 调试源＝应用侧 ark socket，带盒模型声明值与组件名，窗口下拉此时禁用——该源按应用抓取；无障碍树＝uitest，适合已发布应用）、**「窗口」下拉**（**自动选中前台窗口**、**无「全部窗口」选项**，切换即重抓）→ 树上**折叠/展开**、层级引导线（**线性缩进不封顶**）、**名字为主标签**（能提取组件名就只显示组件名，如 `ImageKnifePro`；提取不到的 compid 照 DevEco 原样显示，如 `mainNavigationId`/`tab_0`；再没有显示真实类型含 `__Common__`，不显示 id、不编造占位文案）、`#accessibilityId` 标识、**「仅组件」过滤**、**树搜索框**（输入即筛：匹配 componentName/devId/className/text，`#数字`＝accessibilityId；只显示命中行+祖先链、命中片段 `<mark>` 高亮、命中字段不在行上可见时补显小字；Enter/↓/› 下一个、Shift+Enter/↑/‹ 上一个、Esc/「清除」退出并**还原原折叠状态**；当前命中行自动成为选中节点——属性面板/截图蓝框联动；与「仅组件」叠加时候选收窄、祖先链不变；搜索中点截图命中的非匹配行也经选中路径保留可见；重新 Dump/切源/切窗口后 query 保留、光标回首个命中） → 点节点或**点截图**（树自动展开并滚动定位）→ 蓝框高亮 → 属性面板**搜索框**过滤、列出**全部设备原始属性** → 盒子模型显示**组件区域 / 内容区域 / 四边内缩实测值**；padding/margin/border/圆角在 DevEco 调试源下显示**声明值**，uitest 源显示「未提供」
8. 打开任意 `.ets` 文件 → ArkTS 高亮查看器打开（文件名作为 tab 标题）
9. 工程与源码调试：调用 `harmony_project` 能返回应用/模块/Ability/权限且不含签名材料；有 map 时 `harmony_debug` 用 `source_path + source_line` 返回源码断点，暂停通知/stack 显示 `.ets` 并保留编译坐标
10. 设置页「设备管理」区：设备列表出现（或空态文案）→ IP 连接后列表出现「网络」徽章的 ip:port 目标 → 点行内「断开」→ 列表自动刷新

## 发布

1. 更新 `package.json` 版本，并在 `CHANGELOG.md` 添加唯一的 `## [X.Y.Z] - YYYY-MM-DD` 段落；Release 正文就是该段落到下一个二级标题之间的内容。
2. 本地预览：`node scripts/extract-release-notes.mjs vX.Y.Z`。标签找不到版本、版本重复或段落为空时脚本会失败，CI 不再回退到静态旧模板。
3. 打 `v*` 标签推送到 Git，`.github/workflows/release.yml` 自动检查、构建、发布 npm，并用 `body_path` 读取提取出的版本说明发布 GitHub Release。

## 常规注意事项

- **必须 `export default HarmonyDevEcoService`**（继承自 dsh-git-manager/memory-manager 经验）：cordis loader 的 `unwrapExports` 取 `exports.default ?? exports`，ESM 命名空间对象不是合法 plugin，registry 报 `invalid plugin, expect function or object with an "apply" method, received object`，**整个 DSH 起不来**。node --check 与 self-test 都发现不了，只有真实 boot 才暴露。
- **必须导出 `TYPERT` 对象且 shape 严格**（实测）：dsh-typert-loader 的 `validateTypertManifest` 要求 `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[...], objects:[...]} }`。`events`/`objects` 必须是数组（哪怕空）；缺 `model.events` 报 `TYPERT.model.events must be an array`。invocation 的 parameters/result codec 必须 `mode:"strict"` 且 schema 是 zod v4 实例。
- **profile package.json 绝不能写 BOM**（大坑，实测）：DSH 的 `readProfileManifest` 直接 `JSON.parse` profile 的 `package.json`；任何 UTF-8 BOM 都会让它抛 `Unexpected token '﻿'` 崩溃——**整个 profile 起不来**。Windows PowerShell `Set-Content -Encoding UTF8` 默认带 BOM；改 `~/.dsh/profiles/web/package.json` 必须用无 BOM 编码（`.NET WriteAllText + UTF8Encoding(false)`，或 `dsh plugin add` 官方路径）。
- **Remote 返回值必须「网关 JSON-safe」**：可选字段**有值才挂 key**（`if (x !== undefined) out.x = x`），union 里的空值用 `false`/`""` 不要用 `null`；不可有循环引用或函数。self-test 跑真实 git/工具仓的返回值跑 strict schema + 等价 assertJsonSafe 复刻——**新增/修改 Remote 方法的返回结构必须过它**。
- **路径归一化**：Windows 路径用 `node:path.resolve` 归一化为反斜杠；用户粘贴带前导/尾随空格或引号时，`harmony-studio.normalizeStudioPath` 会清洗。
- **HiLog 流管理**：`_streams` Map 持有 `child`（spawn 进程）+ `buffer`（已解析的 hilog 行）；buffer 上限 5000 行防内存膨胀；`ctx.effect(() => () => killAll())` 在 plugin dispose 时清理。
- **HiLog 过滤语义（2026-10 真机实测，防再犯）**：devecocli 的 `--keyword`/`--bundle-name` 在 `--follow` 下**其实是生效的**（实测 keyword `com`/中文都正确过滤，底层翻译成 `hilog -e '<kw>'` / `-P <pid>`）——用户报「不生效」的真因是**过滤参数只在 spawn 时快照一次**，流跑起来后改输入框毫无反应。修复（用户决策）：**关键词/包名改为纯客户端实时视图过滤**（流照常全量接收，缓冲不丢历史，输入即筛、清空即回溯；包名经 `deviceProcessPids` 把 bundle 映射成 pid 集合按行 pid 过滤，精确匹配 + `:` 后缀进程，点分名如 `x.backup` 不算同包）；UI **不再**向 `hilogStreamStart` 传 keyword/bundle（服务端预滤会让未命中的行永远到不了缓冲，破坏可回溯性）；级别 chips 维持读取环过滤（进缓冲门槛，防 D 级刷屏挤掉 IWE）。
- **ArkUI 窗口机制（实测）**：dump 里每个窗口以 `type:"WindowScene"`、`id:"session<NN>"` 开头，该 NN 就是 `devecocli ui window list` 报的 window id（`session11` ↔ id 11）；`parseUiLayoutJson` 据此给每个节点打 `windowId`，下后代继承。**客户端按 `windowId` 过滤，不要靠 `--window` 重抓**——实测 `--window 11`（桌面）返回空根（`[0,0,0,0]`），而 `--all-windows` 一次抓全再前端过滤才稳。
- **ArkUI 标注必须用 `origBounds`，`bounds` 只是可见区域（实测，重要）**：设备 dump 里 `bounds` 是**被滚动父容器裁剪、被其他窗口遮挡后**的可见矩形，`origBounds` 才是真实布局矩形。实测同一屏 328 个节点有 92 个两者不同，List 尤其严重：`ListItem bounds=[117,286][1216,515]`（可见切片仅 229px）而 `origBounds=[0,-1530][1216,515]`（真实高 2045px）。规则：**标注 overlay / 盒子模型 / 属性里的位置尺寸用 `origBounds`；tap 坐标用 `bounds` 的中心**（origBounds 可能整体在视口外）。
- **`origBounds` 只有设备端 dump 才有，devecocli 会过滤掉**：`devecocli ui layout` 只透传 `id/type/text/bounds/children/clickable/longClickable/scrollable/hitTestBehavior`，`origBounds` 与大部分属性（hostWindowId/zIndex/opacity/selected/checked/hierarchy…）全部丢失。所以 `uiDump` 改走 `hdc shell uitest dumpLayout -p <devicePath>` + `hdc file recv` + 读本地文件，用 `parseUiRawDump` 解析；**hdc 不可用时回退 devecocli**。成功判据是设备端那行 `DumpLayout saved`（hdc 失败也 exit 0）；带 `-t <serial>` 指定目标；结束后 `rm -f` 设备侧临时文件。
- **窗口必须固定选中一个（自动选前台），禁用「全部窗口」**（用户决策）：全部窗口渲染数量太多会卡顿。客户端窗口下拉**不提供「全部窗口」选项**，`useEffect` 自动选中 `uiWindowList` 里 `focused: true` 的窗口（前台窗口变化时跟随）；Host 侧 `uiDump` 未指定 `windowId` 时也**只抓前台窗口**（`allWindows:true` 保留为逃生舱）。注意 `uitest dumpLayout -w <id>` 对 **app 窗口不生效**（实测 `-w 826` 只回 1 个节点，`-w 31` 系统窗口才正常），所以 uitest 侧仍抓全量、由 Host 解析后按 `windowId` 过滤再返回。
- **两套 UI 树源，定位不同（用户决策）**：① **uitest 无障碍树**（`uiDump`）——**已发布应用**的通用选择，属性最全（origBounds/visible/enabled/…）；② **DevEco 开发调试源**（`uiDevEcoTree`）——**反编译 DevEco jar 复刻的同款链路**：`aa attach -b <pkg>`（每次连接前都执行，幂等）→ **全新端口** `hdc fport tcp:<p> ark:<pid>@<pkg>`（每次会话新建规则不复用，失败退 `localabstract:<pid><pkg>` 旧协议）→ **裸 socket WS**（极简 6 头握手！见下条）发 `connected`→`inspectorAbilities`→`tree` → 应用回 `{"type":"root",…}`（节点 `$type/$ID/$attrs/$rect/$children/viewTag/type`），**唯一带 padding/margin/border 声明值与 viewTag/label 组件名的源**。客户端「树源」下拉切换，**只抓当前树源**；该源按**应用**抓取（节点 windowId 全 0），窗口下拉禁用、不做窗口过滤。hidumper 通路（原 `uiInspectorDump`）已废弃删除（deveco 源全面取代）。
- **DevEco 调试源：WS 握手必须裸 socket 极简 6 头（2026-10 模拟器实测，大坑已破）**：应用侧 inspector 服务（ets_runtime ConnectServer/HttpHandShake）是**手写的极简 HTTP 解析器**，Node 自带 WebSocket（WHATWG）的握手头含 `sec-websocket-extensions: permessage-deflate`、`sec-fetch-mode`、`user-agent`、小写头名等，直接被判「**HTTP upgrade parameters failure**」秒拒（hilog 实证）——此前所有「WS error + 1006 秒拒」的真因就是它，不是 socket 缺失！**裸 socket 发 Java-WebSocket 风格恰好 6 个头**（GET /、Connection: Upgrade、Host、Sec-WebSocket-Key、Sec-WebSocket-Version: 13、Upgrade: websocket）一次通过（101），应用主动推 `addInstance` + `root`（186KB 真实树）。帧编解码手写（客户端帧必须 MASK）：`buildDevEcoWsHandshake`/`encodeWsClientTextFrame`/`decodeWsServerFrames`（harmony-device.mjs）。**仍然存在的边界**：应用侧 socket **单客户端**——DevEco Studio 的 Inspector 面板连着时会被占用（其 `ConnectServerSession` 200ms×20 自动重连），需先关掉面板；`hdc fport ls` 可查 IDE 建的规则（`tcp:15037 ark:<pid>@<pkg>` 等），`fport rm` 可踢；`track-jpid` 是 hdc **顶层命令**（不是 shell 命令）。真实树节点：`$rect` 是字符串 `"[l,t],[r,b]"`、盒模型值带 **vp/px 单位**（`"12.00vp"`）、margin 可为 JSON 字符串、borderRadius 是四角对象（取最大角）、Text 文本在 `$attrs.content`、Button 在 `$attrs.label`、开发者 `.id()` 在 `$attrs.id`、visibility 是枚举串。
- **uitest dumpLayout 的两种文档形态**：不带 `-i` 是**单个对象** `{attributes:{…},children:[…]}`（窗口已合并）；带 `-i` 是**数组**，每个窗口一个根元素。`parseUiRawDump` 两种都支持（先整体 `JSON.parse`，再退到括号切片）。属性值全是**字符串**（`"true"` / `"[l,t][r,b]"` / `"1.000000"`），需自行转换；窗口归属取每个节点的 `hostWindowId`（比 WindowScene 的 `session<NN>` 更可靠），缺失时回退 `session<NN>` 或 `hierarchy` 的 `ROOT<NN>` 前缀。
- **不可见节点「存根」语义：只看自身、子树剪掉（用户决策，两源一致）**：`visible` 为否的节点**本身保留**（树上一行、属性可查），但其**所有子节点不保留**——单次 DFS 判定，无后代回溯。动机（实测 2026-10，com.jfzt.uranus）：Navigation 压栈后**主页 NavBar 整棵（778 节点）被 ArkUI 标 `Visibility.Hidden`**，页面活着只是被盖住；首轮实现「父不可见→整棵剪枝」把主页全砍了（用户纠正：父节点要显示）。判据：uitest 源 `visible:"false"` 字符串（**`bool` 助手必须显式认 `"false"/"0"/"no"` 为否**——旧版只认 `"true"/"1"`、其余走默认值 true，把不可见全判成可见，这就是「Inspector 里 visible 为否还显示」的根因）；DevEco 源 `visibility` 枚举串归一化（去 `Visibility.` 前缀、小写比较）后 `hidden`/`none`、`$attrs.visible:"false"`、节点级 `visible:false` 任一命中。缺失 visibility 默认可见。配套规则：**hitTest 跳过 `visible:false` 存根**（其矩形常覆盖整屏且内容不在当前画面）；存根不测算 `contentBox`；可见父的 contentBox 并集排除不可见子节点矩形；client 对存根行加 `isHidden` 变暗样式。剪枝后 index/parentIndex/depth 重新连续；存根的 `visible` 字段保留 `false`。
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
- **兼容性 gate（0.2.0 实测，0.2.2-rc.1 复核）**：`dsh-app-boot` 的 `evaluatePluginCompatibility` 只检查 peerDependencies 中名字以 `@deepseek-ai/dsh` 开头的条目；`^0.2.0` **不匹配** `0.2.0-rc.2` 这类 prerelease（node-semver 只放行「同 tuple 且带预发布标签的比较符」匹配预发布版），范围要写 `^0.2.0-rc.1` 这类**预发布起点**形式，peers 与 `engines.dsh` 保持同步。不通过则插件在任何代码加载前被静默禁用。**支持范围只写 `^0.2.0-rc.1`（用户决策）**：本插件深度依赖 0.2.0 API（`sidebarRightTabs` / `settings.section` / `ctx.tools` / workspaceFiles），**0.1.x 连右侧边栏都没有，禁止声称支持**（曾误写 `^0.1.0-rc.7 || ^0.2.0-rc.1` 双段范围被用户纠正）。
  - **gate 实际用 `semver.satisfies(runtime, range, { includePrerelease: true })`**（`dsh-app-boot/lib/index.js` 的 `satisfies()`，2026-11-04 实测）——所以**普通 node-semver 的 prerelease 陷阱在 gate 这里不成立**：`^0.2.0-rc.1 || ^0.2.1-rc.0` **匹配 0.2.2-rc.1**（实测 true），本插件在 0.2.2-rc.1 上不会被 gate 拦。写范围时仍按上面的「预发布起点」形式（别用裸 `^0.2.0`，也别把上限写成 `<0.3.0` 之外的形状），因为 npm/pnpm 侧的普通 semver 语义没有这个宽松开关。
- **codec 双形态（0.2.0 实测）**：TYPERT invocation 的 codec 对象必须同时带 `schema`（≤0.1.5 校验器读）与 `create: () => schema`（≥0.1.7 / 0.2.0 调 `codec.create()`）；只给 `schema` 会在 0.2.0 下挂掉。
- **`dsh.client.external` 已废弃**：0.2.0 无消费者，package.json 不再声明。
- **npm 发布必须 `--registry=https://registry.npmjs.org`**（本机默认 registry 被 npmmirror 覆盖）。
- **DSH sandbox EPERM 限制**：`node --test` 默认会 spawn 子进程跑测试文件，在 workspace-write 下会撞 EPERM。`npm test` 已配置 `--test-isolation=none` 绕过；CI 环境无此限制。
- **`npm test` 使用 `--test-isolation=none`**：因 DSH sandbox 在隔离子进程里禁止打开命名管道。如需更严格隔离，CI 环境去掉此标志。