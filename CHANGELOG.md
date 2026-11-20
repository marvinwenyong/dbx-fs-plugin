# Changelog

本插件遵循语义化版本。已发布资产不可覆盖；任何字节变化必须递增版本并重新审核。

## [0.1.1] - 2026-11-20

修复安装阻塞问题。**0.1.0 无法在 DBX 中初始化，本版本为首个可用候选。**

### 修复

- **`plugin/initialize` 返回的 `capabilities` 格式错误**：0.1.0 返回的是对象
  `{ "connection": true, "mcpTools": true }`，而 DBX 反序列化时要求 `Vec<String>`，
  安装后 DBX 报
  `Plugin 'com.mawen.dbxfs' initialize result has invalid 'capabilities': expected an array of strings`，
  导致工具列表获取失败、AI 助手看不到任何文件工具。
  现按官方 Rust/Go SDK 的 `PluginMetadata::with_capability` 约定改为字符串数组 `["connections"]`。

### 新增

- 验收测试增加 2 项回归断言：`capabilities` 必须是字符串数组且每项匹配
  `^[a-z0-9][a-z0-9._:-]*$`、必须包含 `connections`。测试总数 58 → 60。

### 验证

- 源码模式与 SEA 产物模式均 60/60 通过
- 包内文件：`assets/plugin.svg`、`backend/dbxfs.cjs`、`bin/windows-x64/dbxfs.exe`、`checksums.json`、`manifest.json`
- sha256 `9f145c446ee67a92af6fb4028ee1098e797684616c1bd619b8a72ca62fe3b31a`，35,204,782 字节

## [0.1.0] - 2026-11-20

首个候选版本（**已废弃，勿安装**）。实现 DBX Sidecar Protocol v1，为 DBX 内置 AI 助手提供授权目录内的文件工具。

### 新增

- **Sidecar 协议**：`plugin/initialize`（协议版本协商 + 插件身份校验）、`connection/test|connect|disconnect`（幂等）、`mcp/tools`、`mcp/call`
- **8 个文件工具**：`list_dir`、`stat`、`read_file`、`search`、`write_file`、`edit_file`、`delete`、`permission_status`
- **连接型授权**：通过 DBX 连接配置授予权限（`root_path` / `fs_mode` / `max_read_bytes` / `max_write_bytes`），不读环境变量，改窄配置立即生效
- **三档权限模式**：`read_only` / `safe_write` / `full_access`
- **安全约束**：realpath 校验防符号链接逃逸与 `..` 穿越、敏感文件黑名单（密钥/证书/凭据/`dbx.db`）、大小写不敏感的授权根比较（Windows）
- **宿主确认分级**：只读工具声明 `readOnlyHint`，写/删工具由宿主暂停并展示完整参数
- **可复现构建**：Node SEA 单文件后端，`useCodeCache: false`，同一份源码构建产物字节一致
- **验收测试**：`tests/acceptance.cjs` 58 项，源码模式与 SEA 产物模式均通过

### 修复（开发过程中发现）

- `mcp/call` 未从 `params.lifecycle` 解析连接配置，导致所有工具调用都报"未授权"
- `read_file` 的 `total_lines` 把末尾换行产生的空元素计入行数

### 已知限制

- 仅在 Windows x64 验证；上架前需补 darwin / linux 目标
- `picker: { kind: "directory" }` 仅桌面端有效，Web 宿主需手填路径
- 无 UI 工作台，交互全部通过 AI 工具完成

### 技术说明

`dbx-plugin.toml` 中 `[backend] language = "go"` 仅是让官方 CLI 构建阶段通过的占位——CLI 只支持 Rust/Go 后端且无"使用预编译产物"开关。真实后端由 `build/build.cjs` 以 Node SEA 生成，CLI 通过 `build/go.exe`（shim）拿到它。`go-shim/` 与 `build/` 不进入发布包。
