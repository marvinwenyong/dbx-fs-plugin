#!/usr/bin/env node
/**
 * build.cjs — 把 backend/dbxfs.cjs 打包成 Node SEA 单文件可执行文件
 *
 * 为什么需要这一步：
 *   DBX 的 manifest backend entrypoint 只有 executable 一个字段（无 args/env），
 *   要求自包含可执行文件；dbxfs 是零依赖 Node 脚本，因此用 Node SEA 打包。
 *
 * 用法：node build/build.cjs [node.exe 路径]
 * 默认使用 D:\Applications\nodejs\node.exe，可用参数或 NODE_EXE 环境变量覆盖。
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const OUT_DIR = path.join(ROOT, "bin", "windows-x64");
// 默认用当前运行的 node 作为 SEA 基础镜像（CI 与本地都成立），
// 可用第一个参数或 NODE_EXE 环境变量覆盖为指定 node.exe。
const NODE_EXE = process.argv[2] || process.env.NODE_EXE || process.execPath;
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args, cwd) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`失败: ${cmd} 退出码 ${r.status}`); process.exit(1); }
}

console.log(`[1/5] 准备工作目录 ${BUILD}`);
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(NODE_EXE)) { console.error(`找不到 node.exe: ${NODE_EXE}`); process.exit(1); }

console.log(`[2/5] 复制 Node 运行时 ${NODE_EXE}`);
fs.copyFileSync(NODE_EXE, path.join(BUILD, "node.exe"));
fs.copyFileSync(path.join(ROOT, "backend", "dbxfs.cjs"), path.join(BUILD, "dbxfs.cjs"));

console.log("[3/5] 生成 SEA 配置与 blob");
// useCodeCache 必须为 false：V8 代码缓存含非确定内容，会导致同一份源码
// 每次构建出的字节不同，破坏可复现构建（官方要求资产字节变化必须递增版本）。
fs.writeFileSync(path.join(BUILD, "sea-config.json"), JSON.stringify({
  main: "dbxfs.cjs",
  output: "sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2) + "\n");
run(NODE_EXE, ["--experimental-sea-config", "sea-config.json"], BUILD);

console.log("[4/5] 注入 blob（postject）");
fs.copyFileSync(path.join(BUILD, "node.exe"), path.join(BUILD, "dbxfs.exe"));
run("npx", ["--yes", "postject@1.0.0-alpha.6", "dbxfs.exe", "NODE_SEA_BLOB", "sea-prep.blob", "--sentinel-fuse", SENTINEL], BUILD);

console.log("[5/5] 输出到 bin/windows-x64/dbxfs.exe");
const out = path.join(OUT_DIR, "dbxfs.exe");
fs.copyFileSync(path.join(BUILD, "dbxfs.exe"), out);
const size = fs.statSync(out).size;
console.log(`\n完成: ${out}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log("提示: 该文件已内含 Node 运行时，可独立分发，不依赖外部 node。");
