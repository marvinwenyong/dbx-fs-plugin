# 提交 DBX 官方商店的步骤

本文件记录把 `com.mawen.dbxfs` 上架到 DBX 官方商店需要做的事。
**当前状态：候选包 0.1.2 已就绪；源码已推 Gitee（`workbuddy-projects/dbx-plugin-fs`）；
待办是 mirror 到 GitHub 并发 Release——逐步命令见 `PUBLISH-GITHUB.md`。**

> 上架 PR 提交到 [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store)，**不是** `t8y2/dbx`。
> 后者只接受插件 Host、Manifest/Marketplace Schema、SDK、CLI、Packager、文档与官方示例的修改。

## 商店同步机制（读 dbx-store 源码确认）

- 商店定时 Workflow 读 `automation/plugin-sources.json` 中 `autoUpdate: true` 的仓库，
  发现最新公开 Release，读取其中的 `release-candidates.json`，自动创建/更新
  `candidates/<plugin-id>.json`。
- **因此插件源码仓必须在 GitHub**（同步用 GitHub App），且 Release 必须公开、
  必须包含 `.dbxp` + `.artifact.json` + `release-candidates.json` 三样。
- 本仓库 `.github/workflows/plugin-release.yml` 已在后两步自动完成：
  构建 → 验收 → 生成 `release-candidates.json` → 上传 Release。
- 首次上架需在 `automation/plugin-sources.json` 增加本仓库条目（`autoUpdate: true`），
  由维护者合并；之后版本更新全自动。

## 前置条件

| 项 | 状态 |
|---|---|
| 公开源码仓库 | ✅ Gitee 已推（`workbuddy-projects/dbx-plugin-fs`）；⬜ GitHub 待 mirror |
| `manifest.json` 的 `source` / `homepage` | ✅ 已补（Gitee 地址，mirror 时需改成 GitHub 地址） |
| `.dbx-store.json` | ✅ 已建（name/description/tags/permissions/license/releaseNotes） |
| `release-candidates.json` 的 `url` | ✅ 已指向 Gitee；Release 时由 workflow 按 GitHub 仓库 + tag 重新生成 |
| darwin / linux 目标产物 | ⬜ 仅 windows-x64（已验证）；workflow 内留了 matrix 扩展注释 |
| 真实 DBX 安装验证 | ⬜ 需人工按 README §6.1 执行（0.1.2 重装后跑 permission_status 闭环） |

## 步骤

1. **mirror 到 GitHub 并推送**（详见 `PUBLISH-GITHUB.md`）：建公开仓 → 把源码与历史推上去 → 同步切换所有 URL（manifest / .dbx-store.json / package.json / release-candidates.json）
2. **打 GitHub Release**（tag `v0.1.2`）：workflow 自动构建候选包、跑验收、生成并上传 `release-candidates.json`
3. **提交候选 PR 到 `dbx-store:main`**
   - 方式一（自动）：在 `automation/plugin-sources.json` 增加本仓库条目并开 PR，商店同步器随后自动创建候选 PR
   - 方式二（手动）：fork dbx-store，按 `.github/PULL_REQUEST_TEMPLATE/plugin-catalog.md` 建 `candidates/com.mawen.dbxfs.json`
   - **不需要**额外提交 Issue
4. **等待 DBX Store 审核并签名**
   - 由 Store 用官方仓库密钥统一 Ed25519 签名
   - 审核通过前**不要**自行填写 `signingKeyId` 或 `verified: true`
   - 审核前候选 PR 里不能出现 `.dbxp` 二进制、私钥或 Token
   - 开发者**不运行 keygen、不自行填写 `signingKeyId`**（它属于商店 artifact metadata，不是 Manifest 字段）
8. **合并候选 PR**，安装包进入官方目录

## 注意事项

- 已发布资产不可覆盖；任何字节变化都必须递增插件版本并重新审核
- `artifact.json` 中的 `target` / `url` / `sha256` / `size` 绑定确切字节
- 人工审核决定插件能否展示；签名只保证审核后的安装包没被替换，**不能替代源码审查**，也不是 Sidecar 的操作系统沙箱
- Sidecar 以当前用户权限运行，不属于操作系统沙箱——README §4 的黑名单与授权根约束是插件自己的防护，必须保留

## 本地候选包（已生成）

```
dist/com.mawen.dbxfs-0.1.2-windows-x64.dbxp        35,207,625 字节
dist/com.mawen.dbxfs-0.1.2-windows-x64.artifact.json
sha256: f4464875b97f72ffc9a0051a8e0041e20b429e888772cae231387bc0f567564f
```

该包为**未签名审核候选包**，本地安装需在 DBX 插件中心开启「允许安装未签名开发包」。
`.dbxp` 二进制**不进入 git 历史**（`.gitignore` 排除 `dist/`），只作为 Release 资产发布。

### 版本记录

| 版本 | 状态 | 说明 |
|---|---|---|
| 0.1.0 | 已废弃 | `initialize` 返回的 `capabilities` 误用对象而非字符串数组，DBX 报 `invalid 'capabilities': expected an array of strings`，工具未暴露 |
| 0.1.1 | 已安装但授权不可用 | 修复 capabilities 后工具可见，但 `connection/test` 报「未配置 root_path」——DBX 真实载荷把授权配置放在 `connection.external_config` 里，平铺查找落空 |
| 0.1.2 | **当前候选** | 授权配置改为递归查找（优先 `connection` 子树），修复 `provider.id` 抢先导致的 session 键错配；新增脱敏诊断日志；验收测试增至 68 项 |
