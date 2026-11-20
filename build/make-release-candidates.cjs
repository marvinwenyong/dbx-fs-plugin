#!/usr/bin/env node
/**
 * make-release-candidates.cjs — 从 dist/ 里的构建产物生成 release-candidates.json
 *
 * DBX Store 的定时同步器会读取插件仓库 Release 中的 release-candidates.json，
 * 据此创建/更新 candidates/<plugin-id>.json。因此每个 Release 都必须带上这个文件，
 * 且 url 必须指向该 Release 的真实下载地址。
 *
 * 用法：
 *   node build/make-release-candidates.cjs [distDir]
 *
 * 环境变量：
 *   GITHUB_REPOSITORY   owner/repo，用于拼 Release 下载地址
 *   RELEASE_TAG         Release 的 tag（如 v0.1.2），缺省时用 version + 占位
 *
 * 产物：<distDir>/release-candidates.json
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DIST = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
const PLUGIN_ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "manifest.json"), "utf8"));

const repo = process.env.GITHUB_REPOSITORY || "<owner>/<repo>";
const tag = process.env.RELEASE_TAG || `v${MANIFEST.version}`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (!fs.existsSync(DIST)) {
  console.error(`dist 目录不存在: ${DIST}，请先构建`);
  process.exit(1);
}

const artifacts = fs.readdirSync(DIST).filter(f => f.endsWith(".artifact.json"));
if (artifacts.length === 0) {
  console.error(`dist 目录下没有 .artifact.json: ${DIST}`);
  process.exit(1);
}

const candidates = [];
for (const name of artifacts.sort()) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIST, name), "utf8"));
  const dbxp = path.join(DIST, path.basename(meta.url || name.replace(/\.artifact\.json$/, ".dbxp")));
  if (!fs.existsSync(dbxp)) {
    console.error(`artifact 对应的包不存在: ${dbxp}`);
    process.exit(1);
  }
  // artifact.json 的 url 只有文件名；发布到 Release 后拼出真实下载地址
  candidates.push({
    target: meta.target,
    url: `https://github.com/${repo}/releases/download/${tag}/${path.basename(dbxp)}`,
    sha256: sha256(dbxp),
    size: fs.statSync(dbxp).size,
  });
}

// 与 artifact.json 交叉核对，防止改过 dist 后放出不一致的清单
for (const c of candidates) {
  const artifactPath = path.join(DIST, `${MANIFEST.id}-${c.target}.artifact.json`);
  if (!fs.existsSync(artifactPath)) continue;
  const meta = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (meta.sha256 && meta.sha256 !== c.sha256) {
    console.error(`sha256 不一致: ${c.target} artifact=${meta.sha256} 实算=${c.sha256}`);
    process.exit(1);
  }
  if (meta.size && meta.size !== c.size) {
    console.error(`size 不一致: ${c.target} artifact=${meta.size} 实算=${c.size}`);
    process.exit(1);
  }
}

const out = {
  plugin: MANIFEST.id,
  version: MANIFEST.version,
  candidates,
};

const outPath = path.join(DIST, "release-candidates.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`已生成 ${outPath}`);
for (const c of candidates) console.log(`  ${c.target}  ${c.size}  ${c.sha256}`);
