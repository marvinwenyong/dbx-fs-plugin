# 提交 DBX 官方商店的步骤

本文件记录把 `com.mawen.dbxfs` 上架到 DBX 官方商店需要做的事。**当前状态：候选包已就绪，尚未提交。**

> 上架 PR 提交到 [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)，**不是** `t8y2/dbx`。
> 后者只接受插件 Host、Manifest/Marketplace Schema、SDK、CLI、Packager、文档与官方示例的修改。

## 前置条件（尚未满足）

| 项 | 状态 |
|---|---|
| 公开源码仓库 | ❌ 需要先建（GitHub 或自定义仓库） |
| `manifest.json` 的 `source` / `homepage` | ❌ 当前省略，建仓后补 HTTPS 地址 |
| `release-candidates.json` 的 `url` | ❌ 当前是 `<owner>/<repo>` 占位 |
| darwin / linux 目标产物 | ❌ 当前只有 windows-x64 |
| 真实 DBX 安装验证 | ❌ 需人工按 README §6.1 执行 |

## 步骤

1. **建源码仓库并推送**（含 `.github/workflows/plugin-release.yml`）
2. **补齐 `manifest.json`**：`source`、`homepage` 指向该仓库
3. **补齐其他平台**：在 `build/build.cjs` 已支持的前提下，为 darwin-x64 / darwin-arm64 / linux-x64 各构建一次，`manifest.entrypoints.backend.executable` 需按目标平台指向对应可执行文件（当前只有 `bin/windows-x64/dbxfs.exe`）
4. **打 GitHub Release**（tag `v0.1.0`），workflow 自动构建候选包并上传到 Release
5. **更新 `release-candidates.json`**：把真实 Release 下载地址和各目标 sha256 / size 填进去
6. **提交候选 PR 到 `dbx-store:main`**
   - 若仓库在 dbx-store 注册了 `autoUpdate: true`，Store 会自动创建/更新候选 PR
   - 否则手动开一个候选 PR，附上 Release 与 `release-candidates.json` 地址
   - **不需要**额外提交 Issue
7. **等待 DBX Store 审核并签名**
   - 由 Store 用官方仓库密钥统一 Ed25519 签名
   - 开发者**不运行 keygen、不自行填写 `signingKeyId`**（它属于商店 artifact metadata，不是 Manifest 字段）
8. **合并候选 PR**，安装包进入官方目录

## 注意事项

- 已发布资产不可覆盖；任何字节变化都必须递增插件版本并重新审核
- `artifact.json` 中的 `target` / `url` / `sha256` / `size` 绑定确切字节
- 人工审核决定插件能否展示；签名只保证审核后的安装包没被替换，**不能替代源码审查**，也不是 Sidecar 的操作系统沙箱
- Sidecar 以当前用户权限运行，不属于操作系统沙箱——README §4 的黑名单与授权根约束是插件自己的防护，必须保留

## 本地候选包（已生成）

```
dist/com.mawen.dbxfs-0.1.1-windows-x64.dbxp        35,204,782 字节
dist/com.mawen.dbxfs-0.1.1-windows-x64.artifact.json
sha256: 9f145c446ee67a92af6fb4028ee1098e797684616c1bd619b8a72ca62fe3b31a
```

该包为**未签名审核候选包**，本地安装需在 DBX 插件中心开启「允许安装未签名开发包」。

### 版本记录

| 版本 | 状态 | 说明 |
|---|---|---|
| 0.1.0 | 已安装到本机（14:36） | `initialize` 返回的 `capabilities` 误用对象而非字符串数组，DBX 报 `invalid 'capabilities': expected an array of strings`，工具未暴露 |
| 0.1.1 | **当前候选** | 修复上述问题，`capabilities` 改为 `["connections"]`；验收测试增至 60 项并加入回归断言 |
