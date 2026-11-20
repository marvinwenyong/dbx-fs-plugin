# dbx-plugin-fs · DBX 文件系统插件

> 让 DBX 内置 AI 助手在**你明确授权的目录内**读写文件。
> 实现 DBX Sidecar Protocol v1，后端为 Node SEA 单文件可执行程序（零第三方依赖、无需外部 Node 运行时）。

---

## 1. 它解决什么问题

DBX 内置 AI 助手默认**没有任何文件工具**——它只会操作数据库（建会话、执行查询、读元数据）。想让 AI 维护知识库、落盘元数据扫描结果、改 SKILL.md、整理文档，以前只能靠人复制粘贴。

本插件作为 DBX 原生插件，为 AI 助手补上 8 个文件工具，并且**权限完全由连接配置控制**：不填授权目录就没有任何能力，授权范围之外一律拒绝。

## 2. 架构

```
DBX 桌面端
  │  plugin/initialize 握手（协议版本 + 插件身份校验）
  ├─ connection/test | connect | disconnect   连接生命周期（幂等）
  └─ mcp/tools | mcp/call                    AI 工具面
                    │
                    ▼  stdio-jsonl（JSON-RPC 2.0）
        bin/windows-x64/dbxfs.exe  ← Node SEA 单文件，内含 Node 运行时
                    │
                    ▼
        授权目录内的文件操作（realpath 校验 + 敏感文件黑名单）
```

**为什么用 Node SEA 打包**：DBX 的 manifest `entrypoints.backend` 只有 `executable` 一个字段（没有 `args` / `env`），要求自包含可执行文件。dbxfs 是零依赖 Node 脚本，因此用 Node 的 Single Executable Application 打成单个 exe——产物约 87 MB，不依赖机器上是否安装了 Node。

**插件 ID**：`com.mawen.dbxfs`（`database_type` 为 `dbxfs`）

## 3. 权限模型（"赋予权限"的唯一入口 = DBX 连接配置）

在 DBX 里新建一个「本地文件系统（授权目录）」连接，填写：

| 字段 | 说明 |
|---|---|
| `root_path` | **授权根目录**。AI 只能访问这个目录之内的文件。多个目录用 `;` 分隔。桌面端可用右侧按钮选择目录 |
| `fs_mode` | `read_only`（只读）/ `safe_write`（可写不可删，默认）/ `full_access`（可删除） |
| `max_read_bytes` | 单次读取上限，默认 512 KB |
| `max_write_bytes` | 单次写入上限，默认 1 MB |

> 插件**不读任何环境变量**，授权状态完全来自连接配置。改窄配置立即生效，不存在"重启后才收回权限"的窗口。

### 三档模式能做什么

| 工具 | read_only | safe_write | full_access |
|---|---|---|---|
| `list_dir` / `stat` / `read_file` / `search` / `permission_status` | ✅ | ✅ | ✅ |
| `write_file` / `edit_file` | ❌ | ✅ | ✅ |
| `delete` | ❌ | ❌ | ✅ |

### 8 个工具

| 工具 | 作用 | 宿主确认 |
|---|---|---|
| `list_dir` | 列出一级内容（名称/类型/大小/修改时间） | 免确认（readOnlyHint） |
| `stat` | 文件或目录元信息 | 免确认 |
| `read_file` | 读文本文件，支持 offset/limit 分段 | 免确认 |
| `search` | 递归搜文件名或内容，支持 `/re/flags` 正则 | 免确认 |
| `permission_status` | 查询当前授权状态、模式与上限 | 免确认 |
| `write_file` | 覆盖/追加写入，可自动建父目录 | 需用户确认 |
| `edit_file` | 精确字符串替换，`old_string` 必须唯一 | 需用户确认 |
| `delete` | 删文件或目录（`recursive` 删整树） | 需用户确认 |

工具以 `dbxfs__<工具名>` 暴露给内置 AI；在外部 dbx MCP server（Claude Code、Cursor 等）上为 `dbx_dbxfs__<工具名>`。

## 4. 硬编码安全约束（不可通过配置绕过）

- **授权根之内**：realpath 解析后校验，防符号链接逃逸与 `..` 穿越；大小写不敏感比较（Windows）
- **敏感文件一律拒绝**（读也不允许）：`*.key` `*.pem` `*.pfx` `*.p12` `*.jks` `*.keystore` `*.ppk` `*.gpg` `*.env` `id_rsa` `id_ed25519`、含 `credential`/`secret`/`passwd` 的文件、`dbx.db` 及其 `-wal`/`-shm`
- **stdout 只走协议**：所有日志写 stderr，审计写 `DBX_PLUGIN_DATA_DIR/audit.jsonl`
- **写队列串行化**：并发请求不会把协议消息写坏
- **结果有上限**：`list_dir` 截断到 500 条、`search` 截断到 200 条命中、单次调用有超时保护

## 5. 开发与构建

```bash
# 安装官方 CLI（一次性）
npm install --global @dbx-app/plugin-cli

# 跑验收测试（直跑源码，开发迭代用）
node tests/acceptance.cjs

# 1) 生成 go.exe shim —— dbx-plugin CLI 只认 Rust/Go 后端，
#    这个 shim 把预置产物落到 CLI 期望的输出路径
node build/build-shim.cjs

# 2) 打包 Node SEA 单文件后端（默认用当前 node 作基础镜像）
node build/build.cjs            # 产物 -> bin/windows-x64/dbxfs.exe

# 3) 测打包后的产物（发布前必须跑）
node tests/acceptance.cjs --exe

# 4) 打包 .dbxp（需要 build/ 在 PATH 中，让 CLI 找到 go.exe）
dbx-plugin package . --target windows-x64 --output-dir dist
```

> `build/build.cjs` 与 `build/build-shim.cjs` 默认使用**当前运行的 node** 作为 SEA 基础镜像，因此本地和 CI 行为一致；也可用第一个参数或 `NODE_EXE` 环境变量指定其他 `node.exe`。

构建产物：
- `bin/windows-x64/dbxfs.exe` — 约 87 MB，内含 Node 运行时
- `dist/com.mawen.dbxfs-0.1.1-windows-x64.dbxp` — 约 35 MB 安装包
- `dist/*.artifact.json` — target / url / sha256 / size

**可复现性**：`useCodeCache` 固定为 `false`（V8 代码缓存含非确定内容，开启它会导致同一份源码每次构建出的字节不同）。相同源码 + 相同 node 版本 ⇒ `.dbxp` 字节一致。

### 验收状态

`tests/acceptance.cjs` 覆盖 58 项，**源码模式与 SEA 产物模式均 58/58 通过**：

| 维度 | 覆盖内容 |
|---|---|
| 协议一致性 | initialize 身份与 manifest 一致、协议版本不匹配报错、未知方法 -32601 |
| 连接生命周期 | test 成功/目录不存在/未配置/非法 mode；connect/disconnect 幂等 |
| 工具面 | 8 工具齐全、schema 落在收敛子集、参数名仅字母数字下划线、readOnlyHint 标注正确 |
| 读写删功能 | 分段读、追加、自动建父目录、唯一性校验、replace_all、删文件/空目录 |
| 安全 | `..` 穿越、授权外绝对路径、符号链接逃逸、.key/dbx.db/.env 拒绝读写 |
| 限额 | max_read/max_write 超限拒绝、list 500 截断、search 200 截断 |
| 降级 | 无 root_path 时 granted=false 且操作被拒、未知工具 isError |
| 并发 | 5 并发请求 id 不错配 |
| stdout 纪律 | stdout 只有协议消息、stderr 有日志 |

### 关于 `[backend] language = "go"`

`dbx-plugin.toml` 里声明 `language = "go"` 只是为了让官方 CLI 的构建阶段通过——CLI 只认 Rust/Go 后端，且没有"使用预编译产物"的开关。真实后端是 Node SEA，由 `build/build.cjs` 生成，CLI 通过 `build/go.exe`（一个把预置产物落到 CLI 期望路径的 shim）拿到它。`go-shim/` 与 `build/` 均不进入发布包（见 `.gitignore` 与 `[package].include`）。

## 6. 安装

### 6.1 本地安装（未签名开发包）

> ### ⚠️ 前置条件：不建连接，工具永远不会出现
>
> 这是官方规则的硬性要求，不是可选项：
>
> > **「只用已打开的连接。只为用户当前已打开的插件连接提供工具。」**
>
> 只装插件、不开"内置 AI 工具"开关、或不建连接，三者缺任意一个，AI 助手的工具列表里都不会有文件工具。DBX 也不会 spawn 本插件的 Sidecar 进程（`dbxfs.exe`）——这是判断链路是否打通的**最直接指标**：任务管理器里看不到 `dbxfs.exe`，就说明连接没建或没打开。

**安装步骤（4 步，缺一不可）：**

1. DBX → 插件中心 → 设置 → 开启 **「允许安装未签名开发包」**
2. 插件中心 → 安装本地包 → 选择 `dist/com.mawen.dbxfs-0.1.1-windows-x64.dbxp`
3. **新建连接**：新建连接 → 类型选 **「本地文件系统（授权目录）」** → 填 `root_path`（授权根目录）与 `fs_mode` → 点「测试」应返回"授权目录可用" → 保存并**保持该连接处于打开状态**
4. 插件中心 → 已安装 → **内置 AI 工具** → 打开本插件的开关（仅安装不会暴露任何工具）

**验收**：任务管理器中应出现 `dbxfs.exe` 进程；在 AI 对话里问"你现在有哪些工具"或"当前授权了哪些目录"，应能看到本插件贡献的工具并触发 `permission_status`。

工具以 `dbxfs__<工具名>` 形式暴露，共 8 个：`dbxfs__list_dir`、`dbxfs__stat`、`dbxfs__read_file`、`dbxfs__search`、`dbxfs__write_file`、`dbxfs__edit_file`、`dbxfs__delete`、`dbxfs__permission_status`。

> 官方规则：只有声明 `readOnlyHint` 的工具免确认直接执行；`write_file` / `edit_file` / `delete` 会暂停并展示完整参数，由你选择允许一次或拒绝，五分钟未响应视为拒绝。

### 6.2 上架官方商店

按官方流程，插件源码与候选 Release 放在开发者自己的仓库，上架 PR 提交到 [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)（**不是** `t8y2/dbx`）：

1. 发布源码仓库与候选 Release（`.github/workflows/plugin-release.yml` 会按目标平台构建并产出 `release-candidates.json`）
2. 若仓库在 dbx-store 注册了 `autoUpdate: true`，Store 会自动创建/更新候选 PR；否则手动提交一个候选 PR 到 `dbx-store:main`
3. DBX Store 审核 → **由 Store 统一 Ed25519 签名**（开发者不持有 Store 私钥，也不要自己填 `signingKeyId`）
4. 合并候选 PR，安装包进入官方目录

已发布资产不可覆盖；任何字节变化都必须递增版本并重新审核。

## 7. 已知限制

- **仅在 Windows x64 验证**。SEA 产物按平台构建，上架前需补 `darwin-x64` / `darwin-arm64` / `linux-x64` 目标
- **0.1.0 的 initialize 缺陷已在真实安装中暴露并修复**：2026-11-20 14:36 安装 0.1.0 后 DBX 报 `invalid 'capabilities': expected an array of strings`，根因是 initialize 返回对象而非 `Vec<String>`。0.1.1 已修复并加入回归断言。**当前候选为 0.1.1，需重装**
- `picker: { kind: "directory" }` 仅桌面端有效；Web 宿主拿不到客户端路径，需手填
- 无 UI 工作台（纯 Sidecar 插件），所有交互通过 AI 工具完成

## 8. 历史方案说明（已废弃）

本插件早期以标准 MCP server 形式实现，通过 `F:\Applications\DBX\.mcp.json` 挂载。**该方案已废弃**，原因：

DBX 0.6.72 的内置 agent **不读取用户编写的 `.mcp.json`**——二进制中的 `.mcp.json` 字样只出现在"把 DBX 自己的 MCP bridge 导出给 Claude Code / Cursor / Codex 等外部 CLI"的帮助文本里；`settings_json` 无任何 MCP 配置键，`dbx.db` 无 MCP server 配置表，也没有"添加自定义 MCP server"的 UI 入口。DBX 的 MCP 工具面来自 **native DBX 工具 + 插件通过 `mcp/tools` / `mcp/call` 贡献的工具**。

因此正确路径是把后端改造成 DBX 原生插件的 Sidecar，也就是当前实现。旧实现归档在 `_unused/`（`server.mjs` + `selftest.mjs`），仅作回溯参考，不参与构建。

> `F:\Applications\DBX\.mcp.json` 中的 `dbxfs` 条目对该方案无效，未作改动；如确认不再需要可自行删除（保留其中的 `dbx` 官方条目）。

## 9. 目录结构

```
dbx-plugin-fs/
├── manifest.json          # 运行时契约（身份/权限/入口/贡献点）
├── dbx-plugin.toml        # CLI 构建配置
├── assets/plugin.svg
├── backend/dbxfs.cjs      # Sidecar 源码（DBX Sidecar Protocol v1）
├── bin/windows-x64/       # SEA 产物（构建生成，不提交）
├── build/build.cjs        # SEA 构建脚本
├── tests/acceptance.cjs   # 58 项验收测试
├── go-shim/               # CLI 构建占位，不进入发布包
├── dist/                  # .dbxp 与 artifact.json（构建生成）
└── _unused/               # 归档的旧 MCP server 实现（可回退）
```
