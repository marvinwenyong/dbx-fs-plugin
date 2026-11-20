# 发布到 GitHub 并提交 DBX 官方商店（操作手册）

本文件记录把 `com.mawen.dbxfs` 上架 DBX 官方商店的完整流程与当前进度。

## 0. 当前状态

**已完成**

- 敏感信息清理：测试连接 ID 改为明显虚构值（git 历史已用 filter-branch 清洗）、
  构建脚本注释去掉本地路径、manifest 占位路径中性化、README 本地路径改中性表述；
  git 全部提交经 `git grep` 逐模式扫描，无个人路径 / 邮箱 / 真实连接 ID / 库表业务信息
- `manifest.json`：补 `source` / `homepage`，英文基础描述 + `zh-CN` localizations（已过官方 schema 校验）
- `.dbx-store.json`：已建（商店展示元数据）
- `.github/workflows/plugin-release.yml`：构建 → 验收 → **生成 `release-candidates.json`** → 上传 Release；
  CI 打包步骤已修（go shim 前置 PATH）
- `build/make-release-candidates.cjs`：候选清单生成器，与 `artifact.json` 交叉核对 sha256/size
- 源码内所有 URL 已切换到 GitHub 主仓 `marvinwenyong/dbx-fs-plugin`
- **源码与 tag 已推送 GitHub**：`main` 与 `v0.1.2` 均指向 `32f0079`

**待执行**（见下方各节）

1. 在 GitHub 网页创建 v0.1.2 Release（§2）——workflow 自动构建并上传 3 个资产
2. fork dbx-store，提交首次上架 3 文件（§3）：`publishers/mawen.json` +
   `candidates/com.mawen.dbxfs.json` + `automation/plugin-sources.json` 条目
3. 等待维护者审核、签名、合并（§3.5）

## 1. 推送到 GitHub

```bash
cd /f/Applications/DBX/dbx-fs-plugin
git remote add github https://github.com/marvinwenyong/dbx-fs-plugin.git   # 已添加则跳过
# 远端仅有 GitHub 自动生成的占位 README（30 字节，无内容），用 --force 以真实历史覆盖
git push --force github main
git push github v0.1.2
```

> Gitee 镜像（可选）：在 Gitee 建公开仓 `workbuddy-projects/dbx-plugin-fs` 后
> `git remote add gitee git@gitee.com:workbuddy-projects/dbx-plugin-fs.git && git push gitee main`。
> 商店同步只认 GitHub，Gitee 仅作备份。

## 2. 打 Release（tag v0.1.2）

tag 推送后在 GitHub 网页 **Releases → Draft a new release**：

- Choose a tag: `v0.1.2`
- Title: `v0.1.2`
- Description 粘贴（或精简）`CHANGELOG.md` 的 0.1.2 段
- **Publish release**

发布后 workflow `Release DBX plugin` 自动跑：构建 → 68 项验收 → 生成候选清单 → 上传。
**必须确认 Release 页面出现 3 个资产**（缺一商店无法同步）：

| 资产 | 说明 |
|---|---|
| `com.mawen.dbxfs-0.1.2-windows-x64.dbxp` | 未签名候选包 |
| `com.mawen.dbxfs-0.1.2-windows-x64.artifact.json` | target/url/sha256/size |
| `release-candidates.json` | 商店同步器读取的候选清单 |

若 workflow 失败，先看 Actions 日志；最常见是验收测试或打包步骤，本地可复现：
`node tests/acceptance.cjs --exe`。

## 3. 提交 dbx-store 候选 PR（首次上架）

> 流程以官方文档《开发和提交 DBX 插件 → 提交官方商店的完整流程》与 dbx-store
> `scripts/validate.mjs` 校验规则为准（已逐条核对）。

**首次上架需要提交 3 个文件**（fork [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store) 后在网页上逐个 "Add file → Create new file" 创建，然后开 PR 到 `t8y2/dbx-store:main`）：

### 3.1 `publishers/mawen.json`（发布者记录，首次必需）

validate.mjs 硬性要求：候选文件的 publisher 必须是已注册的发布者 id。

```json
{
  "id": "mawen",
  "name": "mawen",
  "status": "unverified"
}
```

### 3.2 `candidates/com.mawen.dbxfs.json`（版本候选）

**文件名必须与插件 id 一致。** `sha256` 与 `size` 两个值从 Release 上 workflow 实际产出的
`release-candidates.json` 里抄（CI 用 Node 22 构建，与本地字节不同，不能用本地值）：

```json
{
  "schemaVersion": 1,
  "id": "com.mawen.dbxfs",
  "publisher": "mawen",
  "version": "0.1.2",
  "name": "DBX File System",
  "description": "Gives the DBX built-in AI assistant file capabilities inside an authorized directory: list directories, read files, search content, precise edits, delete. Three permission tiers, sensitive-file denylist, symlink escape protection, and an audit log.",
  "icon": "https://raw.githubusercontent.com/marvinwenyong/dbx-fs-plugin/v0.1.2/assets/plugin.svg",
  "tags": ["files", "developer-tools", "ai", "mcp", "productivity"],
  "permissions": [],
  "source": "https://github.com/marvinwenyong/dbx-fs-plugin/tree/v0.1.2",
  "homepage": "https://github.com/marvinwenyong/dbx-fs-plugin",
  "license": "MIT",
  "releaseNotes": "首个公开候选版本。授权目录内的 8 个文件工具（列目录/属性/读取/搜索/写入/精确编辑/删除/授权状态查询），连接配置驱动权限，不读环境变量；realpath 校验防符号链接逃逸与 .. 穿越；敏感文件黑名单；只读工具免宿主确认，写删工具需人工确认。",
  "localizations": {
    "zh-CN": {
      "name": "DBX 文件系统",
      "description": "给 DBX 内置 AI 助手授予授权目录内的文件能力：列目录、读文件、内容搜索、精确编辑、删除。三档权限模式、敏感文件黑名单、符号链接逃逸防护与审计日志。"
    }
  },
  "targets": [
    {
      "target": "windows-x64",
      "url": "https://github.com/marvinwenyong/dbx-fs-plugin/releases/download/v0.1.2/com.mawen.dbxfs-0.1.2-windows-x64.dbxp",
      "sha256": "<从 Release 的 release-candidates.json 抄 64 位十六进制>",
      "size": <从 Release 的 release-candidates.json 抄字节数>
    }
  ]
}
```

### 3.3 `automation/plugin-sources.json`（注册自动同步，一次投入长期自动）

在 `plugins` 数组里加一条（保持 JSON 合法，注意逗号）：

```json
{
  "repository": "marvinwenyong/dbx-fs-plugin",
  "metadataPath": ".dbx-store.json",
  "autoUpdate": true
}
```

注册后，**以后每次发新 Release，商店同步器自动创建/更新候选 PR**，无需再手动提交候选文件。

### 3.4 PR 描述里写清（审核材料）

```
插件：com.mawen.dbxfs v0.1.2（DBX File System）
类型：Native Sidecar 插件（Node SEA 单文件后端，stdio-jsonl）
能力：connection-provider（授权目录连接）+ mcp（8 个文件工具）
权限：无 host.* 权限（manifest permissions 为空）；文件访问范围完全由用户在
      连接配置里填写的授权根目录限定，越界拒绝
数据访问：仅访问用户显式授权的目录；realpath 校验防符号链接逃逸与 .. 穿越；
          敏感文件（.key/.pem/.pfx/.dbx.db/.env 等）拒读写；审计写
          DBX_PLUGIN_DATA_DIR/audit.jsonl
网络访问：无（sidecar 不发起任何网络请求）
原生行为：后端为当前用户权限运行的可执行文件（非 OS 沙箱）；写/删工具需宿主
          人工确认，只读工具免确认
验证：68 项验收测试（tests/acceptance.cjs）源码与打包产物双模式通过；
      可复现构建（useCodeCache:false）
许可证：MIT
```

### 3.5 提交后会发生什么

1. CI 校验候选文件；**保持红色 `open candidate(s) awaiting DBX Store signing` 是设计如此**（签名前故意阻断合并）
2. 维护者审核源码、manifest、权限、候选 SHA-256 与大小、原生行为
3. 审核通过后维护者运行受保护的 **Sign plugin PR candidates** workflow：下载候选包 → 校验字节 → DBX Store 仓库密钥 Ed25519 签名 → 回写 `plugins/com.mawen.dbxfs.json` 与 `catalog/index.json` 到同一个 PR
4. CI 变绿后维护者合并，插件进入官方目录

### 不能做（官方明令）

- 自行填写 `signingKeyId` 或 `verified: true`
- 在 PR 里放 `.dbxp` 二进制、插件完整源码副本、私钥或 Token
- 候选 URL 引用 `t8y2/dbx-store` 的 Release
- 手工编辑生成物 `plugins/*.json` / `catalog/index.json`

## 4. 审核通过后

1. 维护者运行签名 workflow → 合并 PR → 插件进入官方目录
2. 用户在 DBX 插件中心搜索 `DBX File System` 或 `com.mawen.dbxfs` 直接安装
3. 安装后仍需按 README §6.1 建连接 + 开「内置 AI 工具」开关（官方安装不改变这个前提）

## 5. 后续版本更新

1. 改代码 → 验收 → bump `manifest.json` 与 `backend/dbxfs.cjs` 的版本 → 更新 CHANGELOG
2. `git tag v0.1.3 && git push github v0.1.3` → 发 Release
3. workflow 自动构建上传；已注册 `autoUpdate: true` 的仓库由同步器自动建候选 PR
4. 等审核签名合并。**每次更新必须新版本号，已发布资产不可覆盖。**
