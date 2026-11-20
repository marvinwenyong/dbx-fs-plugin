/**
 * dbxfs 本地验收测试
 * ---------------------------------------------------------------------------
 * 拉起 DBX Sidecar（默认直跑 backend/dbxfs.cjs 源码；传 --exe 测打包后的
 * bin/windows-x64/dbxfs.exe），以 stdio-jsonl 模拟 DBX 宿主跑完整协议流程。
 *
 * 覆盖官方「本地验收清单」与安全约束：
 *   协议一致性 / 连接生命周期 / 工具 schema / 读写删功能 /
 *   路径越界 / 符号链接逃逸 / 敏感文件 / 三档权限模式 / 各项限额 /
 *   stdout 纪律 / 未授权降级 / 并发请求关联
 *
 * 用法：
 *   node tests/acceptance.cjs          # 直跑源码（开发迭代）
 *   node tests/acceptance.cjs --exe    # 测 SEA 打包产物（发布前验收）
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USE_EXE = process.argv.includes("--exe");
const PLUGIN_ROOT = path.join(__dirname, "..");
const TARGET = USE_EXE
  ? { cmd: path.join(PLUGIN_ROOT, "bin", "windows-x64", "dbxfs.exe"), args: [] }
  : { cmd: process.execPath, args: [path.join(PLUGIN_ROOT, "backend", "dbxfs.cjs")] };
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "manifest.json"), "utf8"));
console.log(`被测对象: ${USE_EXE ? "SEA 可执行文件" : "backend 源码"}  ${TARGET.cmd}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ------------------------------ 宿主模拟 ------------------------------ */

const child = spawn(TARGET.cmd, TARGET.args, { stdio: ["pipe", "pipe", "pipe"] });
let stdoutBuf = "";
const pending = new Map();
let seq = 0;
let stdoutClean = true;
let stderrText = "";

child.stdout.on("data", (d) => {
  stdoutBuf += d.toString("utf8");
  let i;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    if (!line.startsWith("{")) { stdoutClean = false; continue; } // stdout 出现非协议输出
    let m; try { m = JSON.parse(line); } catch { stdoutClean = false; continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", (d) => { stderrText += d.toString("utf8"); });

function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, 20000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
/** 取出 result；若有 error 则返回 { __error } */
async function call(method, params) {
  const m = await rpc(method, params);
  if (m.error) return { __error: m.error };
  return m.result;
}
/** 调用工具，返回 { text, isError, parsed } */
async function tool(name, args, conn) {
  const r = await call("mcp/call", { tool: name, arguments: args, ...(conn ? { lifecycle: conn } : {}) });
  if (r.__error) return { __error: r.__error };
  const c = (r.content || [])[0] || {};
  let parsed = null;
  try { parsed = JSON.parse(c.text); } catch {}
  return { text: c.text || "", isError: !!r.isError, parsed };
}

/* ------------------------------ 测试环境 ------------------------------ */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dbxfs-acc-"));
const SUB = path.join(ROOT, "work");
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "dbxfs-out-"));
const SECRET = path.join(ROOT, "server.key");

function mkConn(over) {
  return { connection: { id: "conn-1", name: "验收连接", config: { root_path: ROOT, fs_mode: "safe_write", ...(over || {}) } } };
}
function w(rel, content) {
  const p = path.join(SUB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/* ------------------------------ 主流程 ------------------------------ */

(async () => {
  // 预置测试数据
  fs.mkdirSync(SUB, { recursive: true });
  w("hello.txt", "line1\nline2\nline3\nline4\nline5\n");
  w("src/app.js", "const a = 1;\nconst b = 2;\nTODO fix\n");
  w("src/util.js", "export const u = 1;\n");
  fs.mkdirSync(path.join(SUB, "emptydir"), { recursive: true });
  fs.writeFileSync(SECRET, "PRIVATE-KEY-CONTENT", "utf8");
  fs.writeFileSync(path.join(ROOT, "dbx.db"), "fake-db", "utf8");
  fs.writeFileSync(path.join(ROOT, "note.md"), "# note\n", "utf8");
  // 符号链接指向授权目录外
  const link = path.join(SUB, "escape");
  try { fs.symlinkSync(OUTSIDE, link, "junction"); } catch {}
  fs.writeFileSync(path.join(OUTSIDE, "outside.txt"), "OUTSIDE-SECRET", "utf8");

  /* ---- 1. 协议一致性 ---- */
  section("1. plugin/initialize 与协议一致性");
  const init = await call("plugin/initialize", { host: { protocolVersions: [1] } });
  check("initialize 返回 protocolVersion=1", init.protocolVersion === 1, JSON.stringify(init));
  check("initialize 返回 plugin.id", init.plugin && init.plugin.id === MANIFEST.id, JSON.stringify(init.plugin));
  check("initialize 的 id 与 manifest.json 一致", init.plugin.id === MANIFEST.id);
  check("initialize 的 version 与 manifest.json 一致", init.plugin.version === MANIFEST.version, `${init.plugin && init.plugin.version} vs ${MANIFEST.version}`);
  // 回归防护：capabilities 必须是字符串数组（DBX 反序列化要求 Vec<String>，
  // 返回对象会在安装时直接报 "invalid 'capabilities': expected an array of strings"）
  check("capabilities 是字符串数组", Array.isArray(init.capabilities) && init.capabilities.every(c => typeof c === "string" && /^[a-z0-9][a-z0-9._:-]*$/.test(c)), JSON.stringify(init.capabilities));
  check("capabilities 包含 connections", Array.isArray(init.capabilities) && init.capabilities.includes("connections"), JSON.stringify(init.capabilities));

  const badProto = await call("plugin/initialize", { host: { protocolVersions: [99] } });
  check("协议版本不匹配时返回 error", !!badProto.__error, JSON.stringify(badProto));

  const unknown = await call("no/such/method", {});
  check("未知方法返回 -32601", unknown.__error && unknown.__error.code === -32601, JSON.stringify(unknown));

  /* ---- 2. 连接生命周期 ---- */
  section("2. connection 生命周期");
  const t1 = await call("connection/test", mkConn());
  check("test: 合法目录返回 success", t1.success === true, JSON.stringify(t1));

  const t2 = await call("connection/test", mkConn({ root_path: path.join(ROOT, "no-such-dir") }));
  check("test: 目录不存在返回 success=false", t2.success === false, JSON.stringify(t2));

  const t3 = await call("connection/test", { connection: { id: "x", config: {} } });
  check("test: 未配置 root_path 返回 success=false", t3.success === false, JSON.stringify(t3));

  const t4 = await call("connection/test", mkConn({ fs_mode: "bogus" }));
  check("test: 非法 fs_mode 返回 error", !!t4.__error, JSON.stringify(t4));

  const c1 = await call("connection/connect", mkConn());
  check("connect: 返回 success", c1.success === true, JSON.stringify(c1));

  const d1 = await call("connection/disconnect", mkConn());
  check("disconnect: 返回 success", d1.success === true, JSON.stringify(d1));
  const d2 = await call("connection/disconnect", mkConn());
  check("disconnect: 重复调用幂等", d2.success === true, JSON.stringify(d2));

  /* ---- 3. mcp/tools schema ---- */
  section("3. mcp/tools 工具面");
  const tools = await call("mcp/tools", { connectionId: "conn-1" });
  const names = (tools.tools || []).map(t => t.name);
  const expected = ["list_dir", "stat", "read_file", "search", "write_file", "edit_file", "delete", "permission_status"];
  check("返回 8 个工具", names.length === 8, names.join(","));
  check("工具名与 manifest 声明一致", expected.every(n => names.includes(n)), names.join(","));

  const declared = Object.keys(MANIFEST.contributions.find(c => c.type === "mcp").tools);
  check("manifest.tools 覆盖全部工具", declared.length === 8 && declared.every(n => names.includes(n)), declared.join(","));

  const allowed = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);
  const schemaOk = (tools.tools || []).every(t => {
    const s = t.inputSchema;
    if (!s || s.type !== "object" || typeof s.properties !== "object") return false;
    const props = Object.values(s.properties);
    if (!props.every(p => allowed.has(p.type))) return false;
    const argNames = Object.keys(s.properties);
    if (!argNames.every(n => /^[A-Za-z0-9_]+$/.test(n))) return false;
    return true;
  });
  check("所有 inputSchema 落在收敛子集内（type/properties/required）", schemaOk);

  const readOnly = (tools.tools || []).filter(t => (t.annotations || {}).readOnlyHint).map(t => t.name).sort();
  check("只读工具带 readOnlyHint", JSON.stringify(readOnly) === JSON.stringify(["list_dir", "permission_status", "read_file", "search", "stat"]), readOnly.join(","));

  const writeTools = (tools.tools || []).filter(t => ["write_file", "edit_file", "delete"].includes(t.name));
  check("写/删工具不带 readOnlyHint（宿主将要求确认）", writeTools.every(t => !(t.annotations || {}).readOnlyHint));

  /* ---- 4. 读类工具 ---- */
  section("4. 读类工具");
  const conn = mkConn().connection;
  const lifecycle = { provider: "dbxfs", connection: conn, runtime: {} };

  const ls = await tool("list_dir", { path: SUB }, lifecycle);
  check("list_dir 列出一级内容", ls.parsed && ls.parsed.count >= 3 && ls.parsed.entries.some(e => e.name === "hello.txt"), ls.text.slice(0, 200));

  const st = await tool("stat", { path: path.join(SUB, "hello.txt") }, lifecycle);
  check("stat 返回文件元信息", st.parsed && st.parsed.type === "file" && st.parsed.size > 0, st.text.slice(0, 200));

  const rd = await tool("read_file", { path: path.join(SUB, "hello.txt") }, lifecycle);
  check("read_file 读取全文", rd.parsed && rd.parsed.content.split("\n").length === 5, rd.text.slice(0, 200));

  const rdSeg = await tool("read_file", { path: path.join(SUB, "hello.txt"), offset: 2, limit: 2 }, lifecycle);
  check("read_file 分段读取", rdSeg.parsed && rdSeg.parsed.returned === "2-3" && rdSeg.parsed.content === "line2\nline3", rdSeg.text.slice(0, 200));

  const srchName = await tool("search", { pattern: "app" }, lifecycle);
  check("search 按文件名搜索", srchName.parsed && srchName.parsed.hits.some(h => h.path.endsWith("app.js")), srchName.text.slice(0, 200));

  const srchContent = await tool("search", { pattern: "TODO", content: true }, lifecycle);
  check("search 按内容搜索", srchContent.parsed && srchContent.parsed.hits.some(h => h.line === 3), srchContent.text.slice(0, 200));

  const srchRe = await tool("search", { pattern: "/const\\s+\\w+/", content: true }, lifecycle);
  check("search 支持正则", srchRe.parsed && srchRe.parsed.count >= 3, srchRe.text.slice(0, 200));

  const ps = await tool("permission_status", {}, lifecycle);
  check("permission_status 报告已授权", ps.parsed && ps.parsed.granted === true && ps.parsed.mode === "safe_write", ps.text.slice(0, 200));

  /* ---- 5. 写类工具 ---- */
  section("5. 写类工具（safe_write）");
  const wr = await tool("write_file", { path: path.join(SUB, "new.txt"), content: "hello\nworld\n" }, lifecycle);
  check("write_file 新建文件", wr.parsed && fs.existsSync(path.join(SUB, "new.txt")), wr.text.slice(0, 200));

  const wrAp = await tool("write_file", { path: path.join(SUB, "new.txt"), content: "again\n", mode: "append" }, lifecycle);
  check("write_file 追加", wrAp.parsed && fs.readFileSync(path.join(SUB, "new.txt"), "utf8") === "hello\nworld\nagain\n", wrAp.text.slice(0, 200));

  const wrNest = await tool("write_file", { path: path.join(SUB, "a/b/c/deep.txt"), content: "deep\n" }, lifecycle);
  check("write_file 自动创建父目录", wrNest.parsed && fs.existsSync(path.join(SUB, "a/b/c/deep.txt")), wrNest.text.slice(0, 200));

  const ed = await tool("edit_file", { path: path.join(SUB, "hello.txt"), old_string: "line3", new_string: "LINE-3" }, lifecycle);
  check("edit_file 精确替换", ed.parsed && fs.readFileSync(path.join(SUB, "hello.txt"), "utf8").includes("LINE-3"), ed.text.slice(0, 200));

  const edAmb = await tool("edit_file", { path: path.join(SUB, "hello.txt"), old_string: "line", new_string: "X" }, lifecycle);
  check("edit_file 拒绝不唯一替换", edAmb.isError === true, edAmb.text.slice(0, 200));

  const edAll = await tool("edit_file", { path: path.join(SUB, "hello.txt"), old_string: "line", new_string: "X", replace_all: true }, lifecycle);
  check("edit_file replace_all 生效", edAll.parsed && edAll.parsed.replacements >= 1, edAll.text.slice(0, 200));

  const edMiss = await tool("edit_file", { path: path.join(SUB, "hello.txt"), old_string: "NO_SUCH_STRING", new_string: "x" }, lifecycle);
  check("edit_file 未命中时报错", edMiss.isError === true, edMiss.text.slice(0, 200));

  /* ---- 6. 删除与权限模式 ---- */
  section("6. 删除与三档权限模式");
  const delInSafe = await tool("delete", { path: path.join(SUB, "new.txt") }, lifecycle);
  check("safe_write 模式拒绝删除", delInSafe.isError === true, delInSafe.text.slice(0, 200));

  const roConn = { provider: "dbxfs", connection: { id: "conn-1", name: "ro", config: { root_path: ROOT, fs_mode: "read_only" } }, runtime: {} };
  const wrInRo = await tool("write_file", { path: path.join(SUB, "ro.txt"), content: "x" }, roConn);
  check("read_only 模式拒绝写入", wrInRo.isError === true, wrInRo.text.slice(0, 200));

  const rdInRo = await tool("read_file", { path: path.join(SUB, "hello.txt") }, roConn);
  check("read_only 模式允许读取", rdInRo.parsed && !rdInRo.isError, rdInRo.text.slice(0, 200));

  const faConn = { provider: "dbxfs", connection: { id: "conn-1", name: "fa", config: { root_path: ROOT, fs_mode: "full_access" } }, runtime: {} };
  const delInFa = await tool("delete", { path: path.join(SUB, "a/b/c/deep.txt") }, faConn);
  check("full_access 模式允许删除文件", delInFa.parsed && !fs.existsSync(path.join(SUB, "a/b/c/deep.txt")), delInFa.text.slice(0, 200));

  const delDir = await tool("delete", { path: path.join(SUB, "emptydir") }, faConn);
  check("full_access 模式删除空目录", delDir.parsed && !fs.existsSync(path.join(SUB, "emptydir")), delDir.text.slice(0, 200));

  /* ---- 7. 安全约束 ---- */
  section("7. 安全约束");
  const esc1 = await tool("read_file", { path: path.join(ROOT, "..", "outside.txt") }, lifecycle);
  check("拒绝 .. 穿越", esc1.isError === true, esc1.text.slice(0, 200));

  const esc2 = await tool("read_file", { path: path.join(OUTSIDE, "outside.txt") }, lifecycle);
  check("拒绝授权目录外的绝对路径", esc2.isError === true, esc2.text.slice(0, 200));

  const esc3 = await tool("read_file", { path: path.join(SUB, "escape", "outside.txt") }, lifecycle);
  check("拒绝符号链接逃逸", esc3.isError === true, esc3.text.slice(0, 200));

  const sec1 = await tool("read_file", { path: SECRET }, lifecycle);
  check("拒绝读取 .key 敏感文件", sec1.isError === true, sec1.text.slice(0, 200));

  const sec2 = await tool("write_file", { path: SECRET, content: "hacked" }, lifecycle);
  check("拒绝写入 .key 敏感文件", sec2.isError === true, sec2.text.slice(0, 200));

  const sec3 = await tool("read_file", { path: path.join(ROOT, "dbx.db") }, lifecycle);
  check("拒绝读取 dbx.db", sec3.isError === true, sec3.text.slice(0, 200));

  const sec4 = await tool("write_file", { path: path.join(ROOT, ".env"), content: "A=1" }, lifecycle);
  check("拒绝写入 .env", sec4.isError === true, sec4.text.slice(0, 200));

  const sec5 = await tool("list_dir", { path: SUB }, lifecycle);
  check("符号链接在目录列表中标记为 symlink", sec5.parsed && sec5.parsed.entries.some(e => e.name === "escape" && e.type === "symlink"), sec5.text.slice(0, 300));

  /* ---- 8. 限额 ---- */
  section("8. 限额与截断");
  fs.writeFileSync(path.join(SUB, "big.txt"), "x".repeat(3000), "utf8");
  const smallConn = { provider: "dbxfs", connection: { id: "conn-1", config: { root_path: ROOT, fs_mode: "safe_write", max_read_bytes: 1024 } }, runtime: {} };
  const overRead2 = await tool("read_file", { path: path.join(SUB, "big.txt") }, smallConn);
  check("超过 max_read_bytes 被拒绝", overRead2.isError === true, overRead2.text.slice(0, 200));

  const overWrite = await tool("write_file", { path: path.join(SUB, "big2.txt"), content: "y".repeat(3000) }, { provider: "dbxfs", connection: { id: "conn-1", config: { root_path: ROOT, fs_mode: "safe_write", max_write_bytes: 1024 } }, runtime: {} });
  check("超过 max_write_bytes 被拒绝", overWrite.isError === true, overWrite.text.slice(0, 200));

  // 造 600 个文件验证 list 截断
  const many = path.join(ROOT, "many");
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), String(i), "utf8");
  const manyLs = await tool("list_dir", { path: many }, lifecycle);
  check("list_dir 超过 MAX_LIST 被截断到 500", manyLs.parsed && manyLs.parsed.count === 500 && manyLs.parsed.truncated === true, JSON.stringify({ count: manyLs.parsed && manyLs.parsed.count, truncated: manyLs.parsed && manyLs.parsed.truncated }));

  // 造大量命中验证 search 截断
  const hitDir = path.join(ROOT, "hits");
  fs.mkdirSync(hitDir, { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(hitDir, `h${i}.txt`), "NEEDLE here\nNEEDLE there\nNEEDLE again\nNEEDLE more\n", "utf8");
  const manyHits = await tool("search", { pattern: "NEEDLE", content: true, path: hitDir }, lifecycle);
  check("search 命中超过 200 被截断", manyHits.parsed && manyHits.parsed.count === 200 && manyHits.parsed.truncated === true, JSON.stringify({ count: manyHits.parsed && manyHits.parsed.count }));

  /* ---- 9. 未授权降级 ---- */
  section("9. 未授权降级");
  const naked = await tool("permission_status", {}, { provider: "dbxfs", connection: { id: "no-auth", config: {} }, runtime: {} });
  check("无 root_path 时 permission_status 报 granted=false", naked.parsed && naked.parsed.granted === false, naked.text.slice(0, 200));

  const nakedRead = await tool("read_file", { path: path.join(SUB, "hello.txt") }, { provider: "dbxfs", connection: { id: "no-auth", config: {} }, runtime: {} });
  check("无 root_path 时读操作被拒绝", nakedRead.isError === true, nakedRead.text.slice(0, 200));

  const unknownTool = await tool("no_such_tool", {}, lifecycle);
  check("未知工具返回 isError", unknownTool.isError === true, unknownTool.text.slice(0, 200));

  /* ---- 10. 并发 ---- */
  section("10. 并发请求关联");
  const batch = await Promise.all([
    tool("stat", { path: path.join(SUB, "hello.txt") }, lifecycle),
    tool("stat", { path: path.join(SUB, "src/app.js") }, lifecycle),
    tool("stat", { path: path.join(SUB, "src/util.js") }, lifecycle),
    tool("list_dir", { path: SUB }, lifecycle),
    tool("permission_status", {}, lifecycle),
  ]);
  const sizes = batch.map(b => b.parsed && (b.parsed.size || b.parsed.count));
  check("5 个并发请求全部正确返回", batch.every(b => b.parsed && !b.isError), JSON.stringify(sizes));
  check("并发请求 id 未错配", batch[0].parsed.size !== batch[1].parsed.size && batch[1].parsed.size !== batch[2].parsed.size, JSON.stringify(sizes));

  /* ---- 11. stdout 纪律 ---- */
  section("11. stdout 纪律");
  check("stdout 只包含协议消息", stdoutClean);
  check("stderr 有日志输出", stderrText.includes("[dbxfs]"));

  /* ---- 汇总 ---- */
  console.log(`\n${"=".repeat(60)}`);
  console.log(`结果: ${pass} PASS / ${fail} FAIL / 共 ${pass + fail} 项`);
  if (fail) { console.log("失败项:"); failures.forEach(f => console.log("  - " + f)); }
  console.log("=".repeat(60));

  child.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("验收测试异常终止:", e);
  try { child.kill(); } catch {}
  process.exit(2);
});
