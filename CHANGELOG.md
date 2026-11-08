# Changelog

本项目的重要变更记录在此文件中。发布工作流按 `v*` 标签提取对应版本段落作为 GitHub Release 正文；版本标题格式为 `## [X.Y.Z] - YYYY-MM-DD`。

## [Unreleased]

### Changed

- 发布工作流改为从 `CHANGELOG.md` 读取对应版本说明；标签缺少唯一且非空的版本段落时停止发布，避免沿用旧模板。

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
