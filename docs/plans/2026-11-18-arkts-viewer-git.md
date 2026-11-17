# ArkTS 预览器 git 信息增强 — 实现契约（2026-11-18）

> 本文档是 Host 与 Client 两个并行实现任务的**唯一契约**。两侧都只按本文档实现，
> 不得互相 import 对方未完成代码；集成由 Lead 收尾。
> 先读仓库根 `AGENTS.md`（尤其 §1–§5、常规注意事项），再读本文档。

## 0. 任务与用户决策

用户需求：dsh-deveco 的 `.ets` 代码预览器**参考抽屉插件 dsh-better-sidebar 的代码编辑器**
增加 git 信息显示，**保留现有 ArkTS 语法高亮**，**完全不依赖 dsh-better-sidebar 的代码/服务**。

用户已确认路线：**增强现有自研预览器**（不引入 CodeMirror、不加构建步骤、不加新 npm 依赖）。

参考对象（better-sidebar 0.32.1，只读参考其设计，禁止 import/复制其源码文件）：
- `src/client/editor-git-gutter.ts`：VS Code 风格 git gutter——变更行**行号染色**
  （add 绿 / mod 琥珀 / del 红）+ 行号左侧 **2px 竖条**；干净文件保留 2px 占位避免行号横移；
  **悬停行**显示该行 blame 的**纯文本 tooltip**（第一行 `作者 · 相对时间`，第二行 commit summary）。
- 行分类来自 `git diff HEAD --no-color` 统一 diff：del-run 与紧随的 add-run 按 min(len) 配对为
  `mod`（改写）；未配对 del 锚定到**缺口上方一行**（文件头部删除锚定第 1 行）；锚点不覆盖已被
  add/mod 占用的行；context 行永不标记。未跟踪文件 = 全部行 add。
- blame 来自 `git blame --porcelain -L <line>,<line> -- <path>`，**悬停才取、按 path+line 记忆化**
  （上限 500 条，超出整体清空；文件变更集刷新时丢弃该文件记忆）。
- git 环境：`GIT_OPTIONAL_LOCKS=0`（只读不拿写锁）、`LC_ALL=C`（输出稳定）；
  路径用全局 `--literal-pathspecs` + `--` 分隔，防 pathspec 通配符注入。
- 颜色取 DSH 状态色 token：success 绿 / warn 琥珀 / error 红（与文件树一致）。

**本实现的一处修正**（相对抽屉）：hunk 内 `lastNew` 初始化为 `newStart - 1`（抽屉初始 0，
-U3 下几乎总有前导 context 所以实际等价，但 -U0/无 context hunk 会错锚到第 1 行）。

## 1. 写入范围（互不重叠）

| 任务 | 允许写 | 禁止写 |
|---|---|---|
| host-git | `harmony-git.mjs`（新建）、`index.js`、`typert.host.js`、`scripts/self-test.mjs`、`AGENTS.md`、`package.json`（仅 files 列表与 description，**不改 version**） | `client.js`、README.md |
| client-viewer | `client.js` | 其余一切文件 |

- 不加任何 npm 依赖（host 侧零依赖模块惯例；client 只用 `require("react")`）。
- 不 import dsh-better-sidebar 的任何文件/服务；不复制其源码（算法语义参考 §0，代码自己写）。
- Remote 返回必须 JSON-safe：**可选字段有值才挂 key**，不用 null（AGENTS.md 常规注意事项）。
- 不做版本号变更、不写 CHANGELOG、不发布（Lead 统一决定）。

## 2. Remote 契约（两侧共同遵守）

命名空间 `harmonyDevEco`，新增 2 个方法（总数 24 → 26）。
请求统一 `{ request: {...} }` 包络（与现有 readTextFile 一致）。

### 2.1 `fileGitInfo(request)`

请求：`{ path: string, sessionId?: string }`
- `path`：绝对宿主路径，或会话工作区相对路径（正斜杠）。
- `sessionId`：相对路径时必传；Host 用它查会话 cwd。

返回 `ok(value)`，value 形状：

```js
// git 不可用（ viewer 必须照常显示代码，只是没有 git 装饰 ）：
{ available: false, reason: 'no-git' | 'no-repo' | 'no-session-cwd' | 'git-failed', message?: string }

// git 可用：
{
  available: true,
  repoRoot: string,          // git rev-parse --show-toplevel（宿主路径原样）
  branch: string,            // git branch --show-current；空（detached）→ 'HEAD'
  state: 'clean' | 'modified' | 'untracked' | 'added' | 'deleted' | 'renamed' | 'copied' | 'conflict',
  changes: [ { line: number /* 1 基 */, kind: 'add' | 'mod' | 'del' } ],  // 按 line 升序；clean/untracked/deleted 时为空数组
  added: number,             // changes 中 kind=add 的条数（untracked 时 0）
  modified: number,          // kind=mod 条数
  deleted: number,           // kind=del 条数（锚点行）
  allAdded?: boolean,        // 仅 true 时挂 key：HEAD 未出生（仓库无任何提交）且文件已暂存新增 → 客户端把全部行标 add
}
```

语义：
- `state='untracked'`：客户端把**全部行**标 add（不依赖 changes）。
- `allAdded===true`：同上（unborn HEAD 的已暂存新文件）。
- `changes` 只含变更行；`del` 的 line 是锚点行（缺口上方一行），不是被删行本身。
- 任何 git 命令失败都不得让预览器报错：降级为 `available:false`（reason 按语义选）或空 changes。

### 2.2 `fileGitBlame(request)`

请求：`{ path: string, line: number /* 正整数，1 基 */, sessionId?: string }`

返回 `ok(value)`：

```js
{ available: false, reason: 'no-git' | 'no-repo' | 'no-session-cwd' | 'git-failed' | 'no-answer', message?: string }
// 或
{
  available: true,
  entry: {
    line: number,       // 1 基
    hash: string,       // 40/64 位 hex；未提交行 = 全 0
    author: string,
    date: string,       // ISO 8601 携带作者时区偏移（isoWithOffset），如 2026-11-18T01:02:03+08:00
    summary: string,    // commit subject；未提交行 = git 自己的 'Not Committed Yet'
  },
}
```

- 只 blame 单行（`-L line,line`），不做范围、不预取。
- 未跟踪文件 / 无仓库 / 命令失败 / 解析无答案 → `available:false`（tooltip 不显示）。

### 2.3 Host 路径解析（两方法共用）

1. `path` trim 后为空 → `err('invalid-request', 'path required')`。
2. `node:path.isAbsolute(path)` → `abs = path.resolve(path)`。
3. 否则需要 sessionId：`this._ctx.get('sessions')?.get(sessionId)?.header?.cwd`
   （与官方 dsh-api-workspace-files 同款取法；`ctx.get` 是「有就用、没有就 undefined」）。
   取不到 cwd → `ok({ available:false, reason:'no-session-cwd' })`；取到 → `abs = path.resolve(cwd, path)`。
4. git 工作目录 = `path.dirname(abs)`；`repoRoot` 由 `git rev-parse --show-toplevel` 得出；
   `relPath = path.relative(repoRoot, abs)` 换正斜杠；以 `..` 开头（文件在仓库外）→ `no-repo`。
5. 所有 git 调用：`--literal-pathspecs` 全局选项**前置在子命令前**，路径参数前有 `--`。

## 3. Host 实现规格（host-git）

### 3.1 新模块 `harmony-git.mjs`（零依赖，纯函数 + 可注入执行器）

导出（命名可微调，语义不变）：

- `GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }`
- `runGitCommand({ cwd, args, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, binary = 'git' })`
  → `Promise<{ ok: boolean, stdout: string, stderr: string, code: number | null, error?: { code: string, message: string } }>`
  - `spawn(binary, args, { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true })`，**不用 shell**。
  - stdout 累计超过 maxBytes → kill 子进程，`ok:false, error.code:'output-limit'`。
  - 超时 → kill，`error.code:'timeout'`；spawn ENOENT → `error.code:'enoent'`。
  - 退出码非 0 → `ok:false`（stdout/stderr 仍返回，调用方按语义降级）。
- 命令构造（纯函数，返回 argv 数组）：
  - `buildGitRepoRootArgs()` → `['rev-parse', '--show-toplevel']`
  - `buildGitBranchArgs()` → `['branch', '--show-current']`
  - `buildGitVerifyHeadArgs()` → `['rev-parse', '--verify', 'HEAD']`
  - `buildGitStatusArgs(relPath)` → `['--literal-pathspecs', 'status', '--porcelain=v1', '--', relPath]`
  - `buildGitDiffArgs(relPath)` → `['--literal-pathspecs', 'diff', 'HEAD', '--no-color', '--unified=3', '--', relPath]`
  - `buildGitBlameArgs(relPath, line)` → `['--literal-pathspecs', 'blame', '--porcelain', '-L', `${line},${line}`, '--', relPath]`
- `parseGitStatusPorcelain(output)` → state（§2.1 枚举）：
  取第一条记录的前两个字符 XY（rename 记录 `R  old -> new` 同样只看 XY）：
  `??`→untracked；`AA|UU|DD|AU|UA|DU|UD`→conflict；X=R→renamed；X=C→copied；
  X=D 或 Y=D→deleted；X=A→added；其余含 M→modified；空输出→clean。
- `parseUnifiedDiffLineKinds(diffText)` → `{ changes, added, modified, deleted }`：
  - 解析 `@@ -a,b +c,d @@` hunk 头（b/d 可省略）；hunk 内 ` `=context、`-`=del、`+`=add、`\`开头=meta 忽略；
    非 diff 行结束当前 hunk。多文件 diff 只处理（调用方已按单文件 pathspec 取 diff，正常只有一个文件段）。
  - **配对**：每个 hunk 内，连续 del-run 与紧随的连续 add-run 按 min(len) 配对，两侧都记 mod。
  - **新侧映射**：add→`{line:newLine, kind:'add'}`；mod 的 add 侧→`{line:newLine, kind:'mod'}`；
    未配对 del→锚点 `max(1, lastNew)`，`lastNew` 初始 `newStart - 1`，遇任何带新侧行号的行更新；
    锚点已被 add/mod 占用则跳过。
  - changes 按 line 升序、每行只一条；计数为三类条数。
- `parseBlamePorcelain(output)` → `[{ line, hash, author, date, summary }]`：
  - 记录头 `^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$`（hash 原/终行号，取**终行号**）；
    后续 `author ` / `author-time `（epoch 秒）+ 紧随 `author-tz `（±HHMM）/ `summary ` 元数据行；
    每条记录以 `\t` 前缀的内容行结束。
  - 同一 hash 的元数据**只发一次**：按 hash 记忆 author/date/summary，后续记录复用。
  - `date = isoWithOffset(authorTime, authorTz)`；缺元数据补 ''。未知行跳过不致命。
- `isoWithOffset(seconds, tz)`：epoch 秒 + ±HHMM → ISO 8601 带该偏移（不依赖宿主时区）；
  tz 非法 → UTC `...Z`。实现参考：按偏移平移后用 getUTC* 拼字符串。
- `toGitRelPath(repoRoot, absPath)` → string | null：`path.relative` 换正斜杠；以 `..` 开头或绝对 → null。
- **编排器**（可注入 runGit，便于假执行器单测 + 真 git 集成测试）：
  - `collectFileGitInfo(runGit, absPath)` → §2.1 value（不含路径解析；absPath 已解析）。
    流程：rev-parse（失败/enoent → no-git/no-repo）→ status → branch → verify HEAD（判断 unborn）
    → state=untracked/deleted/clean 直接返回（changes=[]）→ diff HEAD 解析；
    diff 失败且 state=added 且 unborn → `allAdded:true`；其余 diff 失败 → changes=[]（state 保留）。
    enoent 一律 `no-git`；rev-parse 非 0 → `no-repo`；其它意外失败 → `git-failed`（附 message）。
  - `blameFileLine(runGit, absPath, line)` → §2.2 value。rev-parse → blame → 解析取 line 匹配项；
    任何失败/无匹配 → `available:false`（reason 对应）。

### 3.2 `index.js`

- import harmony-git.mjs；`[Service.init]` 里 `markRemoteMethod(this, 'fileGitInfo', 'fileGitInfo')`、
  `markRemoteMethod(this, 'fileGitBlame', 'fileGitBlame')`（紧随 readTextFile 之后）。
- 在 `// ---- file viewer ----` 区新增两个方法：做 §2.3 路径解析（sessionId → sessions.header.cwd），
  然后调编排器；runGit 绑定 `runGitCommand`。非法请求（path 空 / blame line 非正整数）→ `err('invalid-request', ...)`。
- 不改其它方法；不动 agent 工具注册。

### 3.3 `typert.host.js`

- 新请求 schema：`fileGitInfoRequestSchema = z.object({ path: z.string().readonly(), sessionId: z.string().optional().readonly() }).readonly()`；
  `fileGitBlameRequestSchema` 再加 `line: z.number().readonly()`。
- 新 value schema：按 §2 形状，可用字段全部 `.optional().readonly()`（available 除外），
  changes 元素 `{ line: z.number(), kind: z.union([z.literal('add'), z.literal('mod'), z.literal('del')]) }`。
- `iv('fileGitInfo', ...)`、`iv('fileGitBlame', ...)` 两条 invocation（summary/jsDoc 写清用途与降级语义）。
- `model.services[0].members` 追加两个 method 成员（signature 形如
  `@Remote('fileGitInfo') async fileGitInfo(request: HarmonyDevEcoFileGitInfoRequest): Promise<HarmonyDevEcoFileGitInfoResult>`）。

### 3.4 `scripts/self-test.mjs`（host-git 独占）

- 现有 `TYPERT.invocations.length === 24` 断言改 **26**。
- 新增测试（目标 ≥ 15 条）：
  1. status 解析各形态（clean/??/ M/M /MM/A /AM/ D/D /R/UU/C）。
  2. diff 行分类：纯 add；文件头纯 del → 锚 1；context 后 del → 锚 lastNew；del+add 配对 mod；
     多 hunk；`\ No newline` 忽略；context 不标记；锚点不覆盖 add/mod；hunk 头偏移（newStart-1 初始化）。
  3. blame porcelain：同 commit 多行元数据复用；两个 commit；全 0 hash + Not Committed Yet；
     author-tz → ISO 偏移；非法行跳过。
  4. isoWithOffset：+0800 / -0500 / 非法 tz。
  5. toGitRelPath：仓库内（Windows 反斜杠 → 正斜杠）/ 仓库外 → null。
  6. 命令构造：--literal-pathspecs 前置、-- 分隔、-L 范围串。
  7. **真 git 集成**（本机 git 2.53 可用）：mkdtemp 临时仓库，`git init` + 本地 user.name/email，
     提交基线文件 → 工作区改写若干行 → 真 runGitCommand + collectFileGitInfo 断言 state/changes/counts/branch 非空；
     未跟踪新文件 → untracked；干净文件 → clean；blameFileLine 返回 author/summary；
     未跟踪文件 blame → available:false。测试结束清理临时目录。不断言默认分支名。
  8. runGitCommand：`git --version` ok；binary 不存在 → error.code='enoent'。
  9. TYPERT 新方法：strict 双形态 codec、请求/返回 safeParse 正反例、**assertJsonSafe 复刻**
     （available:false 与 available:true 两种形状都过）。
- 现有测试不得破坏。跑 `npm run check` 与 `npm test` 全绿后才算完成。

### 3.5 文档同步（host-git）

- `AGENTS.md`：目录树加 `harmony-git.mjs` 行；§5 标题「24 个 Remote 方法」→「26 个 Remote 方法」，
  表格加 `fileGitInfo` / `fileGitBlame` 两行；index.js 行的「24 个」→「26 个」；
  顶部项目描述里 .ets 查看器一句补「git 变更行标记 + 悬停 blame」；
  测试计数（158）改为实际值（`npm test` 输出为准）。
- `package.json`：`files` 加 `"harmony-git.mjs"`；description 的查看器子句补 git 能力。**不改 version**。

## 4. Client 实现规格（client-viewer，只写 client.js）

### 4.1 Remote 声明

`CLIENT_REMOTE.descriptors` 追加 `method('fileGitInfo', ['request'])`、`method('fileGitBlame', ['request'])`。

### 4.2 数据流（ArkTSViewerTab）

- 现有内容加载逻辑不变（workspaceFiles 分页 + absolute 回退 readTextFile）。
- 内容加载成功后调 `remote.fileGitInfo({ request: { path: parsed.path, sessionId: parsed.scope === 'session' ? parsed.sessionId : undefined } })`
  ——注意现有 remote 调用形态：`remote.readTextFile({ path })` 是**直接传请求对象**（client 侧 method()
  声明的参数名是 request，但现有代码 `remote.readTextFile({ path: parsed.path })` 直接传对象即可，
  保持与现有调用完全一致的形态：`remote.fileGitInfo({ path, sessionId })`）。
  unwrap() 归一化；失败/异常 → gitInfo=null（静默，代码照常显示）。
- state 增加 `gitInfo`（value 或 null）、`gitLoading`。刷新按钮 → 重新请求 + 丢弃该 path 的 blame 记忆。
- blame 记忆化：factory 作用域 `Map`，key = `path + '\0' + line`，value = Promise<entry|null>；
  上限 500，超出整体 clear；`forgetBlameForPath(path)` 在 gitInfo 刷新时调用。
  请求 `remote.fileGitBlame({ path, line, sessionId? })`；任何失败 → null。
  **untracked / allAdded 文件不请求 blame**（git 无答案，省往返）。

### 4.3 渲染（ArktsCodeView）

- **tokenizeArkts 结果用 React.useMemo([content]) 缓存**（现状每次 render 全文重扫，
  加了 hover state 后必须缓存）。
- kinds 映射（useMemo 依赖 gitInfo）：不可用 → 空；untracked/allAdded → 渲染范围内全部行 add；
  否则由 changes 建 Map<line, kind>。
- 每行结构（保持现有 .ark-line/.ark-lineno/.ark-code 类名与高亮 token 类名不变）：
  ```
  div.ark-line[data-line]
    span.ark-gitbar(.ark-gitbar-add|mod|del)   // 2px 竖条；无变更也渲染透明占位（行号不横移）
    span.ark-lineno(.ark-lineno-add|mod|del)   // 行号染色
    span.ark-code > token spans                // 现有高亮原样保留
  ```
- 行 onMouseEnter/onMouseLeave → 父级回调（带 line 与 currentTarget）。
- 保留现有 2000 行渲染截断与 meta 行（path · N 行 · 字节 · 截断提示）。

### 4.4 悬停 blame tooltip

- 250ms 悬停延迟（setTimeout，离开/滚动取消）；取到 entry 且仍悬停同一行才显示。
- tooltip 为 **absolute 定位在行列表的 position:relative 包裹层内**（随内容滚动，不用 fixed/portal）：
  位置用 `lineEl.getBoundingClientRect()` 与包裹层 rect + scrollTop 换算，显示在该行上方（夹到 ≥0），
  left 约 64px（让过 gutter）。行长会换行（.ark-code pre-wrap），**禁止用 行号×固定行高 估算**。
- 内容纯文本两行：`作者 · 相对时间`（secondary 色）+ summary（primary 色，word-break）。
  未提交行（hash 全 0）照常显示 git 的 'Not Committed Yet'。
- 滚动容器 onScroll → 隐藏 tooltip + 取消 pending。鼠标离开行 → 隐藏。
- relativeTime(iso)：中文——<60s 刚刚；<60min N 分钟前；<24h N 小时前；<30d N 天前；否则 YYYY-MM-DD。
  非法日期 → 原串截断显示。

### 4.5 meta 行 git 段

- gitLoading → 灰字「git…」；gitInfo=null 且非 loading → 不显示 git 段（请求失败静默）。
- available:false → 灰字：no-git「未安装 git」/ no-repo「非 git 仓库」/ no-session-cwd「无法定位工作目录」/ git-failed「git 查询失败」。
- available:true → `⎇ {branch}` 徽章 + state 文案（clean 干净 / modified 已修改 / untracked 未跟踪 /
  added 已暂存新增 / deleted 已删除 / renamed 重命名 / copied 复制 / conflict 冲突）
  + 变更计数（仅 modified/added 且计数非零时显示 `+{added} ~{modified} −{deleted}`，三色）
  + untracked 显示「全部行视为新增」不显示计数 + 刷新按钮「↻」（title 刷新 git 信息）。

### 4.6 CSS（追加到现有 CSS 模板串，颜色一律 DSH token）

- 竖条/行号三色：`--dsw-alias-state-success-primary,#2fb37d` / `--dsw-alias-state-warn-primary,#f5b942` /
  `--dsw-alias-state-error-primary,#e5484d`。
- tooltip：`background:var(--dsw-alias-bg-layer-2)`、`border:1px solid var(--dsw-alias-border-l2)`、
  `color:var(--dsw-alias-label-primary)`、圆角 6px、font-size 11px、max-width 420px、
  pointer-events:none、z-index 高于行内容（如 30）。
- 徽章/计数/刷新按钮风格与现有 .harm-badge/.harm-btn 一致（小尺寸 11px）。
- 组件一律 bundle 作用域定义（AGENTS.md §3），禁止内联创建组件。

### 4.7 自检

- `node --check client.js` 通过。
- 人工核对：CLIENT_REMOTE 两个新 descriptor；unwrap 用法；git 失败不影响代码显示；
  高亮类名（ark-kw/str/num/com/deco/fn/type）与 token 逻辑未被改动。
- 不运行 npm test（host 侧在并行改 self-test，Lead 收尾统一跑）。

## 5. 集成与验证（Lead，不在派工范围）

1. 审阅两侧 diff；`npm run check` + `npm test` 干净跑全绿。
2. 网关 RPC 真调 `harmonyDevEco/fileGitInfo` / `fileGitBlame`（本仓库自身就是 git 仓库，
   用真实 .ets 路径与故意制造的未提交改动验证 kinds/blame）。
3. link 安装本仓库到 web profile（removeBundle + installBundle 本地路径），确认 Remote 生效。
4. GUI 打开 .ets 验证：高亮保留、变更行标记、悬停 blame、干净/未跟踪/无仓库形态。