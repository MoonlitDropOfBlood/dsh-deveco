# Changelog

本项目的重要变更记录在此文件中。发布工作流按 `v*` 标签提取对应版本段落作为 GitHub Release 正文；版本标题格式为 `## [X.Y.Z] - YYYY-MM-DD`。

## [Unreleased]

## [0.9.1] - 2026-11-18

### Fixed

- 修复 DevEco 结构树遇到 `-0.00vp` 等负零数据时 `harmony_ui_tree` 整体返回失败：DSH 的结构化输出要求无损 JSON 数字并拒绝 `-0`，而旧解析器会保留 `Number("-0.00vp")` 产生的负零。现在解析入口统一将负零归一为 `0`，覆盖带单位声明值、padding / margin / border / opacity / zIndex 以及矩形坐标和宽高。

### Validation

- 185 项单元测试通过（`npm run check` + `npm test`）；新增负零回归用例，并使用真实 DSH JSON Schema 校验器确认修复后的结构树数值通过校验。

## [0.9.0] - 2026-11-18

### Added

- **.ets 查看器升级为带 git 信息的编辑器**（参考抽屉编辑器 dsh-better-sidebar 的 VS Code 风格 git 显示，完全自研、零新增依赖、不依赖其任何代码）：
  - **git gutter**：变更行行号左侧 2px 竖条 + 行号染色（增绿 / 改琥珀 / 删红）；未跟踪文件全部行标新增；干净文件保留竖条占位，行号不横移。
  - **悬停 blame**：鼠标悬停行显示该行 blame 的纯文本 tooltip（作者 · 相对时间 + commit summary）；250ms 延迟、按路径+行记忆化（上限 500），git 信息刷新即失效；未跟踪文件不请求。
  - **meta 行 git 段**：分支徽章、状态文案（干净/已修改/未跟踪/已暂存新增/冲突…）、+增 ~改 −删 计数、手动刷新；git 缺失/非仓库/查询失败显示对应灰字提示，代码与高亮照常显示。
  - **编辑与保存**：透明 textarea 叠在高亮层上（gutter 独立成列、行高实测同步、滚动条宽度补偿、末尾空行高度补偿），Tab 插 2 空格、Enter 自动缩进、Ctrl/Cmd+S 或保存按钮；脏标记「● 未保存」/保存中/已保存/保存失败反馈；中文 IME 组字期间文字可见且不被回写打断。**截断读取或超 2000 行的文件只读预览、禁止编辑与保存**（防止把截断内容写回毁文件）。
- **3 个新 Remote**（总数 24 → 27）：
  - `fileGitInfo`：一个文件的分支 / 工作区状态 / 变更行与计数；git 缺失、非仓库、命令失败一律降级 `{available:false, reason}`，绝不让预览器报错。
  - `fileGitBlame`：单行 blame（`-L n,n`），悬停才取；无答案降级 `available:false`。
  - `writeTextFile`：**原子写**（同目录临时文件 + rename，失败清理）、**保留原文件 EOL 与 BOM**、**只覆盖已存在文件**（ENOENT → not-found）、2 MiB 上限；路径解析支持绝对 / session 相对（sessions.header.cwd）。
- 新零依赖模块 `harmony-git.mjs`（命令构造/执行、status/diff/blame 解析、EOL/BOM 保留）与端到端探针 `scripts/e2e-file-git.mjs`（`npm run e2e:filegit`：真 git 仓库 + 真 service，info→blame→write→再 info，含 CRLF 保留与 clean 回归，不依赖设备/DSH）。

### Changed

- diff 变更行判定按 hunk 头计数走（不猜文本）：删除行锚在间隙上方一行（`lastNew` 初始 `newStart - 1`）；del-run 与紧随 add-run 配对记 `mod`；锚点不覆盖已标记的 add/mod 行；context 行永不标记。
- blame 日期按**作者时区偏移**输出 ISO 8601；未提交行 hash 全 0（git 的 "Not Committed Yet"）。
- git 调用统一 `spawn("git", argv)`（不用 shell）+ 全局 `--literal-pathspecs` 前置于子命令 + 路径在 `--` 之后 + `GIT_OPTIONAL_LOCKS=0` / `LC_ALL=C` + 10s 超时 / 8 MiB 输出上限。

### Validation

- 184 项单元测试通过（`npm run check` + `npm test`，含新增 22 项 git/保存测试与真 git 集成）；`npm run e2e:filegit` 29/29 通过。

### 已知限制（后续迭代）

- git 标记与悬停 blame 反映**上次保存**的版本；未保存编辑期间插入/删除行会使行号标记漂移（meta 有「● 未保存」提示，blame tooltip 标注「对应上次保存版本」）。
- 无 Ctrl+F 查找、无外部磁盘变更监听、**关闭标签页不确认未保存改动**（请及时 Ctrl+S）；Tab 缩进固定 2 空格（不读 .editorconfig）。
- 可编辑上限按**打开时**行数判定（≤ 2000 行且读取未截断）；打开后编辑增长不受该上限限制，保存只受 Host 2 MiB 约束。

### 📦 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

也可使用本 Release 附件中的 tgz 包。安装或更新后必须重启 DSH 生效。

## [0.8.1] - 2026-11-16

### Fixed

- Linux 工具链发现：官方 linux-x64 CLT 是**扁平根**（`<root>/version.txt` + `<root>/sdk/…`，没有 `<root>/26.0.0/` 版本号子目录），旧版只扫版本号子目录，导致 Linux 上自动发现恒为空、手填扁平根也解析不出 CLT（徽章停在「未配置」）。新增 `readCltRootVersion()`（读 `version.txt` 的 `^#\s*Version:\s*(\S+)/`，与官方 `@deveco/deveco-cli` 同规则），`scanCltCandidates` 现在把根自身也作为候选。
- Linux hdc 解析：`resolveHdc` 新增官方 devecocli 的 `DEVECO_CLI_CLT_PATH` / `DEVECO_CLI_STUDIO_PATH` / `DEVECO_PATH`（Linux 没有 DevEco Studio，CLT 只能用第一个变量声明），以及独立 `ohos-sdk` 包的 `<root>/toolchains/hdc` 布局；非 Windows 的限深扫描同时覆盖设置里手填 / 自发现的路径。原顺序不变，新来源只是追加。

### Changed

- 设置 → HarmonyOS Suite 的路径占位文案按平台给出（Linux 显示 `/opt/huawei/command-line-tools`），不再恒贴 Windows 路径。
- 新增 5 项单元测试（扁平根识别、`version.txt` 解析、无 devecocli 时配置扁平根可解析、`DEVECO_CLI_CLT_PATH`、独立 SDK 布局）；「源文件比 Source Map 新」用例改用 `utimesSync` 显式拨快 mtime（tmpfs/ext4 相邻写入常落在同一时间戳刻度，原写法会飘红）。

### Validation

- 158 项单元测试通过（`npm run check` + `npm test`）；Linux 扁平根发现逻辑按官方 CLT 26.0.0.621 linux-x64 的实际目录结构实现。

## [0.8.0] - 2026-11-12

### Added

- 新增 ArkWeb Web DOM 读取能力：`harmony_web_dom` agent 工具（`targets` / `snapshot`）与 `webTargets` / `webDomRead` Remote。
- 通过 `webview_devtools_remote_<pid>` → 一次性 `hdc fport` → 标准 Chromium CDP WebSocket 读取 DOM；支持 CSS 选择器子树、属性、outerHTML、深度/节点数有界裁剪。
- 截断保持整棵子树省略语义，边界节点带 `childrenOmitted` / `hiddenDirect` / `childCount`；每次操作只清理自己创建的 fport 规则。
- 新增 `harmony-webdevtools.mjs`、假 CDP 服务 `scripts/cdp-fixture.mjs` 与端到端探针 `scripts/e2e-web-dom.mjs`。

### Validation

- 153 项单元测试通过；`npm run e2e:webdom` 通过（假 Chromium HTTP `/json` + RFC6455 WS，验证标准 CDP、选择器子树、outerHTML、错误映射与无 Origin 握手）。
- **真机验证通过**：HUAWEI Mate 70 / ArkWeb 7.0.0.111 / Chrome 144，包名 `com.jfzt.uranus`；`webTargets` 发现 page target，`webDomRead` 读取 133 节点 / 122 KB outerHTML，`body` 选择器子树 74 节点，缺失选择器正确返回 `selector-not-found`，结束后 `hdc fport ls` 为空。记录见 `docs/arkweb-web-dom-recon.md`。
- 多 Web 组件、OOPIF/iframe、页面导航与 Chrome DevTools 并发尚未覆盖。

### Fixed

- 真机 `DOM.describeNode` 后代 `nodeId=0` 时节点计数错误；改为按对象身份去重。
- 一次性 fport 回调返回值未重新包装为 Host `{ok:true,value}` 包络，导致列表/读取误判失败。
- Document 根取 outerHTML 时改取 `documentElement`；DOCTYPE 显示为 `<!doctype html>`。

### 📦 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

也可使用本 Release 附件中的 tgz 包。安装或更新后必须重启 DSH 生效。

## [0.7.1] - 2026-11-09

### Fixed

- `harmony_debug` 的 `hdc fport` / `fport rm` 在 attach、重试清理、detach 与插件销毁时均携带 `-t <device>`，不再丢失显式选择的模拟器/设备。
- 仅 `TCP Port listen failed` 会触发换端口重试；其他 `[Fail]` 立即返回 hdc 原始错误，不再误报为端口占用。

### Validation

- 140 项单元测试通过；语法检查与打包检查通过。
- 断点通知端到端探针 20/20 通过；本次未执行真实模拟器在线调试。

### 📦 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

也可使用本 Release 附件中的 tgz 包。安装后必须重启 DSH 生效。

## [0.7.0] - 2026-11-08

### Changed

- **发布说明改为读取 `CHANGELOG.md`**：工作流按 `v*` 标签提取对应版本段落作为 GitHub Release 正文，不再沿用静态模板；标签缺少唯一且非空的版本段落时**直接失败**，杜绝发布出"130 个测试"这类过期说明。
- 新增 `scripts/extract-release-notes.mjs`（支持 `## [X.Y.Z] - 日期`、`## X.Y.Z - 日期` 两种标题），可本地预览：`node scripts/extract-release-notes.mjs v0.7.0`。
- 新增 `CHANGELOG.md` 作为版本变更记录与 Release 正文的唯一来源。

### Validation

- 138 项单元测试通过；语法检查与打包校验通过。
- 已验证：0.6.0 段落提取正确；不存在的版本按预期拒绝发布。

### 📦 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

也可使用本 Release 附件中的 tgz 包。安装后必须重启 DSH 生效。

## [0.6.0] - 2026-11-08

### Added

- **`harmony_project` 工程模型**：从工程根或内部路径解析 JSON5 配置、应用/产品/模块/Ability/权限/依赖与构建产物；签名材料脱敏，`listProjects` 不再固定返回空列表。
- **`.ets` 源码级调试**：`harmony_debug` 通过真实 Hvigor Source Map 支持源码断点、源码调用栈与暂停通知，保留编译坐标供诊断，并拒绝使用过期映射。
- 新增真实工程 Source Map 探针 `scripts/e2e-source-map.mjs`；工程与调试文档同步更新。

### Validation

- 138 项单元测试通过；断点通知端到端探针 20/20 通过。
- 真实工程验证：`Index.ets:296` ↔ 编译 0 基坐标 `339:4`，索引 40 个脚本且无警告。
- 模拟器在线断点命中验证未包含在本次发布验证中。

### 📦 安装

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-deveco
```

也可使用本 Release 附件中的 tgz 包。安装后必须重启 DSH 生效。
