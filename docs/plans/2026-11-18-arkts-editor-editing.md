# ArkTS 查看器 → 编辑器：编辑能力扩展契约（2026-11-18 追加）

> 用户追加需求（原话）：「需要编辑能力的，你e2e通过后直接发布即可」。
> 本文档是 `2026-11-18-arkts-viewer-git.md`（下称「基础契约」）的**增量契约**：
> git 显示部分按基础契约不变；新增编辑/保存能力。路线不变——**自研、零 npm 依赖、
> 零构建步骤、不依赖 dsh-better-sidebar 任何代码**。发布由 Lead 在 e2e 全绿后统一执行，
> 子代理不发布、不改版本号。

## 0. 范围与写入范围（不变）

- host-git：`harmony-git.mjs`、`index.js`、`typert.host.js`、`scripts/self-test.mjs`、
  `scripts/e2e-file-git.mjs`（新建）、`AGENTS.md`、`package.json`（files/description/scripts，**不改 version**）。
- client-viewer：仅 `client.js`。
- 两侧互不越界；增量落盘；歧义按 AGENTS.md 惯例保守选择并在报告注明。

## 1. Host 新增：`writeTextFile` Remote（第 27 个）

### 1.1 契约

请求：`{ path: string, content: string, sessionId?: string }`
- 路径解析与基础契约 §2.3 完全一致（绝对 / session 相对 + sessions.header.cwd）。
- `content` 是客户端 textarea 值（**LF 规范化**，不含 \r）。

返回：`ok({ path: abs, bytes: number /* 写入字节数 */, saved: true })`
或 `err(code, message)`，code ∈ `invalid-request | not-found | too-large | write-failed`。

行为（顺序）：
1. path/content 校验：path 空或 content 非字符串 → `invalid-request`。
2. `content.length > 2 * 1024 * 1024` → `too-large`（与读侧 2 MiB 上限对称）。
3. 先读原文件（`readFile`）：ENOENT → `not-found`（**只覆盖已存在文件，不创建新文件**）；
   其它读失败 → `write-failed`。
4. **EOL 保留**：原文件含 `\r\n` → 写入前把 content 的 `\n` 全部转 `\r\n`
   （先把 content 自身可能残留的 `\r\n` 归一为 `\n` 再转）。原文件纯 LF → 保持 LF。
5. **BOM 保留**：原文件 utf8 解码后以 `\uFEFF` 开头且 content 没有 → 前置 `\uFEFF`。
6. **原子写**：同目录写临时文件 `${abs}.dsh-deveco-tmp-<randomUUID>` → `rename` 覆盖原文件；
   任何失败 best-effort `unlink` 临时文件。不得半截覆盖。
7. 返回写入字节数（`Buffer.byteLength(finalContent, 'utf8')`）。

### 1.2 实现位置

- 纯函数放 `harmony-git.mjs` 或新建均可，但**优先复用现有模块**：
  `prepareSaveContent(originalRawUtf8: string, content: string): string`（EOL+BOM 归一，纯函数可单测）
  放 `harmony-git.mjs`（该模块已是「文件查看器 git/保存」域）。
- `index.js` 的 `// ---- file viewer ----` 区新增 `writeTextFile` 方法 + `markRemoteMethod`。
- `typert.host.js`：请求 schema `{ path, content, sessionId? }`、value `{ path, bytes, saved }`、
  `iv('writeTextFile', ...)`、model.members 追加。**invocations 总数 26 → 27**（self-test 断言同步）。

### 1.3 测试（self-test 追加）

- `prepareSaveContent`：CRLF 原文件 + LF content → CRLF；LF 原文件 → LF；BOM 保留/不重复；
  content 自带 CRLF 的归一。
- 真文件 roundtrip（mkdtemp）：写 CRLF 文件 → writeTextFile 逻辑（可直接调 service 方法或
  编排函数）→ 读回断言 EOL/BOM/内容；不存在文件 → not-found；超大 → too-large；
  失败后无临时文件残留。
- TYPERT：27 条、writeTextFile strict 双形态 codec、safeParse 正反例、JSON-safe。

### 1.4 e2e 探针 `scripts/e2e-file-git.mjs`（新建，不依赖 DSH/设备）

- 仿 `scripts/e2e-agent-tools.mjs` 的独立探针风格：mkdtemp 真 git 仓库（init + 本地 user.name/email
  + 提交基线 .ets 文件）→ **实例化真 HarmonyDevEcoService**（最小 mock ctx：
  `{ inject: () => () => {}, get: () => undefined, effect: () => {}, on: () => () => {} }`，
  按 constructor 实际所需补齐；配置目录用临时目录避免污染 ~/.dsh）→ 依次真调：
  1. `fileGitInfo`（工作区改写后）→ 断言 state=modified、changes 非空、branch 非空；
  2. `fileGitBlame`（某行）→ 断言 author/summary 非空、date 带时区偏移；
  3. `writeTextFile`（保存一段修改，CRLF 场景另建文件）→ 断言 saved、读回 EOL 保留；
  4. 保存后再 `fileGitInfo` → kinds 随保存变化；把内容改回基线再保存 → state=clean；
  5. 未跟踪文件 → fileGitInfo state=untracked、blame available:false。
- 结束清理临时目录；`package.json` scripts 加 `"e2e:filegit": "node scripts/e2e-file-git.mjs"`，
  `npm run check` 列表加该文件。AGENTS.md 开发/验证段同步。
- **这是用户要求的「e2e 通过」的宿主侧判据之一**（连同 npm test 全绿）。

## 2. Client：textarea 叠层编辑器（只写 client.js）

### 2.1 总体

现有 git 显示（基础契约 §4）全部保留；把代码区升级为**可编辑**：透明 textarea 叠在高亮层之上
（经典 highlight-under-textarea 方案），gutter 独立成列。**不要引入 CodeMirror/任何依赖**。

### 2.2 布局（重构 ArktsCodeView）

```
.ark-root
  .ark-meta（现有 path·行数·字节 + git 段 + 脏标记 + 保存按钮）
  .ark-editor（flex:1; display:flex; min-height:0; position:relative; 边框/背景同现有 .harm-scroll）
    .ark-gutter（flex:none; overflow:hidden; user-select:none）
      .ark-gutterInner（transform: translateY(-scrollTop)）
        每逻辑行一个 .ark-gcell（高度=实测行高）内含 .ark-gitbar(2px) + .ark-lineno(染色)
    .ark-codearea（flex:1; position:relative; min-width:0）
      pre.ark-highlight（absolute inset:0; overflow:hidden; margin:0; pointer-events:none; aria-hidden）
        每逻辑行 div.ark-hl（display:block; min-height:20px）> 现有 token spans（高亮类名不变）
      textarea.ark-input（absolute inset:0; resize:none; overflow:auto; background:transparent;
        color:transparent; -webkit-text-fill-color:transparent; caret-color:var(--dsw-alias-label-primary)）
```

**度量一致性（对齐的生死线）**：pre 与 textarea 必须共享完全相同的
font（ui-monospace 栈 12px/20px）、padding（8px）、`white-space:pre-wrap`、`word-break:break-word`、
`overflow-wrap:break-word`、`tab-size:2`、letter-spacing:normal、border:none、margin:0、宽度。
行号/gutter 不再混在代码行内（基础契约的 .ark-line flex 行结构改为上述分列结构）。

### 2.3 滚动与行高同步

- textarea 是唯一滚动源：onScroll → `highlight.scrollTop/Left = ta.scrollTop/Left`；
  `gutterInner.style.transform = translateY(-ta.scrollTop)`。
- 行高实测：useLayoutEffect（lines 变化后）+ codearea 的 ResizeObserver（宽度变化→重排）→
  读每个 .ark-hl 的 offsetHeight → 设对应 .ark-gcell 高度。空行 min-height 20px；
  内容尾部空行（'a\n' → 2 行）必须渲染，与 textarea 行数一致。
- **禁止用 行号×固定行高 估算**（长行会换行）。

### 2.4 编辑行为

- 可编辑条件：内容完整加载（workspaceFiles 未截断 && readTextFile truncated=false）
  且总行数 ≤ 2000（渲染上限）。否则保持只读渲染 + meta 提示「文件过大，仅预览前 2000 行，不可编辑」。
  **绝不允许在截断内容上编辑**（会毁文件）。
- state：`draft`（textarea 值）；baseline=加载内容；`dirty = draft !== baseline`。
- tokenizeArkts 用 React.useMemo([draft]) 缓存（每次击键全文重扫，2000 行内可接受）。
- Tab：光标处插入 2 空格（优先 `document.execCommand('insertText')` 保原生 undo，
  失败回退 setRangeText）；Enter：换行 + 复制当前行前导空白（auto-indent，同样走 insertText）。
- Ctrl/Cmd+S：preventDefault + 保存；meta 保存按钮（dirty 且非 saving 时可用）。
- 保存：`remote.writeTextFile({ path, content: draft, sessionId })`（与现有 remote 调用形态一致）
  → 成功：baseline=draft、刷新 fileGitInfo + forgetBlameForPath、meta 闪「已保存」；
  失败：meta 区红字「保存失败：…」（不丢 draft）。
- 脏标记：meta「● 未保存」（warn 色）。
- **IME（中文输入法，必须处理）**：compositionstart → `ta.style.webkitTextFillColor = 'var(--dsw-alias-label-primary)'`
  让组字可见；compositionend → 恢复 'transparent'。
- 选区：`.ark-input::selection` 用品牌色 30% 半透明（高亮可透出）。
- 原生能力直接继承：undo/redo、复制粘贴、方向键/Home/End 等不做拦截。

### 2.5 悬停 blame 与编辑共存

- textarea 盖住代码区，行 div 收不到 mouseenter：改为 codearea 的 **mousemove 命中检测**——
  用实测行高前缀和 + offsetY + scrollTop 定位逻辑行，走基础契约同一套 250ms 延迟 + 记忆化；
  mouseleave/滚动隐藏。gutter 的 gcell 也可直接 hover（同一 handler）。
- git 标记反映**上次保存**状态（与抽屉编辑器一致： typing 不实时重算）；保存后刷新。
  dirty 期间标记可能随插入行漂移——已知限制，meta 脏标记已提示。

### 2.6 不做（明确排除，报告里注明）

- Ctrl+F 查找（HiLog 的查找是另一功能，不迁移）、外部磁盘变更监听、关闭标签页脏确认、
  typing 期间实时 LCS gutter。这些是后续迭代项。

### 2.7 自检

- `node --check client.js`；人工核对：度量一致性清单（§2.2）、截断禁编辑、IME 处理、
  保存后 git 刷新、高亮类名未变、组件 bundle 作用域。不跑 npm test（Lead 收尾统一跑）。

## 3. Lead 收尾（不在派工范围）

1. 审阅 diff；`npm run check` + `npm test` + `npm run e2e:filegit` 干净跑全绿。
2. UI/UX 评审子代理（verification.md 要求）→ 修正实质问题。
3. plugin_manager link 安装 + inspect 验证 slot/Remote 注册；请用户 GUI 目检（含中文输入）。
4. **发布（用户已明确授权）**：version 0.8.1→0.9.0 + CHANGELOG 段落 + extract-release-notes 预览
   + commit + tag v0.9.0 + push（CI 发 npm 与 GitHub Release）→ 等官方源 tarball 200
   → profile 升级到 published 0.9.0（remove+install）→ 验证 active。