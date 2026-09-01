# AGENTS.md — dsh-deveco

DSH 双面 bundle 插件：在 better-sidebar 注册「HarmonyOS Suite」单实例 Tab。

## 三件套

- `index.js` — Host：`HarmonyDevEcoService extends TypertRemoteService`，服务键 `harmonyDevEco`
- `client.js` — Client：`window.__ModuleLoader__.load({id, factory})` bundle，挂载 `harmonyDevEco` Remote 命名空间
- `typert.host.js` — `export const TYPERT = { package, face:"host", schemas:[], invocations:[...], model:{services:[...], events:[], objects:[]} }`

## 必踩坑（继承自 git-manager/memory-manager 经验）

- **必须 `export default HarmonyDevEcoService`**（大坑）：cordis loader 的 `unwrapExports` 取 `exports.default ?? exports`，ESM namespace 对象不是合法 plugin。
- **必须导出 `TYPERT`**：dsh-typert-loader 严格校验；`events`/`objects` 必须是数组。
- **Remote 返回值 JSON-safe**：可选字段有值才挂 key；union 里的空值用 `false`/`""` 不要用 `null`。
- **profile package.json 无 BOM**：DSH `readProfileManifest` 直接 JSON.parse，BOM 会崩整个 profile。
- **颜色一律 dsw token**：禁止硬编码 hex/rgba。
- **CSS 用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`**。
- **Component 一律 bundle 作用域定义**：内联创建会丢输入态。

## 工具链解析优先级（用户决策）

1. `PATH` 存在 `devecocli` → 优先使用，忽略设置路径
2. CLT 路径 ≥ 26.0.0 → 用 CLT（与 Studio 互斥）
3. DevEco Studio 路径 → 兜底
4. 无 → 错误提示去设置

## 互斥规则

`setCltPath` 清空 `studioPath`；`setStudioPath` 清空 `cltPath`。

## 开发

```bash
npm run check    # 全部 JS 语法检查
npm test         # 单元测试（路径探测 + 配置互斥）
dsh plugin --profile web add .   # 本地安装
```