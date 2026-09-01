# dsh-deveco

DSH 的 HarmonyOS 全栈开发套件。在 better-sidebar 中注册「HarmonyOS Suite」单实例 Tab，提供 HiLog 实时流、ArkUI Inspector、ArkTS 项目浏览与 .ets 文件查看器；通过设置页管理 DevEco Studio / HarmonyOS Command Line Tools 路径，含三平台自发现、两者互斥、CLT 最低 26.0.0 校验。

## 功能

### HarmonyOS Suite（better-sidebar 单实例 Tab）
- **HiLog 子页**：实时日志流（基于 `hdc shell hilog -f`）+ 级别过滤（chip 多选）+ 包名/关键词过滤 + 「开始/停止」控制
- **ArkUI Inspector 子页**：UI 树 dump（点击节点自动填充 tap 坐标）+ Screenshot + Tap/Swipe/Text 操作面板
- **Projects 子页**：项目浏览器（v1.0 占位；v1.1 路线）

### ArkTS / TypeScript 文件查看器
- 注册到 better-sidebar 的 `registerFileViewer`，`exts: ['ets']`，priority 10 优先于内置 text editor
- 提供 ArkTS 语法高亮：关键字 + 装饰器（@Entry /@Component /@State 等）+ 注释 + 字符串 + 数字

### 设置 → 插件 → HarmonyOS Suite
- 「DevEco Studio 路径」输入框 + 「扫描系统默认」+ 自发现结果列表
- 「HarmonyOS Command Line Tools 路径」输入框 + 版本校验（≥ 26.0.0）+ 自发现结果列表
- 「重新扫描」按钮
- 状态徽章（devecocli / CLT ≥26 / CLT<26 / Studio / 未配置）

## 工具链解析优先级（用户决策）

1. **`PATH` 存在 `devecocli`** → 优先使用，**忽略设置路径**
2. **CLT 路径 ≥ 26.0.0** → 用 CLT（与 Studio 互斥）
3. **DevEco Studio 路径** → 兜底
4. 无 → 错误提示去设置

互斥规则：`setCltPath` 清空 `studioPath`；`setStudioPath` 清空 `cltPath`。

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
npm test         # 44 个独立核心单元测试（路径探测 + 配置互斥 + HiLog/ui 解析）
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