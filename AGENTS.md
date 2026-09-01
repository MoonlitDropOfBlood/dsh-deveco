# AGENTS.md — dsh-deveco

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）bundle 插件**：在 DSH Web UI 提供完整的 HarmonyOS 开发能力。

- **better-sidebar 中注册一个名为「HarmonyOS Suite」的单实例 Tab**（order 50）。包含三个内部子页：
  - **HiLog**：实时日志流（级别/包名/关键词过滤），基于 `hdc shell hilog -f` 封装
  - **ArkUI Inspector**：UI 树 dump（点击节点自动填充 tap 坐标）、Screenshot、Tap/Swipe/Text 操作
  - **Projects**：项目浏览器（v1.0 占位，listProjects 返回空数组；v1.1 路线）
- **better-sidebar 中注册一个名为「ArkTS / TypeScript」的文件查看器**（`registerFileViewer`，`exts: ['ets']`，priority 10 优先于内置 text editor）。提供 ArkTS 语法高亮（关键字 + 装饰器 + 注释 + 字符串 + 数字）。
- **设置面板新增「HarmonyOS Suite」页**（`settings.section`，order 40）。管理 DevEco Studio 与 HarmonyOS Command Line Tools 路径，含三平台自发现、Studio/CLT 互斥规则、CLT 最低版本 26.0.0 校验。

## 目录结构

```
dsh-deveco/
├── package.json              # ESM 双面包：dsh.bundle.patch + dsh.client.web + exports(., /client, /typert, /package.json)
├── index.js                  # Host 半：HarmonyDevEcoService（TypertRemoteService 子类，17 个 Remote 方法）
├── client.js                 # Client 半：__ModuleLoader__ bundle（Tab + Viewer + Settings + Remote mount）
├── typert.host.js            # Typert Host manifest：harmonyDevEco Remote 服务全部 invocation 的 zod schema
├── harmony-studio.mjs        # 零依赖：工具链路径探测（devecocli > CLT ≥26.0.0 > Studio）+ 版本解析 + 三平台默认路径
├── harmony-config.mjs        # 零依赖：配置持久化 + Studio/CLT 互斥 + 自发现调度
├── harmony-device.mjs        # 零依赖：hdc/devecocli 进程封装 + HiLog/ui-dump 解析
├── cordis.patch.yml          # dsh bundle patch（挂载行）
├── scripts/self-test.mjs     # 44 个独立核心单元测试（路径探测 + 配置互斥 + HiLog/ui 解析）
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
    // ...其余 16 个方法
  }
  async getConfig() { /* ... */ }
}
```

- 文件 I/O 直接 `import ... from "node:fs/promises"`。正式插件的 Host 半由 loader 用标准 `import()` 加载，拥有完整 Node 权限，和 DSH 核心写 `~/.dsh` 一样，**不需要**走 `ctx.shell` 沙箱。配置 / 发现缓存目录在 `<DSH_HOME>/data/dsh-deveco/`。
- Remote 标记用 `markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote()` 装饰器（Node ESM 不支持装饰器），在 `[Service.init]()` 中调用。

### 3. Client 半：bundle + 自挂载 Remote + Slot 注册

- `window.__ModuleLoader__.load({ id, factory })` 格式；`exports.inject = ["slots", "remote"]`。
- **必须自挂载** Remote 命名空间：`await ctx.remote.$mount(CLIENT_REMOTE)`（`dsh-api-remotes` 只挂载官方命名空间）。调用走 `ctx.get('remote.harmonyDevEco')`（**不要**写进 inject）。codecs 用 passthrough schema（`{ parse: (v) => v }`，浏览器没有 zod）。
- **better-sidebar 集成**：`ctx.get('betterSidebar')` 拿服务（**不要**写进 inject）。若返回 undefined（用户没装 better-sidebar），跳过 tab 与 viewer 注册（graceful degrade）。
- **设置页注册**：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'harmony-deveco', order: 40, label: () => 'HarmonyOS Suite' }, HarmonySettingsPage))`。
- **设置导航图标**：DSH 0.1.x `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮。`client.js` 的 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-deveco-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 globe Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path。
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

### 5. 17 个 Remote 方法

| 方法 | 用途 |
|---|---|
| `getConfig` | 取当前配置 + resolved + discovery |
| `setStudioPath` | 设置 Studio 路径（清空 cltPath） |
| `setCltPath` | 设置 CLT 路径（清空 studioPath） |
| `rescan` | 重跑自发现 |
| `deviceList` | 列出设备/模拟器 |
| `deviceInfo` | 设备详情 |
| `hilogList` | 历史 hilog（一次性） |
| `hilogStreamStart` | 启动实时流（返回 streamId） |
| `hilogStreamRead` | 读取缓冲区（drain maxLines） |
| `hilogStreamStop` | 停止流 |
| `uiDump` | ArkUI UI 树 |
| `uiScreenshot` | 截图 |
| `uiTap` | 点击 |
| `uiSwipe` | 滑动 |
| `uiText` | 输入文本 |
| `listProjects` | 列出鸿蒙工程（v1.0 返回空） |

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

## 开发 / 验证

```bash
npm run check              # 全部 JS 语法检查
npm test                   # 44 个单元测试（路径探测 + 配置互斥 + HiLog/ui 解析）
dsh plugin --profile web add .   # 本地安装/重装
```

**改插件后必须重启 DSH** 生效（Host 加载、typert 注册、client bundle 注入都在启动时发生）。

端到端验证清单：
1. 设置 → 侧栏导航出现 **HarmonyOS Suite**（图标：地球，globe Lucide）
2. 打开 HarmonyOS Suite 设置页：能看到「未配置」状态徽章（红色 err）
3. 输入一个 CLT 路径（含版本号如 `26.0.0`）→ 点「应用」→ 状态变绿；输入 Studio 路径 → 状态变 Studio
4. 设置面板的「HarmonyOS Suite」页 → 验证「DevEco Studio 路径」「HarmonyOS Command Line Tools 路径」互斥（应用 CLT 清空 Studio，反之亦然）
5. better-sidebar 的 + 菜单看到「HarmonyOS Suite」入口 → 打开 Tab
6. HiLog 子页：选设备（先点「刷新设备」）→ 设过滤 → 「开始」→ 日志流出现；点击级别 chip 可过滤
7. ArkUI 子页：「Dump UI」→ UI 树出现 → 点节点 → 自动填充 tap 坐标 → 「执行」tap
8. Projects 子页：v1.0 显示「开发中」占位

## 发布

打 `v*` 标签推送到 Git，`.github/workflows/release.yml` 自动构建并发布 GitHub Release。

## 常规注意事项

- **必须 `export default HarmonyDevEcoService`**（继承自 dsh-git-manager/memory-manager 经验）：cordis loader 的 `unwrapExports` 取 `exports.default ?? exports`，ESM 命名空间对象不是合法 plugin，registry 报 `invalid plugin, expect function or object with an "apply" method, received object`，**整个 DSH 起不来**。node --check 与 self-test 都发现不了，只有真实 boot 才暴露。
- **必须导出 `TYPERT` 对象且 shape 严格**（实测）：dsh-typert-loader 的 `validateTypertManifest` 要求 `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[...], objects:[...]} }`。`events`/`objects` 必须是数组（哪怕空）；缺 `model.events` 报 `TYPERT.model.events must be an array`。invocation 的 parameters/result codec 必须 `mode:"strict"` 且 schema 是 zod v4 实例。
- **profile package.json 绝不能写 BOM**（大坑，实测）：DSH 的 `readProfileManifest` 直接 `JSON.parse` profile 的 `package.json`；任何 UTF-8 BOM 都会让它抛 `Unexpected token '﻿'` 崩溃——**整个 profile 起不来**。Windows PowerShell `Set-Content -Encoding UTF8` 默认带 BOM；改 `~/.dsh/profiles/web/package.json` 必须用无 BOM 编码（`.NET WriteAllText + UTF8Encoding(false)`，或 `dsh plugin add` 官方路径）。
- **Remote 返回值必须「网关 JSON-safe」**：可选字段**有值才挂 key**（`if (x !== undefined) out.x = x`），union 里的空值用 `false`/`""` 不要用 `null`；不可有循环引用或函数。self-test 跑真实 git/工具仓的返回值跑 strict schema + 等价 assertJsonSafe 复刻——**新增/修改 Remote 方法的返回结构必须过它**。
- **路径归一化**：Windows 路径用 `node:path.resolve` 归一化为反斜杠；用户粘贴带前导/尾随空格或引号时，`harmony-studio.normalizeStudioPath` 会清洗。
- **HiLog 流管理**：`_streams` Map 持有 `child`（spawn 进程）+ `buffer`（已解析的 hilog 行）；buffer 上限 5000 行防内存膨胀；`ctx.effect(() => () => killAll())` 在 plugin dispose 时清理。
- **CSS 用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`**：动态插件专属的 `styles.insert` 在这里不存在。
- **颜色一律 dsw token**：禁止硬编码 hex/rgba（亮/暗主题下必有一边翻车）。需要透明色用 `color-mix(in srgb, var(--dsw-...) 15%, transparent)`。
- **`Component.createElement` 必须 bundle 作用域定义**：内联创建（如 `() => React.createElement(...)` 返回值直接传给 slots.register）会每次 render 重新创建 component identity，导致 React 卸载并重建子树、丢失输入态。
- **betterSidebar 服务不可用时跳过 tab/viewer 注册**（graceful degrade）：用户没装 better-sidebar 时不影响 settings 与 Remote 通信。
- **npm 发布必须 `--registry=https://registry.npmjs.org`**（本机默认 registry 被 npmmirror 覆盖）。
- **DSH sandbox EPERM 限制**：`node --test` 默认会 spawn 子进程跑测试文件，在 workspace-write 下会撞 EPERM。`npm test` 已配置 `--test-isolation=none` 绕过；CI 环境无此限制。
- **`npm test` 使用 `--test-isolation=none`**：因 DSH sandbox 在隔离子进程里禁止打开命名管道。如需更严格隔离，CI 环境去掉此标志。