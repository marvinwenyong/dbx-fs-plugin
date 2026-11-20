# 发布到 GitHub 并提交 DBX 官方商店（操作手册）

本文件记录把 `com.mawen.dbxfs` 上架 DBX 官方商店的完整流程与当前进度。

## 0. 当前状态

**已完成**

- 敏感信息清理：测试连接 ID 改为明显虚构值（git 历史已用 filter-branch 清洗）、
  构建脚本注释去掉本地路径、manifest 占位路径中性化、README 本地路径改中性表述；
  git 全部提交经 `git grep` 逐模式扫描，无个人路径 / 邮箱 / 真实连接 ID / 库表业务信息
- `manifest.json`：补 `source` / `homepage`，英文基础描述 + `zh-CN` localizations（已过官方 schema 校验）
- `.dbx-store.json`：已建（商店展示元数据）
- `.github/workflows/plugin-release.yml`：构建 → 验收 → **生成 `release-candidates.json`** → 上传 Release
- `build/make-release-candidates.cjs`：候选清单生成器，与 `artifact.json` 交叉核对 sha256/size
- 源码内所有 URL 已切换到 GitHub 主仓 `marvinwenyong/dbx-fs-plugin`

**待执行**（见下方各节）

1. 推送源码与 tag 到 GitHub
2. 打 v0.1.2 Release（workflow 自动构建并上传 3 个资产）
3. 向 dbx-store 提交候选 PR
4. 等待审核签名合并

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

## 3. 提交 dbx-store 候选 PR

### 方式一（推荐，全自动）：注册仓库让同步器建 PR

fork [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store) → 编辑
`automation/plugin-sources.json`，在 `plugins` 数组里加一条：

```json
{
  "repository": "marvinwenyong/dbx-fs-plugin",
  "metadataPath": ".dbx-store.json",
  "autoUpdate": true
}
```

开 PR 到 `t8y2/dbx-store:main`。合并后，商店定时同步器读到 v0.1.2 Release，
自动创建 `candidates/com.mawen.dbxfs.json` 候选 PR。**之后每次发新版本 Release 全自动。**

### 方式二（手动）：直接提交候选文件

fork dbx-store → 新建 `candidates/com.mawen.dbxfs.json`，内容如下（已填好真实地址与哈希）：

```json
{
  "schemaVersion": 1,
  "id": "com.mawen.dbxfs",
  "publisher": "mawen",
  "version": "0.1.2",
  "name": "DBX File System",
  "description": "Gives the DBX built-in AI assistant file capabilities inside an authorized directory: list directories, read files, search content, precise edits, delete. Three permission tiers, sensitive-file denylist, symlink escape protection, and an audit log.",
  "icon": "https://github.com/marvinwenyong/dbx-fs-plugin/raw/main/assets/plugin.svg",
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
      "sha256": "__PACKAGE_SHA256__",
      "size": __PACKAGE_SIZE__
    }
  ]
}
```

> `__PACKAGE_SHA256__` / `__PACKAGE_SIZE__` 以 **Release 上 workflow 实际产出的**
> `release-candidates.json` 为准（workflow 从源码重新构建，字节以它为准）。
> 本地参考值见 `CHANGELOG.md` 0.1.2 条与 `STORE_SUBMISSION.md`。

按 PR 模板填写：capabilities / permissions / data access / network access / native sidecar behavior。
**候选 PR 保持红色（`awaiting DBX Store signing`）是设计如此**，等维护者 `/sign`。

### 不能做

- 自行填写 `signingKeyId` 或 `verified: true`
- 在 PR 里放 `.dbxp` 二进制、私钥、Token
- URL 引用 `t8y2/dbx-store` 的 Release

## 4. 审核通过后

1. 维护者运行签名 workflow → 合并 PR → 插件进入官方目录
2. 用户在 DBX 插件中心搜索 `DBX File System` 或 `com.mawen.dbxfs` 直接安装
3. 安装后仍需按 README §6.1 建连接 + 开「内置 AI 工具」开关（官方安装不改变这个前提）

## 5. 后续版本更新

1. 改代码 → 验收 → bump `manifest.json` 与 `backend/dbxfs.cjs` 的版本 → 更新 CHANGELOG
2. `git tag v0.1.3 && git push github v0.1.3` → 发 Release
3. workflow 自动构建上传；已注册 `autoUpdate: true` 的仓库由同步器自动建候选 PR
4. 等审核签名合并。**每次更新必须新版本号，已发布资产不可覆盖。**
