# Changelog

本插件遵循语义化版本。已发布资产不可覆盖；任何字节变化必须递增版本并重新审核。

## [0.1.2] - 2026-11-20

修复连接授权解析失败。**0.1.1 装好后 DBX 里 `connection/test` 报「未配置 root_path」，本版本为首个授权闭环可用的候选。**

### 修复

- **授权配置解析不到 `external_config` 里的值**：0.1.1 只在 `root_path` / `config.root_path`
  等平铺位置取值，而 DBX 真实载荷（读 t8y2/dbx 源码
  `crates/dbx-plugin-runtime/src/plugins/host.rs` 的 `plugin_connection_params` 确认）是
  `{ provider, connection:<ConnectionConfig>, runtime, operationId }`，授权配置在
  `connection.external_config.root_path` 里，平铺查找全部落空，于是出现
  「dbx.db 里明明填了授权目录，sidecar 却收到 `roots: []`」。
  现改为对载荷做广度优先递归查找（越浅层越优先），兼容 `external_config` /
  `externalConfig` / `config` / 平铺等形态。
- **连接 id 解析被 `provider.id` 抢先**：`provider.id` 与 `connection.id` 键名相同，
  整树 BFS 会先命中前者，导致同一插件的多个连接共用一个 session 缓存键。
  现 id/name 优先取 `connection` 子树。

### 新增

- **脱敏诊断日志**：`connection/test` 解析不到授权目录时，stderr 输出脱敏后的载荷键结构
  （`secret`/`password`/`token` 等键值替换为 `***`）。DBX 传输层键名一旦变化，
  「配置填了却说不存在」这类故障可直接从日志定位，不必再逐轮猜键名。
- 验收测试新增第 11 章「DBX 真实载荷形态」共 8 项断言：`external_config` 嵌套取值、
  `mcp/call` 的 `lifecycle` 载荷、session 缓存按 `connection.id` 命中（而非 `provider.id`）、
  诊断日志可见且已脱敏密码。测试总数 60 → 68。

### 验证

- 源码模式与 SEA 产物模式均 68/68 通过
- 包内文件：`assets/plugin.svg`、`backend/dbxfs.cjs`、`bin/windows-x64/dbxfs.exe`、`checksums.json`、`manifest.json`
- sha256 `d9c950ac2121b6f387f3dc7bbf82b7c43cd0aaa271da75f4808d3402222a4fd2`，35,207,384 字节

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
