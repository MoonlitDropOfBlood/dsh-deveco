# ArkTS 运行时调试（Remote Debugger）链路调研

> 目标：给 dsh-deveco 插件（Node Host）提供「attach ArkTS 调试器 → 断点/暂停/单步/调用栈/求值/日志」的可落地协议规格。
> 调研手段：反编译 DevEco Studio 26.0.0.821 的相关 jar + 解析 hdc 二进制内建帮助 + **模拟器真机实测**（可调试应用 `io.duke.myapplication`）。
> 置信度标注：**确定**＝有实测报文 / 官方二进制帮助 / 双重证据；**推测**＝仅代码或日志推断。
> 与既有 `uiDevEcoTree`（ArkUI Inspector）通道的关系见 §0.2 —— 两者**共用** hdc `ark:` 转发与同一套「裸 socket WS 握手」，但**WS 之后是两套完全不同的 JSON 协议**。

---

## 0. 结论速览

### 0.1 TL;DR（可直接照抄的实现路线）

```
① 找可调试进程   hdc jpid / hdc track-jpid -a       （track-jpid -p <pid> 单进程跟踪）
② （可选）待调试  hdc shell aa appdebug -b <bundle>   ← 「等一下调试器」，实测会让应用停在入口
③ 端口转发       hdc fport tcp:<本地端口> ark:<pid>@Debugger
④ 裸 socket WS   GET / HTTP/1.1 + 6 头 → 101 Switching Protocols   （与 Inspector 同一套握手！）
⑤ 协议           Chrome DevTools Protocol 风格 JSON-RPC（**但错误放在 result.code/result.message**）
⑥ 初始化         Runtime.enable → Debugger.enable（回包 protocols[] ＝能力协商）→ Runtime.runIfWaitingForDebugger
⑦ 事件           Debugger.scriptParsed（scriptId + url）/ Debugger.paused（callFrames）/ Debugger.resumed …
⑧ 断点           Debugger.setBreakpointByUrl {url|urlRegex, lineNumber, columnNumber?, condition?}
                 Debugger.getPossibleAndSetBreakpointByUrl {locations:[{url,lineNumber,columnNumber}]}（Panda 系）
                 Debugger.removeBreakpointsByUrl {url}
⑨ 清理           hdc fport rm tcp:<本地端口> ark:<pid>@Debugger
```

### 0.2 与 ArkUI Inspector 通道对照

| 维度 | ArkUI Inspector（已实现 `uiDevEcoTree`） | ArkTS 运行时调试（本文） |
|---|---|---|
| fport 远端 | `ark:<pid>@<包名>` | `ark:<pid>@Debugger`（三段的 `ark:<pid>@<tid>@Debugger` 见 §2.1） |
| 传输 | 裸 socket + 6 头 WS 握手 | **同** |
| 应用层 | 自定义 `{"type":"connected"/"inspectorAbilities"/"tree"}` | **CDP 风格 JSON-RPC**：`{id,method,params}` / `{id,result}` + 事件 `{method,params}` |
| 单客户端 | 是（IDE 占用则失败） | 是（同一 `ark:` 单元，同一时刻只有一个调试会话） |
| 用途 | 组件树 + 盒模型声明值 | 断点/单步/调用栈/求值/异常暂停 |

---

## 1. DevEco 如何发现可调试应用并建立连接

### 1.1 进程发现：`hdc jpid` / `hdc track-jpid`（确定）

hdc 顶层命令（`hdc.exe` 内建帮助，实测 `hdc.exe` 字符串）：

```
 jpid                - List PIDs of processes hosting a JDWP transport
 track-jpid [-a|-p]  - Track PIDs of debug processes hosting a JDWP transport
```

实测（模拟器 127.0.0.1:5555，HarmonyOS 6.0.0 / API 20）：

```bash
$ hdc -t 127.0.0.1:5555 jpid
1396
1493
1533
1561
1639
...

$ hdc -t 127.0.0.1:5555 track-jpid -a          # 持续推送
01c2                                          ← 4 位十六进制长度头（hdc track 协议帧头）
1396 com.huawei.emulatormultiscreen release
1493 com.ohos.sceneboard release
1810 com.huawei.hmos.inputmethod/com.huawei.hmos.inputmethod:inputMethod release
1958 com.ohos.sceneboard/com.ohos.sceneboard:EngineServiceAbility:1 release
```

- `track-jpid -a` 每行 `"<pid> <bundleName>[:<abilityName>[:<instance>]] <appProvisionType>"`，`release`/`debug` 可区分（**确定**）。
- 首行形如 `01c2` 是 hdc 的分块长度前缀——我们的解析器要跳过非数字/非 `pid bundle type` 形态的首行（**确定**，实测）。
- 设备侧控制通道是 Unix 抽象 socket **`@ohjpid-control`**（`netstat -an | grep LISTENING` 实测可见；`jpid`/`track-jpid` 就是跟它说话）。（**确定**）
- DevEco 侧对应实现：`ohos-hdclib-26.0.0.821.jar` 的
  `com/huawei/deveco/hdclib/ohos/client/Command`：`TRACK_APP_COMMAND="track-jpid -p"`、`TRACK_APP_COMMAND_WITH_TYPE="track-jpid -a"`；
  `com/huawei/deveco/hdclib/ohos/devices/DeviceAppClientMonitor` 直接对 hdc server 开 socket channel 发 `track-jpid -p`（日志：`The track-jpid -p communication channel is successfully established.`）。（**确定**）

### 1.2 「可调试」判定：`bm dump` + 权限 + 签名（确定）

DevEco `DebugClient`（hdclib）在拿到 pid 后跑 `bm dump -n <bundle>` 解析 fastjson，检查两件事：

- `hmos.permission.kernel.ALLOW_DEBUG` 权限（`HdcConstants.ALLOW_DEBUG`，字段路径 `reqPermissions`）
- `applicationInfo.appProvisionType == "debug"`（调试签名）

实测同一判定可用：

```bash
$ hdc -t ... shell "bm dump -n io.duke.myapplication | grep -iE 'appProvisionType|\"debug\"'"
        "appProvisionType": "debug",
        "debug": true,
```

→ **调试签名（appProvisionType=debug）+ debug:true** 是能连上 ArkTS 调试器的前提（**确定**，实测该应用可连；模拟器系统应用如 `com.huawei.emulatormultiscreen` 虽出现在 `jpid` 里但 `fport` 后 TCP 立即被关闭，见 §6）。

### 1.3 待调试启动：`aa appdebug` / `aa attach`（确定命令存在；效果部分实测）

DevEco 侧字符串（`ohos-debugger-26.0.0.821.jar`）：

| 命令 | 出处类 | 用途 |
|---|---|---|
| `aa appdebug -b %s` | `debugger/ohos/waitdebug/AppWaitDebugCommandProcess` | 把 bundle 标记为「等待调试器」（DevEco 的 *Attach to Process by Name*） |
| `aa appdebug -g` | 同上（`QUERY_WAIT_DEBUG_COMMAND`） | 查询当前等待列表 |
| `aa appdebug -c` | 同上（`CANCEL_WAIT_DEBUG_COMMAND`） | 取消 |
| `aa attach -b %s` | `ace/debug/…` / `ohos-debugger` | 表单类 Ability 的 attach（Inspector 也用 `aa attach`） |
| `aa force-stop <bundle>` | `ace/debug/utils/DebugResourceDispose` | 结束调试进程 |
| `bm dump -n %s \| grep %s` | `ohos-debugger` | 取应用信息 |

实测：

```bash
$ hdc -t ... shell "aa appdebug -b io.duke.myapplication"   → app debug successfully.
$ hdc -t ... shell "aa appdebug -g"
bundle name : io.duke.myapplication, persist : false        ← persist:false = 一次性
$ hdc -t ... shell "aa start -a EntryAbility -b io.duke.myapplication"
start ability successfully.
```

实测结论：**带 appdebug 标记启动 + 立刻 attach 时，调试会话在应用入口处产生 `Debugger.paused`（reason=`Break on start`）**（**确定**，见 §3.3 报文）。
补充（**推测**，4 次尝试只成功 1 次）：该「等待调试器」状态可能被上一次 `aa start` 消耗（`persist:false`），重试时需重新 `aa appdebug -b`，并且要在应用启动前/启动瞬间 attach。
已试过但**未能复现**入口等待的变体：`aa appdebug -c` 后重新 `-b`、`aa appdebug -b` → `force-stop` → `start`、`aa appdebug -b` → `start -D`（见下）、换一个从未调试过的 debug 应用（`io.duke.websocket`）——这几种情况下 attach 得到的都是「无 scriptParsed、pause 不生效」的空会话。

> `aa start` 支持 `-D`（调试模式）启动（`aa start -h` 实测：`[-D]`），是 `aa appdebug -b` 之外的另一条「让应用等调试器」的候选路径；本次实测 `aa start -D` 未观察到入口暂停（**未验证/推测**），建议后续在真机上再对齐一次。

### 1.4 `hdc fport` 目标语法（确定：hdc 自述 + 实测）

`hdc.exe` 内建帮助原文（`fport` 段，实测提取）：

```
forward commands:
 fport localnode remotenode            - Forward local traffic to remote device
 rport remotenode localnode            - Reserve remote traffic to local host
                                         node config name format 'schema:content'
                                         examples are below:
                                         tcp:<port>
                                         localfilesystem:<unix domain socket name>
                                         localreserved:<unix domain socket name>
                                         localabstract:<unix domain socket name>
                                         dev:<device name>
                                         jdwp:<pid> (remote only)
                                         ark:pid@tid@Debugger
 fport ls                              - Display forward/reverse tasks
 fport rm taskstr                      - Remove forward/reverse task by taskstring
```

- 官方唯一写出的 `ark:` 形态是 **`ark:pid@tid@Debugger`**（三段）。hdc 内部合法 schema 集合＝`tcp:` `localabstract:` `localreserved:` `localfilesystem:` `dev:` `jdwp:` `ark:`（`translate.cpp` 常量）。
- 实测**两段式也成立**：`hdc fport tcp:19011 ark:3308@Debugger` → `Forwardport result:OK`，且随后 WS 握手 101（**确定**）。
- DevEco 真实日志里三种都出现过（`DevEcoStudio6.1/log/idea*.log`）：

```
AbstractOpenForwardOperation - createForward tcp port:15037 ark:9979@***.myapplication, result:Forwardport result:OK   ← Inspector（@包名）
AbstractOpenForwardOperation - createForward tcp port:15046 ark:36916@Debugger,          result:Forwardport result:OK   ← ArkTS 调试器（两段）
AbstractOpenForwardOperation - createForward tcp port:15045 ark:36916@37353@Debugger,    result:Forwardport result:OK   ← 三段（带 tid）
```

> 日志里的包名被 `CommonUtil.maskPackageName` 掩成 `***.<最后一段>`（recipe `"***.<A>"`），**只影响日志**，真实命令用的仍是完整包名（实测两段式用完整 bundle 才能连 Inspector；调试器用字面量 `Debugger`）。

- `fport ls` 实测输出（含设备序列号前缀）：

```
127.0.0.1:5555    tcp:19001 ark:1396@Debugger    [Forward]
```

- 清理用 `hdc fport rm tcp:<port> ark:<pid>@Debugger`（实测回 `Remove forward ruler success, ruler:...`）。**注意**：既有插件已实证 `--remove` 不是合法子命令（会静默失败并泄漏规则），必须用 `rm` 子命令（**确定**，本仓库既有结论 + 本次复测）。

### 1.5 设备侧 socket 名（部分确定）

- 实测在调试会话**活跃时**扫 `/proc/net/unix` 与 `netstat -an`，**没有**出现任何 `*Debugger*`/`*inspector*` 命名的 socket（只有 `@ohjpid-control`、`/dev/unix/socket/*`）。→ 应用侧调试 socket **不是**普通 `localabstract` 抽象 socket（**确定：不在 /proc/net/unix 里**）。
- 因此 `ark:<pid>@Debugger` 由 hdc daemon 侧解析（hdc 自己按 pid + 服务名去连应用内部通道），**不需要我们关心具体 socket 名**（**确定**：只要 `fport ... ark:...` 成功 + 握手 101 即可用）。
- DevEco 里唯一与 socket 名相关的探针是 `source-map-26.0.0.821.jar` 的 `com/huawei/deveco/sourcemap/util/ForwardOperation`：
  `netstat -an | grep LISTENING | grep @<A><A>`（用于判断「转发目标是否已在监听」，两个占位符＝pid 与转发策略名）。**推测**：设备侧抽象名形如 `@<pid>…<service>`；不影响本方案。

### 1.6 DevEco 的端口分配（确定）

- `PandaConstants.INITIAL_WS_PANDA_PORT`（int 常量）+ `PandaDevToolsServiceWrapper`/`DevToolsServiceWrapper` 的 `PORT_QUEUE`/`addPortToQueue`/`isPortOccupied`：从固定起始端口（实测日志里是 **15037** 起）逐个试探可用端口。
- 与 Inspector 的 `ConnectServerSession` 共用 15037 起点（实测本仓库 Inspector 用 15037；调试器日志首例也是 15037，冲突时 +1）。我们自己实现时**用 0 让系统分配或自选空闲端口**即可（Inspector 侧既有实现就是每次新建端口）。

---

## 2. 传输层

### 2.1 连接与握手（确定：模拟器实测报文）

```
TCP → 127.0.0.1:<本地端口>（hdc fport 映射到设备）
→ 发送正好 6 个头的升级请求（Java-WebSocket 默认形态，与 Inspector 完全一致）：

GET / HTTP/1.1
Connection: Upgrade
Host: 127.0.0.1:19011
Sec-WebSocket-Key: <16 字节随机 base64>
Sec-WebSocket-Version: 13
Upgrade: websocket

← HTTP/1.1 101 Switching Protocols
```

- **必须裸 socket 手写这 6 个头**：应用侧 HTTP 解析器是手写极简实现，Node 自带 `WebSocket`（WHATWG）会加 `sec-websocket-extensions`/`user-agent`/`sec-fetch-mode` 等被判 `HTTP upgrade parameters failure`（本仓库 Inspector 阶段已实证，本次调试器复现同一行为=可复用同一实现）。
- 复用本仓库既有实现即可：`harmony-device.mjs` 的 `buildDevEcoWsHandshake` / `encodeWsClientTextFrame`（客户端帧必须 MASK）/ `decodeWsServerFrames` / `encodeWsPongFrame`。本次探针就是直接 import 这些函数跑通的（`docs/recon-scripts/arkts-debug-probe.mjs`）。
- WS URL 无路径无查询：DevEco `PandaConstants.WS = "ws://127.0.0.1:"`，日志实测 `Connecting to ws server ws://127.0.0.1:15045`（**确定**）。
- 应用层消息为 **WebSocket 文本帧 + UTF-8 JSON**；`java_websocket` 客户端只收字符串（`WebSocketServiceImpl.send(String)`）。（**确定**）

### 2.2 帧/超时细节

- 服务端可能发 PING，需回 MASK 的 PONG（既有 `encodeWsPongFrame`）。
- DevEco 侧断线策略：`DevToolsSocketClient`(`extends WebSocketClient`)：`MAX_RETRIES`/`RETRY_INTERVAL` 常量 + `PandaUtils.reconnectWs`；断开日志 `websocket close: %d, reason: %s`、`The socket server is closed abnormally. code: %d`（**确定：类与字符串在 jar 内**）。
- DevEco 请求超时：`PandaDevToolsServiceConfiguration.readTimeout` + `PandaInvocationResult.waitForResult(timeout, TimeUnit)`，超时抛 `PandaDevToolsInvocationException`。我们建议默认 5–10s/请求，暂停类操作单独放宽。

---

## 3. 应用层协议（CDP 风格 JSON-RPC）

### 3.1 报文形态（确定，实测）

```jsonc
// 请求（id 自增，method = "<Domain>.<method>"，params 可为 {}）
{"id":1,"method":"Runtime.enable","params":{}}

// 成功响应
{"id":1,"result":{...}}

// 事件（无 id）
{"method":"Debugger.scriptParsed","params":{...}}

// ❗错误：不是 JSON-RPC error，而是塞进 result 里的 code/message（实测）
{"id":4,"result":{"code":1,"message":"wrong params"}}
{"id":8,"result":{"code":1,"message":"Unknown file name."}}
{"id":9,"result":{"code":1,"message":"Can only perform operation while paused"}}
```

- 因此客户端判定成功必须：`res.result && res.result.code === undefined`（**确定**，这是最容易踩的坑：CDP 库会把 `code/message` 当业务结果）。
- 错误 message 实测样例：`wrong params`、`Unknown file name.`、`Can only perform operation while paused`、`Unknown method: getStackTrace`、`unknown method: evaluate`、`SaveAllPossibleBreakpoints: protocol is not enabled`、`GetPossibleAndSetBreakpointByUrl: no pennding breakpoint exists`（原文拼写 `pennding`）。
- DevEco 侧对应类：`panda-debug-adapter-26.0.0.821.jar`
  - `com/huawei/deveco/panda/websocket/services/types/MethodInvocation`（`id`/`method`/`params`）
  - `…/services/impl/ErrorMessageObject`（`code`/`message`/`data`）
  - `…/services/impl/PandaDevToolsServiceImpl`（`invocationResultMap` 按 id 派发、`eventNameToHandlersMap` 按事件名派发、`@EventName` 注解）
  - `…/services/impl/DevToolsSocketClient`（`httpStatus is 101` ← 日志实证同一处）

### 3.2 方法/事件全集（从 jar 的协议模型类反解 = 客户端共享同一份 schema）

`com/huawei/deveco/panda/websocket/protocol/commands/*`（生成式 CDP 模型）：

**Debugger**（`protocol/commands/Debugger.class`）：
`enable` `disable` `continueToLocation` `evaluateOnCallFrame` `callFunctionOn` `getPossibleBreakpoints`
`getPossibleAndSetBreakpointByUrl` `saveAllPossibleBreakpoints` `getScriptSource` `getWasmBytecode`
`getStackTrace` `pause` `removeBreakpoint` `removeBreakpointsByUrl` `restartFrame` `dropFrame` `resume`
`searchInContent` `setAsyncCallStackDepth` `setBlackboxPatterns` `setBreakpointByUrl` `setBreakpointOnFunctionCall`
`setBreakpointsActive` `setPauseOnExceptions` `setReturnValue` `setScriptSource` `setSkipAllPauses`
`setVariableValue` `stepInto` `stepOut` `stepOver` `setNativeRange` `resetSingleStepper` `smartStepInto`
`setSymbolicBreakpoints` `removeSymbolicBreakpoints`

**Runtime**：`enable` `runIfWaitingForDebugger` `evaluate` `callFunctionOn` `getProperties` `getHeapUsage`
**Console**：`enable` `disable` `clearMessages`
**Profiler / HeapProfiler**：`Profiler.*`（`enable`/`start`/`stop`/`globalInfo`…）、`HeapProfiler.*`（快照分块事件等）

**事件**（`protocol/events/**`）：
`Debugger.scriptParsed` `Debugger.scriptFailedToParse` `Debugger.paused` `Debugger.resumed`
`Debugger.breakpointResolved` `Debugger.nativeCalling` `Debugger.mixedStack`（ArkTS 特有：native 边界）
`Runtime.executionContextDestroyed` `Runtime.consoleAPICalled`
`Console.messageAdded` `HeapProfiler.addHeapSnapshotChunk|heapStatsUpdate|lastSeenObjectId`

> 实测日志里这些事件名真实出现过（`idea*.log`：`debug event: Debugger.paused|scriptParsed|scriptFailedToParse|resumed|breakpointResolved|nativeCalling|mixedStack|Runtime.executionContextDestroyed|Runtime.consoleAPICalled|Console.messageAdded`）。（**确定**）

**Panda 专有能力广告**（`Debugger.enable` 回包 `protocols[]`，实测原文）：

```json
{"debuggerId":"0","protocols":[
 "removeBreakpointsByUrl","setMixedDebugEnabled","replyNativeCalling",
 "getPossibleAndSetBreakpointByUrl","dropFrame","setNativeRange","resetSingleStepper",
 "callFunctionOn","smartStepInto","saveAllPossibleBreakpoints",
 "setSymbolicBreakpoints","removeSymbolicBreakpoints"]}
```

→ **能力协商首选方案**：attach 后读 `Debugger.enable` 的 `protocols`，列表里有 `getPossibleAndSetBreakpointByUrl`/`saveAllPossibleBreakpoints` 才用 Panda 系断点 API（**确定**）。

### 3.3 实测报文样例（模拟器，`io.duke.myapplication`）

```jsonc
// 1) 握手
<< HTTP/1.1 101 Switching Protocols

>> {"id":1,"method":"Runtime.enable","params":{}}
<< {"id":1,"result":{"protocols":[]}}

>> {"id":2,"method":"Debugger.enable","params":{"maxScriptsCacheSize":100000000}}
<< {"id":2,"result":{"debuggerId":"0","protocols":[ ...见 3.2... ]}}

// 2) 脚本
<< {"method":"Debugger.scriptParsed","params":{"scriptId":"0",
      "url":"entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts",
      "startLine":0,"startColumn":0,"endLine":0,"endColumn":0,
      "executionContextId":0,"hash":"","locations":[]}}

// 3) 入口暂停（应用在等调试器）
<< {"method":"Debugger.paused","params":{"reason":"Break on start","hitBreakpoints":[],
      "callFrames":[{"callFrameId":"0","functionName":"func_main_0",
        "location":{"scriptId":"0","lineNumber":-1,"columnNumber":0},
        "url":"entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts",
        "scopeChain":[
          {"type":"local","object":{"type":"object","className":"Object","description":"Object","objectId":"0"},
           "startLocation":{"scriptId":"0","lineNumber":-1,"columnNumber":0},
           "endLocation":{"scriptId":"0","lineNumber":0,"columnNumber":0}},
          {"type":"module","object":{"type":"object","className":"Object","objectId":"1"}},
          {"type":"global","object":{"type":"object","className":"global","objectId":"2"}}],
        "this":{"type":"undefined"}}]}}

>> {"id":3,"method":"Debugger.setBreakpointsActive","params":{"active":true}}
<< {"id":3,"result":{}}

>> {"id":4,"method":"Runtime.runIfWaitingForDebugger","params":{}}
<< {"id":4,"result":{}}          ← 放行「等待调试器」的应用（关键！）

// 4) 断点（url 已注册时）
>> {"id":5,"method":"Debugger.setBreakpointByUrl",
    "params":{"lineNumber":10,"url":"entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts"}}
<< {"id":5,"result":{"breakpointId":"id:10:0:entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts",
      "locations":[{"scriptId":"0","lineNumber":10,"columnNumber":0}]}}

// 5) Panda 系断点（形如「批量 + 可能位置」）
>> {"id":6,"method":"Debugger.getPossibleAndSetBreakpointByUrl",
    "params":{"locations":[{"url":"entry|entry|1.0.0|src/main/ets/pages/Index.ets","lineNumber":20,"columnNumber":0}]}}
<< {"id":6,"result":{"locations":[{"lineNumber":20,"columnNumber":0,"id":"invalid","scriptId":0}]}}

>> {"id":7,"method":"Debugger.removeBreakpointsByUrl","params":{"url":"<url>"}}
<< {"id":7,"result":{}}

// 6) 属性（CDP 同构）
>> {"id":8,"method":"Runtime.getProperties","params":{"objectId":"0"}}
<< {"id":8,"result":{"result":[{"name":"__proto__","value":{"type":"object","className":"Object",
      "unserializableValue":"Object@62f5a02","description":"Object@62f5a02","objectId":"3"},
      "writable":true,"configurable":true,"enumerable":false,"isOwn":true}]}}

// 7) 不支持的方法（实测）
>> {"id":9,"method":"Debugger.getScriptSource","params":{"scriptId":"0"}}
<< {"id":9,"result":{"scriptSource":"not supported"}}
>> {"id":10,"method":"Runtime.evaluate","params":{"expression":"1+1"}}
<< {"id":10,"result":{"code":1,"message":"unknown method: evaluate"}}
>> {"id":11,"method":"Debugger.getStackTrace","params":{"stackTraceId":{"id":"0"}}}
<< {"id":11,"result":{"code":1,"message":"Unknown method: getStackTrace"}}
```

---

## 4. ArkTS / ArkVM 特有字段

### 4.1 `sourceURL` 形态（**确定（实测）**，但仍建议以 `scriptParsed` 实报为准）

```
entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts
```

四段用 **`|`** 分隔（`PandaConstants.VERTICAL_LINE = "|"`）：

```
<模块/编译单元名> | <包名或 library 名> | <版本号> | <工程内相对路径>
```

- 本机同一形态还见过三段式（无 version 段）的等价写法在 DevEco 源码路径（`ScriptContainer` 用 `url.replace(...)` 把 url 变成本地文件路径）。
- 断点用 **url 字符串原样**匹配（不要自己拼路径，也不要 `file://` 前缀）：`setBreakpointByUrl.url` 必须等于 `scriptParsed.url`，否则实测返回 `Unknown file name.`（**确定**）。
- 也支持 `urlRegex`（`setBreakpointByUrl {urlRegex, lineNumber}`）——实测该调用**没有回收响应**（见 §6「无响应的调用」），需谨慎使用。
- `sourceMapURL` 在 `scriptParsed` 里可能为空（实测为空），`scriptLanguage`/`embedderName` 字段在模型里存在但实测未下发（**推测**：依赖构建产物）。

### 4.2 `scriptId`（**确定（实测）**）

- 是 **字符串数字**：`"scriptId":"0"`（DevEco 侧 `ScriptContainer.scriptsById` 的 key 类型是 `Integer` → 底层是整数，序列化成数字，但我们请求里传字符串同样被接受）。
- **每次连接会重新编号**（新会话又出现 `scriptId=0`），所以 `scriptId → url` 映射必须按连接生命周期重建；断点建议**按 url 存**，命中时再用 `scriptId` 反查。

### 4.3 断点语义

- `lineNumber` / `columnNumber` 为 **0 基**（CDP 默认；DevEco 的 DAP 侧 `linesStartAt1=true` 是在 DAP 层换算的）。实测 `setBreakpointByUrl {lineNumber:10}` → `breakpointId "id:10:0:<url>"`（**确定**）。
- `breakpointId` 形态：`id:<lineNumber>:<columnNumber>:<url>`（**确定（实测）**），因此客户端可以自己算/透传，不必依赖服务端回填。
- 条件断点：`setBreakpointByUrl {url, lineNumber, columnNumber, condition}` 参数位存在（生成模型里有 `condition`/`hitCondition`），实测发送被接受但**未验证命中效果**（**推测**；`SymbolicBreakpoint{functionName,condition,hitCondition}` 同理）。
- Panda 系：`getPossibleAndSetBreakpointByUrl` 的入参形状是 `{"locations":[{url,lineNumber,columnNumber,condition?}]}`（**确定**：这个形状**不再报** `wrong params`；换成 `scriptId` 形式会报 `wrong params`）；回包 `{"locations":[{lineNumber,columnNumber,id,scriptId}]}`，其中 `id:"invalid"` 表示该 url 当前没有已加载脚本可落点（**确定（实测）**）。
- 批量：`saveAllPossibleBreakpoints` 需要先满足某个「protocol 开启」条件，直接调用报 `SaveAllPossibleBreakpoints: protocol is not enabled`（**确定（实测）**）。**推测**其开启方式是 `Debugger.setMixedDebugEnabled` 之类的能力开关，暂未验证。
- 异常暂停：`Debugger.setPauseOnExceptions {state:"none"|"uncaught"|"all"}`（枚举实测 `none/uncaught/all`），实测 `{"state":"all"}` 返回 `{}` 成功（**确定**）。异常暂停时的 `paused.reason` 取 `exception`（枚举见下）。
- `Debugger.setBreakpointsActive {active:bool}`、`Debugger.setSkipAllPauses {skip:bool}` 实测均回 `{}`（**确定**）。

### 4.4 枚举（jar 反解，客户端可照抄）

```text
Paused.reason   : ambiguous | assert | CSPViolation | debugCommand | EventListener | exception
                  | instrumentation | other | promiseRejection | step
                  |（Panda 追加）Break on start（实测值，含空格！）| Native out | Symbol
                  |（老 CDP 遗留）DOM | OOM | XHR
ScopeType       : global | local | with | closure | catch | block | script | eval | module
                  | wasm-expression-stack          ← 注意 wire 值 local（枚举名 GLOBAL/WITH/... 不对齐）
SetPauseOnExceptionsState : none | uncaught | all
BreakLocationType : debuggerStatement | call | return
ScriptLanguage  : JavaScript | WebAssembly
RemoteObject.type/subtype、PropertyDescriptor（isWritable/hasConfigurable/isEnumerable/hasThrown/isOwn/symbol）
```

- `Paused.params` 字段：`callFrames`、`reason`、`data`、`hitBreakpoints`、`asyncCallStackTraceId`（后两者 optional）。
- `CallFrame` 字段：`callFrameId`、`functionName`、`functionLocation`、`location`、`scopeChain`、`this`（JSON 键名就是 **`this`**，Panda 用 `@JsonProperty("this")` 映射到 `that` 字段）、`returnValue`、`url`、`scriptId`(deprecated)、`lineNumber`、`columnNumber`。
- `Scope`：`type`、`object`、`name`、`startLocation`、`endLocation`。
- 求值：`Debugger.evaluateOnCallFrame {callFrameId, expression, objectGroup, includeCommandLineAPI, silent, returnByValue, generatePreview, throwOnSideEffect, timeout}` → `{result, exceptionDetails, ...}`（模型存在；实测在「已死会话」里未拿到回包，见 §6）。

### 4.5 ArkTS 特有交互（native 混合栈）

- 事件 `Debugger.nativeCalling`（payload 含 `userCode`）、`Debugger.mixedStack`；命令 `Debugger.replyNativeCalling`（`{userCode}` 回填）、`Debugger.setNativeRange`（`{NativeRange:[...]}`）、`Debugger.setMixedDebugEnabled`。
- 用途：JS 调用 native 时暂停/过滤；对「只在 .ets 里下断点」的场景可先忽略，但 `protocols[]` 广告里出现说明 SDK 支持（**确定：模型与广告都在**；行为**未实测**）。

---

## 5. 前置条件与失败模式

| 失败模式 | 现象（实测/推断） | 处置 |
|---|---|---|
| 应用非调试签名 | `bm dump` 里 `appProvisionType != "debug"`；`fport` 仍回 `Forwardport result:OK`，但 TCP 连上后**握手无响应/连接被关闭**（实测：`ark:1396@Debugger` 对系统应用＝TCP 通、无 101、随即 close） | 只对 debug 签名应用 attach；把 `bm dump` 检查做成前置校验 |
| 应用未运行 / pid 过期 | `fport` OK，但连接后立刻被关闭 | 先 `track-jpid`/`ps -ef` 取活 pid，attach 前复检 |
| `ark:<pid>@<包名>` 用于调试器 | 连上的是 **Inspector** 协议（`{"type":"connected"}` 那套），发 CDP 方法无回应 | 调试器必须是 `ark:<pid>@Debugger` |
| 端口被 DevEco 占用 / 第二客户端 | **单客户端实测确认**：同一 `ark:<pid>@Debugger` 上并发开两条 WS 连接，第二条**连 101 都拿不到**（请求被静默挂起，2.5s 无任何响应；第一条正常 `{"id":1,"result":{"protocols":[]}}`） | 先 `hdc fport ls` 找 IDE 的 `ark:<pid>@Debugger` 规则 → `fport rm` 踢掉；握手必须带超时（建议 3–5s），超时即报「已被其他调试会话占用」 |
| fport 规则泄漏 | 反复 attach 后 `fport ls` 堆规则；`--remove` 静默失败 | 只用 `fport rm tcp:<p> ark:<pid>@Debugger`；在 finally 里清理 |
| 已运行应用 attach（非 wait-debug 启动） | `Debugger.enable` 成功但 `scriptParsed` **0 条**、`Debugger.pause` 只回 `{}` 且**永不产生 `paused` 事件**（实测 3 次） | 需要「先 `aa appdebug -b` 再启动」，或用 IDE 同款 launch 流程；文档/工具提示里写清 |
| 空闲态 `Debugger.pause` | 返回 `{}` 但无 `paused` 事件（JS 线程无检查点） | pause 后给「等 JS 执行/用户交互」提示；或用 `Debugger.setBreakpointByUrl` + 触发交互 |
| 调用无响应 | `setBreakpointByUrl{urlRegex}`、`saveAllPossibleBreakpoints` 某些形状、`evaluateOnCallFrame` 在死会话里**完全没有回包** | 每个请求必须带超时（建议 5s，暂停类 10s），超时后标记会话不可用并重建 |
| 断点 url 不匹配 | `{"code":1,"message":"Unknown file name."}` | url 必须逐字等于 `scriptParsed.url`；先收 `scriptParsed` 再下断点 |
| 未暂停时发暂停态命令 | `Can only perform operation while paused` | 维护 paused 状态机（`Debugger.paused`/`resumed` 驱动） |
| 应用调试会话结束 | 调试模式启动的应用在调试器断开后**可能被结束**（实测 3 次里应用进程消失） | detach 前 `Debugger.resume`；把「detach 可能终结应用」写进工具说明 |

---

## 6. Node 侧最小客户端设计（伪代码）

```js
// ── 端口与转发 ────────────────────────────────────────────────
const port = await pickFreePort()                       // 或让 OS 分配后 fport
await hdc(['fport', `tcp:${port}`, `ark:${pid}@Debugger`], { serial })
try {
  // ── 裸 socket + 6 头握手（复用 harmony-device.mjs 的 4 个函数）──
  const sock = net.connect(port, '127.0.0.1')
  sock.write(buildDevEcoWsHandshake(`127.0.0.1:${port}`, randomKey16Base64()))
  const resp = await readUntil('\r\n\r\n')               // 必须 /^HTTP\/1.1 101/
  if (!isWsHandshakeAccepted(resp)) throw new Error('WS 握手被拒（占用/非 debug/目标错）')

  // ── 请求-响应 + 事件分发 ───────────────────────────────────
  let id = 1; const pending = new Map(); const listeners = new Map()
  sock.on('data', (chunk) => {
    const { texts, pings, rest } = decodeWsServerFrames(buf + chunk)
    for (const p of pings) sock.write(encodeWsPongFrame(p))
    for (const t of texts) {
      const msg = JSON.parse(t)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id); pending.delete(msg.id)
        // ❗错误在 result.code/result.message，不是 error 字段
        if (msg.result && msg.result.code !== undefined) resolve({ ok: false, error: msg.result })
        else resolve({ ok: true, value: msg.result })
      } else if (msg.method) {
        emit(msg.method, msg.params)                      // scriptParsed / paused / resumed / consoleAPICalled …
      }
    }
  })
  const request = (method, params = {}, timeoutMs = 5000) => new Promise((resolve) => {
    const myId = id++; pending.set(myId, { resolve })
    sock.write(encodeWsClientTextFrame(JSON.stringify({ id: myId, method, params })))
    setTimeout(() => { if (pending.delete(myId)) resolve({ ok: false, error: { code: 'timeout' } }) }, timeoutMs)
  })

  // ── 初始化（能力协商）──────────────────────────────────────
  await request('Runtime.enable')
  const dbg = await request('Debugger.enable')            // → value.protocols[]
  const caps = new Set(dbg.value?.protocols || [])
  await request('Debugger.setBreakpointsActive', { active: true })
  await request('Runtime.runIfWaitingForDebugger')         // 放行等待调试器的应用

  // ── 断点：按 url 存（scriptId 每次连接都会重编号）──────────
  const urlToScriptId = new Map()                          // 由 scriptParsed 事件维护
  on('Debugger.scriptParsed', (p) => urlToScriptId.set(p.url, p.scriptId))
  async function setBreakpoint(url, line, col = 0, condition) {
    const r = caps.has('getPossibleAndSetBreakpointByUrl')
      ? await request('Debugger.getPossibleAndSetBreakpointByUrl',
          { locations: [{ url, lineNumber: line, columnNumber: col, ...(condition ? { condition } : {}) }] })
      : await request('Debugger.setBreakpointByUrl',
          { url, lineNumber: line, columnNumber: col, ...(condition ? { condition } : {}) })
    return r   // 断点表以 url+line 为键，breakpointId = "id:<line>:<col>:<url>"
  }

  // ── 暂停态状态机 ───────────────────────────────────────────
  let topFrame = null
  on('Debugger.paused', (p) => { paused = true; topFrame = p.callFrames[0]; /* 存 hitBreakpoints */ })
  on('Debugger.resumed', () => { paused = false; topFrame = null })

  // 求值（优先 evaluateOnCallFrame；Runtime.evaluate 实测不支持）
  const evaluate = (expr) => paused && topFrame
    ? request('Debugger.evaluateOnCallFrame', { callFrameId: topFrame.callFrameId, expression: expr }, 10000)
    : { ok: false, error: { message: 'not paused' } }
} finally {
  try { await request('Debugger.resume') } catch {}
  sock.destroy()
  await hdc(['fport', 'rm', `tcp:${port}`, `ark:${pid}@Debugger`], { serial })
}
```

### 6.1 建议给 agent 的工具动作集

| 动作 | 底层 | 说明 |
|---|---|---|
| `attach` | jpid/track-jpid + bm dump 校验 + `aa appdebug -b`? + fport + WS + Runtime/Debugger.enable | 返回 `{pid, packageName, caps, scripts}`；单会话句柄 |
| `detach` | `Debugger.resume` → close → `fport rm` | 提示可能终结被调试应用 |
| `pause` / `resume` | `Debugger.pause` / `Debugger.resume` | pause 在空闲 JS 线程可能不生效（返回 `{}` 无 `paused`） |
| `step` | `Debugger.stepOver` / `stepInto` / `stepOut`（+ `smartStepInto` 若 caps 有） | 必须 paused |
| `setBreakpoint` | `setBreakpointByUrl` 或 `getPossibleAndSetBreakpointByUrl` | 参数 `{url, line, column?, condition?}`；url 建议用 `scriptParsed.url` 原值 |
| `removeBreakpoint` | `Debugger.removeBreakpoint {breakpointId}` / `removeBreakpointsByUrl {url}` | |
| `listBreakpoints` | 客户端本地表（服务端无查询接口） | 与 `Debugger.breakpointResolved` 校正 |
| `stack` | 由最近 `Debugger.paused.callFrames` 提供 | `Debugger.getStackTrace` 实测不支持 |
| `evaluate` | `Debugger.evaluateOnCallFrame {callFrameId, expression}` | `Runtime.evaluate` 实测 `unknown method`；未暂停时不可用 |
| `properties` | `Runtime.getProperties {objectId}` | 取 scopeChain/对象展开 |
| `console` | `Console.enable` + `Console.messageAdded` / `Runtime.consoleAPICalled` | 与 HiLog 互补（应用内 console 输出） |
| `exceptions` | `Debugger.setPauseOnExceptions {state}` | `none/uncaught/all` |
| `scripts` | 本地表（来自 `scriptParsed`） | 供 agent 找 url 下断点 |

**并发/生命周期约束**（写进工具 `isConcurrencySafe: false`）：一个 pid 同时只允许一个调试会话；不同 pid 可并行（各自 fport 端口）。

---

## 7. 实测记录

### 7.1 环境

| 项 | 值 |
|---|---|
| 模拟器 | `devecocli emulator start "Mate 70 Pro"` → `127.0.0.1:5555`（HarmonyOS 6.0.0(20)，`const.ohos.apiversion=20`，model=`emulator`） |
| hdc | `D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe`（Ver 3.2.0f） |
| 被调试应用 | `io.duke.myapplication`（debug 签名：`appProvisionType=debug`, `debug=true`；mainAbility `EntryAbility`） |
| 探针脚本 | `docs/recon-scripts/arkts-debug-probe.mjs` / `probe2` / `probe3` / `probe4`（直接 import 本仓库 `harmony-device.mjs` 的 WS 函数） |
| 决策依据日志 | `C:/Users/wwhby/AppData/Local/Huawei/DevEcoStudio6.1/log/idea*.log`（真实 ArkTS 调试会话记录） |

### 7.2 成功复现的最小命令序列

```bash
HDC="D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
"$HDC" -t 127.0.0.1:5555 shell "aa appdebug -b io.duke.myapplication"   # app debug successfully.
"$HDC" -t 127.0.0.1:5555 shell "aa force-stop io.duke.myapplication"
"$HDC" -t 127.0.0.1:5555 shell "aa start -a EntryAbility -b io.duke.myapplication"
"$HDC" -t 127.0.0.1:5555 fport tcp:19011 ark:3308@Debugger            # Forwardport result:OK
node docs/recon-scripts/arkts-debug-probe.mjs --pid 3308 --port 19011 --seq init
#   << HTTP/1.1 101 Switching Protocols
#   << [1] {"id":1,"result":{"protocols":[]}}
#   << [2] {"id":2,"result":{"debuggerId":"0","protocols":[...12 项...]}}
#   << [5] {"method":"Debugger.scriptParsed","params":{"scriptId":"0","url":"entry|hrouter|2.0.0|src/main/ets/api/module-factory.ts",...}}
#   << [6] {"method":"Debugger.paused","params":{"reason":"Break on start","callFrames":[...]}}
"$HDC" -t 127.0.0.1:5555 fport rm tcp:19011 ark:3308@Debugger          # Remove forward ruler success
```

### 7.3 已验证 ✅ / 未验证 ⚠️

✅ 已验证（真机实测报文见 §3.3）
- `fport tcp:<p> ark:<pid>@Debugger`（两段式）＋ `fport rm` 清理
- 裸 socket 6 头握手 → `101 Switching Protocols`（复用既有 WS 实现）
- `Runtime.enable`、`Debugger.enable`（含 `protocols[]` 能力广告）
- `Debugger.scriptParsed`（真实 url 形态）、`Debugger.paused`（`Break on start` + callFrames/scopeChain/this）
- `Runtime.runIfWaitingForDebugger`、`Debugger.setBreakpointsActive`、`Debugger.setPauseOnExceptions`、`Debugger.pause`（返回 `{}`）
- `Debugger.setBreakpointByUrl`（成功/`Unknown file name.`）、`getPossibleAndSetBreakpointByUrl`（正确参数形状 + `id:"invalid"`）、`removeBreakpointsByUrl`
- `Runtime.getProperties`；错误形态 `result.code/message`
- 不支持：`Debugger.getScriptSource`（`"not supported"`）、`Runtime.evaluate`（`unknown method`）、`Debugger.getStackTrace`（`Unknown method`）
- `bm dump` 的 `appProvisionType/debug` 判定、`jpid`/`track-jpid -a` 输出、`@ohjpid-control` socket、`aa appdebug -b/-g`
- **单客户端**：同一 `ark:<pid>@Debugger` 并发两条 WS 连接时，第二条拿不到 101（无响应），第一条正常

⚠️ 未验证 / 需后续补测
- **「入口暂停」的可复现性**：本机只在第一次 attach 拿到 `paused(reason="Break on start")`；之后无论 `aa appdebug -b` / `-c` 重来、`aa force-stop` 后重启、`aa start -D` 调试模式启动、还是换另一个 debug 应用（`io.duke.websocket`），attach 得到的都是**空会话**（`Debugger.enable` 成功、`scriptParsed` 0 条、`Debugger.pause` 只回 `{}` 且无 `paused` 事件）。疑似 ArkTS 调试实例只在进程启动瞬间（wait-for-debugger）真正注册，进程跑起来后再连只能拿到一个「无脚本的壳」。
- `Debugger.paused`（`reason=step`/`exception`）与 `hitBreakpoints` 真实命中流程（因上条未能进入可下断点并命中的状态）
- `Debugger.evaluateOnCallFrame` 在真正暂停态的回包（暂停态只出现过一次且当时优先验证了其他方法）
- 条件断点 `condition` 的实际过滤效果、`hitCondition`、`setSymbolicBreakpoints`
- 三段式 `ark:<pid>@<tid>@Debugger` 的 `tid` 语义（DevEco 日志里先试三段再退两段；本次只用两段式成功）
- 单客户端占用时的确切错误（IDE 同时调试时我们握手会被拒还是被踢）
- `Runtime.consoleAPICalled` / `Console.messageAdded` 实际 payload
- `Profiler.*` / `HeapProfiler.*` 可用性
- 设备侧调试 socket 的真实名字：调试会话活跃时 `/proc/net/unix`、`netstat -an` 都没有出现 `*Debugger*`/`*inspector*` 命名的条目，说明 `ark:` 由 hdc daemon 内部解析（**推测口径已足够，但未拿到 socket 名**）

### 7.4 若要在别的设备上重跑（最小验证步骤）

```bash
# 1) 找一个 debug 签名应用
hdc -t <serial> shell "bm dump -a | head -50"
hdc -t <serial> shell "bm dump -n <bundle> | grep -iE 'appProvisionType|debug'"
# 2) 标记等待调试器并启动（拿不到 mainAbility 就用 bm dump 里的 mainAbility 字段）
hdc -t <serial> shell "aa appdebug -b <bundle>"
hdc -t <serial> shell "aa force-stop <bundle>"
hdc -t <serial> shell "aa start -a <MainAbility> -b <bundle>"
# 3) 取 pid 并转发
hdc -t <serial> shell "ps -ef | grep <bundle> | grep -v grep"
hdc -t <serial> fport tcp:19011 ark:<pid>@Debugger
# 4) 跑探针（会打印 101 与全部报文）
node docs/recon-scripts/arkts-debug-probe.mjs --pid <pid> --port 19011 --seq init
# 5) 清理
hdc -t <serial> fport rm tcp:19011 ark:<pid>@Debugger
```

---

## 8. 证据索引（可复查）

| 结论 | 证据 |
|---|---|
| hdc fport 语法 / `ark:pid@tid@Debugger` | `hdc.exe`（3.2.0f）内建帮助字符串 `forward commands: … ark:pid@tid@Debugger`；`translate.cpp` schema 常量 `tcp: localabstract: localreserved: localfilesystem: dev: jdwp: ark:` |
| `track-jpid -a/-p`、`jpid` | 同上帮助；`plugins/openharmony/lib/ohos-hdclib-26.0.0.821.jar` → `hdclib/ohos/client/Command`（`TRACK_APP_COMMAND*`）、`hdclib/ohos/devices/DeviceAppClientMonitor` |
| 可调试判定 `ALLOW_DEBUG` + appProvisionType | `ohos-hdclib` → `hdclib/ohos/devices/DebugClient`（`ohos.permission.kernel.ALLOW_DEBUG`、`isAppProvisionDebug`）、`hdclib/ohos/hdc/HdcConstants` |
| `debugger/` 命令（aa appdebug/aa attach 等） | `openharmony/lib/ohos-debugger-26.0.0.821.jar` → `debugger/ohos/waitdebug/AppWaitDebugCommandProcess`、`debugger/ohos/attach/ProcessResolver` |
| `ark:<pid>@<包名>` / `ark:<pid>@<tid>@<svc>` 拼接 | `openharmony/lib/ohos-debug-common-26.0.0.821.jar` → `socket/forward/SocketPortForwardOperation`（recipe `ark:<A>@<A>`）、`socket/forward/ArkTsPortForwardOperation`、`forward/ForwardInfo$ServiceName`（`PANDA="PandaDebugger"`, `DEBUGGER="Debugger"`）、`AbstractOpenForwardOperation`（`tcp:<A>`、`localabstract:<A><A>`、`fport rm <A> <A>`） |
| WS URL 无路径 / 101 / Java-WebSocket | `openharmony/lib/panda-debug-adapter-26.0.0.821.jar` → `panda/util/PandaConstants`（`WS="ws://127.0.0.1:"`）、`panda/websocket/services/impl/WebSocketServiceImpl`、`panda/websocket/services/impl/DevToolsSocketClient`（`httpStatus`）、日志 `Connecting to ws server ws://127.0.0.1:15045` / `httpStatus is 101` |
| 方法/事件全集 | `panda-debug-adapter` → `panda/websocket/protocol/commands/{Debugger,Runtime,Console,Profiler,HeapProfiler}`、`protocol/events/**`、`protocol/types/**`、`support/annotations/{EventName,ParamName,Returns,Optional}` |
| JSON-RPC 形态（id/method/params、code/message） | `panda/services/types/MethodInvocation`、`services/impl/ErrorMessageObject`、`services/impl/PandaDevToolsServiceImpl` |
| `url` 用 `\|` 分段 | `PandaConstants.VERTICAL_LINE="|"`、`panda/bridge/ScriptContainer`（`scriptsById:Integer`、`getUrl`、`replace`）、实测 `scriptParsed.url` |
| Inspector 与调试器共用握手 | 本仓库 `harmony-device.mjs`（`buildDevEcoWsHandshake`/`encodeWsClientTextFrame`…）+ 本次实测 `101` |
| 端口从 15037 起 | `PandaConstants.INITIAL_WS_PANDA_PORT`、`panda/message/DevToolsServiceWrapper`（`PORT_QUEUE`/`addPortToQueue`/`isPortOccupied`）、日志 `createForward tcp port:15037/15038…` |
| 设备侧无 `*Debugger*` socket | 实测 `cat /proc/net/unix`、`netstat -an \| grep LISTENING`（只有 `@ohjpid-control`） |
| DevEco 真实会话时间线 | `DevEcoStudio6.1/log/idea*.log`（2026-06-25 22:29 段：createForward → Connecting to ws server → 101 → Debugger.paused/scriptParsed…） |

### 既有 recon 脚本

| 文件 | 用途 |
|---|---|
| `docs/recon-scripts/arkts-debug-probe.mjs` | 最小探针：fport + 握手 + Runtime/Debugger.enable + 事件打印 |
| `docs/recon-scripts/arkts-debug-probe2.mjs` | 方法矩阵探针（getScriptSource / 两种断点 API / evaluate / resume·pause·step …） |
| `docs/recon-scripts/arkts-debug-probe3.mjs` | 真实会话序列（暂停态能力 + pause 观察） |
| `docs/recon-scripts/arkts-debug-probe4.mjs` | 断点参数形状试错 + 空闲态 pause 观察 |
| `docs/recon-scripts/jar-cpstrings.py` / `cpstrings.py` / `jarstrings.sh` | jar/class 常量池与字符串提取（反编译证据来源） |

---

## 9. Hvigor Source Map → `.ets` 源码断点（v0.6.0）

### 9.1 关键结论

**结论：不需要猜「源码行 + 固定偏移」。Hvigor 已经生成 Source Map v3 字典，其 key 就是 ArkVM 的 `scriptParsed.url`。置信度：确定（真实工程文件 + 双向映射验证）。**

典型文件：

```text
entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/sourceMaps.json
entry/build/default/intermediates/source_map/default/sourceMaps.map
entry/build/default/intermediates/loader_out/default/sourceMaps.json
entry/build/default/outputs/default/mapping/sourceMaps.map
```

字典形态（字段值截断展示）：

```json
{
  "entry|entry|1.0.0|src/main/ets/pages/Index.ts": {
    "version": 3,
    "file": "Index.ts",
    "sourceRoot": "",
    "sources": ["Index.ets"],
    "names": ["Index", ...],
    "mappings": "..."
  }
}
```

实现位于 `harmony-source-map.mjs`：解码 VLQ `mappings`，同时支持 generated → original（调用栈）与 original → generated（断点）。Source Map 内部坐标仍按标准为 0 基；工具 API 的 `source_line/source_column` 显式转换为 **1 基**，底层 `line/column` 继续保持 **0 基**，两种坐标不混用。

### 9.2 真实工程验证

验证工程：`D:/ai-projects/dsh/dsh-remote-control/app`，源码 `entry/src/main/ets/pages/Index.ets` 第 296 行。命令：

```bash
node scripts/e2e-source-map.mjs \
  --project D:/ai-projects/dsh/dsh-remote-control/app \
  --source entry/src/main/ets/pages/Index.ets \
  --line 296
```

实测结果：

| 项 | 结果 |
|---|---|
| 应用 / 模块 | `com.dukedsh.remotecontrol` / `entry` (entry) |
| Source Map 文件 | `entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/sourceMaps.json` |
| 已索引脚本 | 40 |
| Source Map 警告 | 0 |
| 目标 ArkVM URL | `entry\|entry\|1.0.0\|src/main/ets/pages/Index.ts` |
| 编译坐标 | 0 基 `line=339, column=4`（即文件第 340 行） |
| 反解坐标 | 1 基 `entry/src/main/ets/pages/Index.ets:296:3` |

这解释并修复了 §6.2 的「296 → 340」问题：该差异来自编译映射，而不是可硬编码的常量。本次验证覆盖真实 Hvigor 产物和双向映射，**不把它宣称为在线设备断点命中验证**。

### 9.3 工具行为与保护

- `harmony_debug(action=set_breakpoint)` 接收 `source_path` + 1 基 `source_line/source_column`，先定位 Source Map，再向 ArkVM 下发精确 URL 与编译坐标。
- 优先精确源码行；该行没有映射时可落到下一可执行行，结果包含 `requested` / `resolved` / `moved`，message 明示实际落点。
- 一个源码路径命中多个 ArkVM URL 时，优先使用当前已加载脚本消歧；无法消歧则报错，不随机选模块。
- 源码文件 mtime 新于所选 map 时拒绝设置，要求先 build/run；防止「能设上但落在旧代码」的静默错误。
- map 缺失、JSON 损坏或超过 32 MiB 均有明确错误/警告。普通调试 attach 不强制要求工程存在；显式 `project_path` 无效则报错。
- Source Map 索引在 attach 时装入 `ArktsDebuggerSession`，因此 `stack`、`pause`、`step`、`status` 和自动暂停通知都同步显示源码位置；原始 `url/lineNumber/columnNumber` 保留用于协议诊断。
- `harmony_project` 与调试工具共用工程根发现；默认取当前 agent workspace（`exec.agent.session.header.cwd`），可用显式路径覆盖。

### 9.4 验证入口

```bash
# 无设备：真实 Hvigor 映射
npm run e2e:source-map -- --project <root> \
  --source entry/src/main/ets/pages/Index.ets --line 296

# 模拟器在线后：真实 defineTool + 工程 + 源码断点
node scripts/e2e-agent-tools.mjs --device <emulator> --bundle <pkg> \
  --project <root> --source entry/src/main/ets/pages/Index.ets \
  --source-line 296 --attach
```

设备断点命中与多模块延迟加载仍应在模拟器在线后分别复测；没有在线设备时不标记为已通过。
