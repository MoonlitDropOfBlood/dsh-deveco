<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
</p>

<h3 align="center">DeepSeek Harness HarmonyOS 开发套件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <img src="https://img.shields.io/badge/DSH-%5E0.2.0--rc.1-4D6BFE?style=flat" alt="supported DSH versions">
  <a href="https://www.npmjs.com/package/@duke-dsh-plugins/dsh-deveco"><img src="https://img.shields.io/npm/v/@duke-dsh-plugins/dsh-deveco?style=flat" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **HarmonyOS 全栈开发套件**插件：HiLog 检查器、Chrome DevTools 风格 ArkUI Inspector（截图点选 + 组件树 + 盒模型声明值 + 自定义组件名）、ArkTS 语法高亮 .ets 查看器、工具链与设备管理，以及对话内 agent 可直接调用的 `harmony_ui_tree` / `harmony_debug` 工具。

> **兼容性**：支持 DSH **`^0.2.0-rc.1`**（0.2.x；本插件深度依赖 0.2.0 API——官方右侧边栏 `sidebarRightTabs`、设置页、agent 工具 `ctx.tools`，**0.1.x 无右侧边栏，不受支持**）。`engines.dsh` 与 peerDependencies 同步声明。发布走 GitHub `v*` 标签 → Actions 自动构建测试 + GitHub Release + npm（`@duke-dsh-plugins` 组织，OIDC Trusted Publishing）。

## 功能

### 官方右侧边栏 Tab
- **HiLog 检查器**：实时日志流（基于 `devecocli log --follow`）+ 级别过滤（chip 多选）+ **包名/关键词实时过滤**——流跑着随时改随时生效、清空即回溯（不丢已缓冲的行）；包名自动解析为进程 pid 集合过滤（主进程 + `:render` 等后缀进程全收）+ **Ctrl+F 日志内查找**（Tab 内接管快捷键：全部命中高亮 + 计数 + Enter 逐个跳转 + Esc 关闭）+ 「开始/停止」控制
- **ArkUI Inspector**：Chrome Elements 风格三栏——**左侧设备截图**（点「Dump UI」自动抓取，Host 内联返回 PNG dataUrl；**点击截图直接选中对应节点**并显示蓝色高亮框，**按 `origBounds` 真实布局矩形标注**——`bounds` 只是被滚动/遮挡后的可见区域，List 尤其不准；高亮与点击命中共用同一坐标系；点中后 **UI 树自动展开并滚动定位到该行**并高亮选中）+ **右上 UI 树**（**可逐节点折叠/展开 + 「折叠全部」**、层级引导线（**线性缩进不封顶**，深层可横向滚动）、**自定义组件显示组件名**，其内部 `__Common__` 占位节点归属到所属组件、tap/scroll/子节点数标记、`#accessibilityId` 标识、**顶部「树源」下拉两选一**：**DevEco 调试源**（反编译复刻 DevEco Studio 同款 `ark:<pid>@<pkg>` WebSocket 调试链路，**唯一带 padding/margin/border 声明值与 viewTag 组件名**；需 debug 应用且应用侧调试 socket 空闲——DevEco Studio 的 Inspector 面板开着时会占用唯一连接）/ 无障碍树（uitest，适合已发布应用）、**窗口下拉切换窗口**）+ **右下节点属性**（**全部设备原始属性**，支持**按属性名或值搜索过滤**并高亮命中项 + **盒子模型**：组件区域 / **内容区域（子节点并集实测）** / 四边内缩实测值；padding/margin/border 声明值在 uitest 源下显示「未提供」——已穷尽核对 7 条取数路径确实不输出，不做假数据；**DevEco 调试源下显示真实声明值**）；底部 Tap/Swipe/Text 操作
- **Projects**：项目浏览器（v1.0 占位；v1.1 路线）

### Agent 工具（对话内可调用）
- **`harmony_ui_tree`**：把 DevEco 调试源取树注册为 DSH 的 agent 工具（`ctx.tools`），对话里的 agent 可直接调用，返回**缩进树文本**（或 `format=json` 完整节点）——节点含组件名、bounds、文本与 **padding/margin/border 声明值**；JSON 中每个节点带裁剪前原始直接子节点数 `childCount`（裁剪为叶子也不归零）。Swiper 在 `displayCount` 未配置或 ≤1 时只完整展开 `currentIndex` 页，其他页保留一层（`TabContent` 两层），`displayCount>1` 时不裁剪。支持 `device` / `pid` / `package_name` 定位目标、`include_attrs` 附带全部原始属性、`max_nodes` 截断保护。前置条件同 DevEco 调试源（debug 应用、DevEco Inspector 面板未占用）。
- **`harmony_debug`**：**ArkTS 运行时调试器**（与 DevEco Studio 同款通道：`hdc fport ark:<pid>@Debugger` + 裸 socket WebSocket + CDP 风格 JSON-RPC）。动作：`attach`（`launch=true` 走已验证的 wait-for-debugger 流程：`aa appdebug` → force-stop → `aa start` → fport → 握手 → `Runtime.runIfWaitingForDebugger`）、`status` / `scripts`（已加载脚本 url，断点必须逐字匹配）、`set_breakpoint` / `remove_breakpoint` / `breakpoints`、`pause` / `resume` / `step`（over/into/out）、`run`、`stack`（调用栈）、`evaluate`（暂停帧求值——该 runtime 不支持 `Runtime.evaluate`）、`properties`（展开远程对象）、`exceptions`（none/uncaught/all）、`events`、`detach`。前置条件：应用必须是 **debug 签名**；同一 pid 同时只允许一个调试客户端（DevEco 调试会话开着时 attach 会连不上）。

> 日志与应用管理不另做工具——直接用官方 CLI：`devecocli log`（`--level/--keyword/--bundle-name/--tail/--format json/--follow`）与 `devecocli device app list|info|start|stop|install|uninstall`（`device app info --format json` 里含 `applicationInfo.appProvisionType`，即 debug 签名判定）。

### .ets 文件查看器
- 注册为官方侧边栏 file tab（`patterns: ["dsh-resource://file/**"]` + `canOpen` 按扩展名过滤），`extension` 优先级优先于内置 text editor
- 提供 ArkTS 语法高亮：关键字 + 装饰器（@Entry /@Component /@State 等）+ 注释 + 字符串 + 数字
- 内容经官方 `remote.workspaceFiles.read` 分页读取；绝对路径文件回退插件自有 `readTextFile` Remote

### 设置 → HarmonyOS Suite

导航项图标是手机造型（16px，跟随主题色）。**自定义图标需要 DSH ≥ 0.2.2-rc.1**（该版本新增了官方 `settings.section.icon` 接口）；在 0.2.0 / 0.2.1 上插件改用壳的通用齿轮图标，设置页本身功能不受影响。

页面分两个分区：

**工具链**
- 「DevEco Studio 路径」输入框 + 「扫描系统默认」+ 自发现结果列表
- 「HarmonyOS Command Line Tools 路径」输入框 + 版本校验（≥ 26.0.0）+ 自发现结果列表
- 「重新扫描」按钮 + 「保存 / 放弃」
- 状态徽章（devecocli / hdc 降级（未安装 devecocli）/ CLT ≥26 / CLT<26 / Studio / 未配置）

**设备管理**
- **设备列表**：实时列出 USB / 网络设备（`devecocli device list`；未安装 devecocli 时自动降级 `hdc list targets`），网络目标（`ip:port`）带「网络」徽章，可一键「断开」（`hdc tconn <ip>:<port> -remove`）
- **IP 网络连接**：输入设备 IP 和端口（**端口必填**——hdc 无默认端口，须与设备开启调试后暴露的端口一致）后「连接」，底层执行 `hdc tconn <ip>:<port>`；连接/断开后列表自动刷新。devecocli 本身没有 IP 连接能力，这里直连 SDK 自带的 hdc（按 `DEVECO_SDK_HOME` → `DEVECO_HOME` → 已配置/已发现的 Studio/CLT 安装根 → PATH 顺序解析）。前提：设备已在「设置 → 开发者选项」中开启调试

## 工具链解析优先级（用户决策）

1. **`PATH` 存在 `devecocli`** → 优先使用，**忽略设置路径**
2. **CLT 路径 ≥ 26.0.0** → 用 CLT（与 Studio 互斥）
3. **DevEco Studio 路径** → 兜底
4. **都没有** → 设备/日志/截图/操作自动降级到 SDK 自带的 `hdc`；`hdc` 也找不到才提示去设置

互斥规则：`setCltPath` 清空 `studioPath`；`setStudioPath` 清空 `cltPath`。

> **devecocli 不是 DevEco Studio / Command Line Tools 自带的**——它是独立的 npm 包（`@deveco/deveco-cli`）。本插件在未安装它时**不会变砖**：所有设备与 UI 能力都会自动切换到 SDK 自带的 `hdc`。

## 没有 devecocli 也能用（hdc 降级）

装了 DevEco Studio 或 Command Line Tools（拿到 SDK 里的 `hdc`）但没有装 `devecocli` 时，插件按下面的矩阵自动降级——不需要任何额外开关：

| 能力 | 有 devecocli | 没有 devecocli（hdc 降级） |
|---|---|---|
| 设备列表 | `devecocli device list` | `hdc list targets` |
| 设备详情 | `devecocli device view` | `hdc shell param get const.*` |
| 实时 / 历史日志 | `devecocli log [--follow]` | `hdc shell hilog` / `hilog -x` |
| 窗口列表 | `devecocli ui window list` | `hdc shell hidumper -s WindowManagerService -a -a` |
| 截图 | `devecocli ui screenshot` | `hdc shell uitest screenCap`（失败退 `snapshot_display`）+ `hdc file recv` |
| Tap / Swipe / Text | `devecocli ui click/swipe/text` | `hdc shell uitest uiInput click/swipe/text` |
| ArkUI 无障碍树 | — | `hdc shell uitest dumpLayout`（本来就走 hdc，不受影响） |
| DevEco 调试树 / ArkTS 调试器 / IP 连接 / 包名→pid | — | 本来就走 hdc，不受影响 |

降级状态下设置页徽章显示「**hdc 降级（未安装 devecocli）**」；设备列表获取失败时 Tab 内会显示错误原因，而不是只给一个空下拉。想用 devecocli 的完整能力（例如更友好的 `device view` 输出）时再安装即可：`npm i -g @deveco/deveco-cli`。

## 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

本地开发版：

```bash
git clone https://github.com/MoonlitDropOfBlood/dsh-deveco
cd dsh-deveco
dsh plugin --profile web add .
```

## 开发

```bash
npm run check    # 全部 JS 语法检查
npm test         # 113 个独立核心单元测试（路径探测 + 配置互斥 + HiLog/ui 解析 + hdc IP 连接/空格路径 spawn/超时判定 + 盒子模型/contentBox/hitTest/PNG 尺寸 + 窗口/原始 dump/DevEco 调试树/裸 WS 握手/agent 工具投影/自定义组件/字体属性/devId 解析 + agent 工具命令构造与调试协议纯函数 + hdc 降级命令/解析）

# 真机 / 模拟器跑一遍 agent 调试工具（不依赖 DSH）
node scripts/e2e-agent-tools.mjs --device 127.0.0.1:5555 --bundle <你的 debug 包名> --attach
```

**改插件后必须重启 DSH** 生效（Host 加载、typert 注册、client bundle 注入都在启动时发生）。

详细开发规范见 `AGENTS.md`。

## 三平台自动发现

| 平台 | Studio 默认路径 | CLT 根默认路径 |
|---|---|---|
| Windows | `C:\Program Files\Huawei\DevEco Studio`<br>`C:\Program Files (x86)\Huawei\DevEco Studio`<br>`C:\DevEco Studio` | `C:\Program Files\Huawei\Command Line Tools`<br>`%LOCALAPPDATA%\Huawei\Command Line Tools` |
| macOS | `/Applications/DevEco Studio.app/Contents`<br>`/Applications/Huawei DevEco Studio.app/Contents`<br>`~/Applications/DevEco Studio.app/Contents` | `/Applications/Command Line Tools.app/Contents`<br>`~/Library/Huawei/Command Line Tools` |
| Linux | `/opt/deveco-studio`<br>`/opt/Huawei DevEco Studio`<br>`~/deveco-studio` | `/opt/Huawei/Command Line Tools`<br>`~/Huawei/Command Line Tools` |

## 持久化

- 配置：`<DSH_HOME>/data/dsh-deveco/config.json`
- 自发现缓存：`<DSH_HOME>/data/dsh-deveco/discovery.json`

首次启动（`discovery.json` 不存在）自动触发三平台自发现，结果缓存到 `<DSH_HOME>/data/dsh-deveco/discovery.json`。

## 许可证

MIT