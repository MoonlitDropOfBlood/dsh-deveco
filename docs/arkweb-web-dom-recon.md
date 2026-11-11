# ArkWeb Web DOM 真机实测记录

日期：2026-11-11  
设备：HUAWEI Mate 70（HarmonyOS / OpenHarmony 7.0，`ArkWeb/7.0.0.111`）  
应用：`com.jfzt.uranus`（九方智投，Web 页面已由应用开启 `setWebDebuggingAccess(true)`）

## 结论

插件通过 ArkWeb 自带 Chromium DevTools 读取 Web DOM 的链路已在真机跑通：

```text
/proc/net/unix
  → @webview_devtools_remote_34717
  → hdc fport tcp:<local> localabstract:webview_devtools_remote_34717
  → GET /json
  → ws://127.0.0.1:<local>/devtools/page/B9AECD3F52F1979D030405C7C8FDBC77
  → DOM.getDocument
  → DOM.querySelector / DOM.describeNode
  → DOM.getOuterHTML
  → hdc fport rm
```

## 实测事实

- socket 名中的 pid 解析为应用主进程 `34717`；`/proc/34717/cmdline` = `com.jfzt.uranus`。
- `/json` 返回 `200 application/json; charset=UTF-8`，一个 `type:"page"` target，title `九方智投`。
- `/json/version`：
  - `Browser: Chrome/144.0.7559.59`
  - `Protocol-Version: 1.3`
  - `V8-Version: 14.4.258.16`
  - `ArkWeb/7.0.0.111 Mobile`
- Node 24 内置标准 WebSocket **可以直接连接** `/devtools/page/<id>`；握手未发送 `Origin`。
- 真实可用的 DOM 命令：
  - `DOM.getDocument`
  - `DOM.querySelector`
  - `DOM.describeNode`
  - `DOM.getOuterHTML`
- 全页 `depth=6` 读取得到 133 个节点，outerHTML 约 122 KB。
- `body` 子树 `depth=4` / `maxNodes=500` 读取得到 74 个节点，`truncated:true`，`hiddenNodes:11`。
- `div.article-title` 的真实 outerHTML：

  ```html
  <div class="article-title have-auth" style="padding-top:calc(33.84615384615385px + 1.1rem)"><span>行业迎来新叙事？！一图看懂AI游戏产业链公司</span></div>
  ```

- 不存在的选择器稳定返回：

  ```json
  {"code":"selector-not-found","message":"CSS 选择器没有命中任何节点：#does-not-exist"}
  ```

## 真机踩坑

1. **`DOM.describeNode` 的后代可能返回 `nodeId: 0`**
   - 只有子树根有真实 nodeId，未 push 到前端节点映射的后代全部为 0。
   - 旧实现按 nodeId 去重计数，导致 `nodeCount` 错误地只有 2。
   - 修复：原始节点计数只按对象身份去重（`WeakSet`），不再依赖 nodeId。

2. **`DOM.getOuterHTML` 对 Document 节点可能不适合直接序列化**
   - 读取时若根是 `nodeType === 9`，取第一个元素子节点（documentElement）再取 outerHTML。

3. **fport 回调返回值不是 Host 包络**
   - 一次性 fport 包装器必须把业务回调结果重新包成 `{ok:true,value}`，否则列表/读取会把数组或 wire 对象误判为失败。
   - 真机第一次完整 Host 调用暴露了该错误，已修复并补单测。

4. **`/proc/net/unix` 的 `@` 前缀**
   - 解析时只保留 `webview_devtools_remote_<pid>`，fport 的 `localabstract:` 目标不需要 `@`。

## 清理验证

- 插件自动 fport 操作结束后 `hdc fport ls` 为 `[Empty]`。
- 手工验证用的 19011 规则也已显式删除，无残留。

## 尚未覆盖

- 多个 Web 组件同时存在时的多 target 选择。
- iframe / OOPIF / shadow DOM 的真机表现。
- 页面导航后 target id 是否保持、nodeId 失效行为。
- Chrome DevTools 前端与本插件同时连接同一 target。
- API 20+ 无线直连调试端口模式。
