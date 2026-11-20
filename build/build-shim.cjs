#!/usr/bin/env node
/**
 * build-shim.cjs — 生成 build/go.exe
 *
 * 作用：dbx-plugin CLI 只支持 Rust/Go 后端源码构建，且没有"使用预编译产物"的开关。
 * 本脚本用 Node SEA 生成一个 go.exe，它把 build/dbxfs.exe（真实后端）复制到
 * CLI 通过 `go build -o <path>` 指定的输出路径，从而让官方打包流程原样跑通。
 *
 * 该文件只影响本地/CI 打包，不进入发布包（见 .gitignore 与 dbx-plugin.toml）。
 *
 * 用法：node build/build-shim.cjs [node.exe 路径]
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BUILD = __dirname;
// 默认用当前运行的 node 作为 SEA 基础镜像（CI 与本地都成立），
// 可用第一个参数或 NODE_EXE 环境变量覆盖为指定 node.exe。
const NODE_EXE = process.argv[2] || process.env.NODE_EXE || process.execPath;
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: BUILD, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`失败: ${cmd} 退出码 ${r.status}`); process.exit(1); }
}

if (!fs.existsSync(NODE_EXE)) { console.error(`找不到 node.exe: ${NODE_EXE}`); process.exit(1); }

// 自行生成配置，不依赖外部文件（保证从零构建可复现）。
// useCodeCache 必须为 false：V8 代码缓存含非确定内容，会让同一份源码
// 每次构建出的字节不同，破坏可复现构建。
fs.writeFileSync(path.join(BUILD, "fakego-sea.json"), JSON.stringify({
  main: "fakego.cjs",
  output: "fakego.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2) + "\n");

fs.copyFileSync(NODE_EXE, path.join(BUILD, "node.exe"));
run(NODE_EXE, ["--experimental-sea-config", "fakego-sea.json"]);
fs.copyFileSync(path.join(BUILD, "node.exe"), path.join(BUILD, "go.exe"));
run("npx", ["--yes", "postject@1.0.0-alpha.6", "go.exe", "NODE_SEA_BLOB", "fakego.blob", "--sentinel-fuse", SENTINEL]);
console.log(`\n完成: ${path.join(BUILD, "go.exe")}`);
