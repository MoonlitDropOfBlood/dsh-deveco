# Changelog

本项目的重要变更记录在此文件中。发布工作流按 `v*` 标签提取对应版本段落作为 GitHub Release 正文；版本标题格式为 `## [X.Y.Z] - YYYY-MM-DD`。

## [Unreleased]

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
