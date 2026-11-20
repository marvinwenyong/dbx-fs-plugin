#!/usr/bin/env node
/**
 * dbx-fs 自测：协议握手 + 权限门 + 读写删全链路
 * 运行：node selftest.mjs
 * 全部用例在系统临时目录执行，不触碰任何真实文件。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
let pass = 0, fail = 0, skip = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
}
function skip_(name, why) { skip++; console.log(`  SKIP  ${name}  (${why})`); }

function client(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiters.shift();
        if (w) w(msg);
      } catch {}
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    waiters.push(resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
  });
  const tool = (name, args) => call("tools/call", { name, arguments: args });
  const text = (r) => r?.result?.content?.[0]?.text ?? "";
  const isErr = (r) => r?.result?.isError === true;
  return { child, call, tool, text, isErr };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbxfs-test-"));
const A = path.join(tmpRoot, "a");           // read_only
const B = path.join(tmpRoot, "b");           // safe_write
const C = path.join(tmpRoot, "c");           // full_access
const OUT = path.join(tmpRoot, "outside");  // 授权目录之外
for (const d of [A, B, C, OUT]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(A, "hello.txt"), "line1\nline2\nTARGET_LINE\nline4\n", "utf8");
fs.writeFileSync(path.join(A, "id_rsa.key"), "PRIVATE-KEY-CONTENT\n", "utf8");
fs.writeFileSync(path.join(OUT, "secret-out.txt"), "should-not-be-readable\n", "utf8");

async function scenarioA() {
  console.log("\n=== 场景 A：read_only（未赋予写权限）===");
  const c = client({ DBX_FS_ROOTS: A, DBX_FS_MODE: "read_only", DBX_FS_LOG: path.join(tmpRoot, "audit.jsonl") });
  try {
    const init = await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1.0" } });
    check("initialize 返回 protocolVersion", !!init.result?.protocolVersion, JSON.stringify(init.error));
    check("initialize 返回 serverInfo=dbx-fs", init.result?.serverInfo?.name === "dbx-fs");
    check("initialize 声明 tools 能力", !!init.result?.capabilities?.tools);

    const list = await c.call("tools/list");
    const names = (list.result?.tools ?? []).map(t => t.name).sort();
    check("tools/list 返回 8 个工具", names.length === 8, names.join(","));
    check("工具集完整", ["fs_delete","fs_edit_file","fs_list_dir","fs_permission_status","fs_read_file","fs_search","fs_stat","fs_write_file"].every(n => names.includes(n)), names.join(","));

    const st = await c.tool("fs_permission_status");
    check("permission_status: granted=true", !c.isErr(st) && JSON.parse(c.text(st)).granted === true);
    check("permission_status: mode=read_only", JSON.parse(c.text(st)).mode === "read_only");
    check("permission_status: write=false", JSON.parse(c.text(st)).capabilities.write === false);

    const rd = await c.tool("fs_read_file", { path: path.join(A, "hello.txt") });
    check("read_file 读取成功", !c.isErr(rd) && c.text(rd).includes("TARGET_LINE"));

    const seg = await c.tool("fs_read_file", { path: path.join(A, "hello.txt"), offset: 3, limit: 1 });
    check("read_file 分段 offset/limit", !c.isErr(seg) && JSON.parse(c.text(seg)).returned === "3-3");

    const ls = await c.tool("fs_list_dir", { path: A });
    check("list_dir 列出 2 个条目", !c.isErr(ls) && JSON.parse(c.text(ls)).count === 2);

    const stt = await c.tool("fs_stat", { path: path.join(A, "hello.txt") });
    check("stat 返回 size", !c.isErr(stt) && JSON.parse(c.text(stt)).size > 0);

    const w = await c.tool("fs_write_file", { path: path.join(A, "new.txt"), content: "x" });
    check("read_only 拒绝写入", c.isErr(w) && /read_only/.test(c.text(w)), c.text(w));
    check("read_only 下未产生文件", !fs.existsSync(path.join(A, "new.txt")));

    const esc = await c.tool("fs_read_file", { path: path.join(A, "..", "outside", "secret-out.txt") });
    check("拒绝 .. 穿越到授权目录外", c.isErr(esc) && /不在授权目录内/.test(c.text(esc)), c.text(esc));

    const outside = await c.tool("fs_read_file", { path: path.join(OUT, "secret-out.txt") });
    check("拒绝授权目录外路径", c.isErr(outside) && /不在授权目录内/.test(c.text(outside)));

    const key = await c.tool("fs_read_file", { path: path.join(A, "id_rsa.key") });
    check("拒绝读取敏感文件(.key)", c.isErr(key) && /敏感文件/.test(c.text(key)), c.text(key));

    const srch = await c.tool("fs_search", { pattern: "TARGET_LINE", content: true, path: A });
    check("search 内容搜索命中", !c.isErr(srch) && JSON.parse(c.text(srch)).hits.some(h => h.line === 3));
    const srchName = await c.tool("fs_search", { pattern: "hello", path: A });
    check("search 文件名搜索命中", !c.isErr(srchName) && JSON.parse(c.text(srchName)).hits.length === 1);

    const bad = await c.call("tools/call", { name: "no_such_tool", arguments: {} });
    check("未知工具返回 isError", bad.result?.isError === true);
    const badm = await c.call("no/such.method", {});
    check("未知方法返回 JSON-RPC error -32601", badm.error?.code === -32601);

    const auditExists = fs.existsSync(path.join(tmpRoot, "audit.jsonl"));
    check("审计日志已写入", auditExists);
  } finally { c.child.kill(); }
}

async function scenarioB() {
  console.log("\n=== 场景 B：safe_write（赋予写权限，禁删除）===");
  const c = client({ DBX_FS_ROOTS: B, DBX_FS_MODE: "safe_write", DBX_FS_AUDIT: "0" });
  try {
    await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1.0" } });
    const f = path.join(B, "note.md");
    const w1 = await c.tool("fs_write_file", { path: f, content: "alpha\nbeta\n" });
    check("write_file 覆盖写入成功", !c.isErr(w1) && fs.readFileSync(f, "utf8") === "alpha\nbeta\n");
    const w2 = await c.tool("fs_write_file", { path: f, content: "gamma\n", mode: "append" });
    check("write_file 追加成功", !c.isErr(w2) && fs.readFileSync(f, "utf8") === "alpha\nbeta\ngamma\n");

    const e1 = await c.tool("fs_edit_file", { path: f, old_string: "beta", new_string: "BETA" });
    check("edit_file 替换成功", !c.isErr(e1) && fs.readFileSync(f, "utf8").includes("BETA"));
    const e2 = await c.tool("fs_edit_file", { path: f, old_string: "不存在的字符串", new_string: "x" });
    check("edit_file 未找到 old_string 时拒绝", c.isErr(e2) && /未找到/.test(c.text(e2)));

    fs.writeFileSync(f, "dup\ndup\n", "utf8");
    const e3 = await c.tool("fs_edit_file", { path: f, old_string: "dup", new_string: "X" });
    check("edit_file 不唯一时拒绝", c.isErr(e3) && /不唯一/.test(c.text(e3)));
    const e4 = await c.tool("fs_edit_file", { path: f, old_string: "dup", new_string: "X", replace_all: true });
    check("edit_file replace_all 成功", !c.isErr(e4) && fs.readFileSync(f, "utf8") === "X\nX\n");

    const d = await c.tool("fs_delete", { path: f });
    check("safe_write 拒绝删除", c.isErr(d) && /full_access/.test(c.text(d)), c.text(d));

    const nested = path.join(B, "sub", "deep", "x.txt");
    const w3 = await c.tool("fs_write_file", { path: nested, content: "deep" });
    check("write_file 自动创建父目录", !c.isErr(w3) && fs.existsSync(nested));
  } finally { c.child.kill(); }
}

async function scenarioC() {
  console.log("\n=== 场景 C：full_access（赋予删除权限）===");
  const c = client({ DBX_FS_ROOTS: C, DBX_FS_MODE: "full_access", DBX_FS_AUDIT: "0" });
  try {
    await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1.0" } });
    const f = path.join(C, "tmp.txt");
    fs.writeFileSync(f, "to-delete", "utf8");
    const d1 = await c.tool("fs_delete", { path: f });
    check("full_access 删除文件成功", !c.isErr(d1) && !fs.existsSync(f));
    const dir = path.join(C, "d");
    fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, "inner", "a.txt"), "a", "utf8");
    const d2 = await c.tool("fs_delete", { path: dir, recursive: true });
    check("full_access 递归删目录成功", !c.isErr(d2) && !fs.existsSync(dir));
    const d3 = await c.tool("fs_delete", { path: path.join(C, "nope.txt") });
    check("删除不存在的路径报错", c.isErr(d3));
  } finally { c.child.kill(); }
}

async function scenarioD() {
  console.log("\n=== 场景 D：未授权（DBX_FS_ROOTS 为空）===");
  const c = client({ DBX_FS_ROOTS: "", DBX_FS_MODE: "read_only", DBX_FS_AUDIT: "0" });
  try {
    await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1.0" } });
    const st = await c.tool("fs_permission_status");
    check("未授权时 granted=false", !c.isErr(st) && JSON.parse(c.text(st)).granted === false);
    const ls = await c.tool("fs_list_dir", { path: A });
    check("未授权时拒绝一切操作", c.isErr(ls) && /未授权/.test(c.text(ls)), c.text(ls));
    const rd = await c.tool("fs_read_file", { path: path.join(A, "hello.txt") });
    check("未授权时拒绝读取", c.isErr(rd) && /未授权/.test(c.text(rd)));
  } finally { c.child.kill(); }
}

async function scenarioE() {
  console.log("\n=== 场景 E：符号链接逃逸（平台支持时）===");
  const link = path.join(A, "escape-link");
  let made = false;
  try { fs.symlinkSync(OUT, link, "junction"); made = true; } catch { try { fs.symlinkSync(OUT, link, "dir"); made = true; } catch {} }
  if (!made) { skip_("符号链接逃逸", "当前用户无创建符号链接权限"); return; }
  const c = client({ DBX_FS_ROOTS: A, DBX_FS_MODE: "read_only", DBX_FS_AUDIT: "0" });
  try {
    await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selftest", version: "1.0" } });
    const r = await c.tool("fs_read_file", { path: path.join(link, "secret-out.txt") });
    check("拒绝经符号链接逃逸出授权目录", c.isErr(r) && /不在授权目录内/.test(c.text(r)), c.text(r));
  } finally { c.child.kill(); }
}

(async () => {
  console.log(`dbx-fs 自测  server=${SERVER}`);
  console.log(`临时目录 ${tmpRoot}`);
  await scenarioA(); await scenarioB(); await scenarioC(); await scenarioD(); await scenarioE();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n========== 结果: PASS ${pass}  FAIL ${fail}  SKIP ${skip} ==========`);
  if (fail) { console.log("失败项: " + failures.join(" | ")); process.exit(1); }
  console.log("全部通过");
})();
