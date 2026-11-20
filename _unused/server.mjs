#!/usr/bin/env node
/**
 * dbx-fs — DBX 文件系统 MCP 插件
 * ---------------------------------------------------------------------------
 * 给 DBX（或任何 MCP agent）赋予「授权目录内的文件读写能力」。
 * 零第三方依赖，Node 18+，stdio transport。
 *
 * 权限模型（"赋予权限"的唯一入口，全部通过环境变量）：
 *   DBX_FS_ROOTS   授权根目录，多个用 ; 分隔（Windows）/ : 分隔（POSIX）。
 *                  为空 = 未授权，所有工具一律拒绝。
 *   DBX_FS_MODE    read_only（默认）| safe_write | full_access
 *                    read_only    只能 list / read / search / stat
 *                    safe_write   + write / edit（禁止删除、移动）
 *                    full_access  + delete / move / rename
 *   DBX_FS_MAX_READ_BYTES    单次读取上限，默认 512 KB
 *   DBX_FS_MAX_WRITE_BYTES   单次写入上限，默认 1 MB
 *   DBX_FS_LOG               审计日志路径（JSONL），默认写到第一个授权根目录下
 *   DBX_FS_AUDIT             设为 0 关闭审计
 *
 * 安全约束（硬编码，不可通过配置绕过）：
 *   - 路径必须在授权根目录之内（realpath 解析后校验，防符号链接逃逸）
 *   - 拒绝 .. 穿越、拒绝绝对路径跳出授权范围
 *   - 敏感文件（密钥/证书/凭据/dbx.db）一律只读或拒绝
 *   - stdout 只走 MCP 协议，日志全部走 stderr / 审计文件
 * ---------------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const SERVER_INFO = { name: "dbx-fs", version: "1.0.0" };

const DENY_FILE = [/\.key$/i, /\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.dpapi$/i, /credential/i, /secret/i, /passwd/i, /^dbx\.db/i, /\.wal$/i, /\.dpapi$/i];
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "out", ".next", "__pycache__", ".venv", "AppData"]);
const MAX_LIST = 500;
const MAX_SEARCH_HITS = 200;

/* ------------------------------ 配置 ------------------------------ */
function loadConfig() {
  const raw = process.env.DBX_FS_ROOTS || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const roots = raw.split(sep).map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
  const mode = (process.env.DBX_FS_MODE || "read_only").toLowerCase();
  if (!["read_only", "safe_write", "full_access"].includes(mode)) {
    throw new Error(`DBX_FS_MODE 非法: ${mode}，可选 read_only / safe_write / full_access`);
  }
  return {
    roots,
    mode,
    maxRead: Number(process.env.DBX_FS_MAX_READ_BYTES || 512 * 1024),
    maxWrite: Number(process.env.DBX_FS_MAX_WRITE_BYTES || 1024 * 1024),
    logFile: process.env.DBX_FS_LOG || (roots[0] ? path.join(roots[0], ".dbx-fs-audit.jsonl") : ""),
    audit: process.env.DBX_FS_AUDIT !== "0",
  };
}
const CFG = loadConfig();

/* ------------------------------ 工具函数 ------------------------------ */
class FsError extends Error {
  constructor(msg) { super(msg); this.name = "FsError"; }
}

/** 把用户输入解析成绝对路径；不存在的路径用于写场景，不在此处报错 */
function abs(p) {
  if (typeof p !== "string" || !p.trim()) throw new FsError("path 不能为空");
  return path.resolve(p.trim());
}

/** realpath 解析（防符号链接逃逸）；不存在则解析最深的存在的父目录 */
function realpathSecure(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // 到根了
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 是否在授权根目录内 */
function inRoots(realPath) {
  return CFG.roots.some(root => {
    const rel = path.relative(root, realPath);
    return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  });
}

/** 权限总闸：任何文件操作前必须调用 */
function guard(p, need) {
  if (CFG.roots.length === 0) {
    throw new FsError("未授权：DBX_FS_ROOTS 为空，本插件未获得任何目录权限。请在 MCP 配置的 env 中设置 DBX_FS_ROOTS。");
  }
  const rp = abs(p);
  const real = realpathSecure(rp);
  if (!inRoots(real)) {
    throw new FsError(`拒绝访问：${rp} 不在授权目录内（授权根：${CFG.roots.join(", ")}）`);
  }
  const base = path.basename(real);
  const denied = DENY_FILE.find(re => re.test(real) || re.test(base));
  if (denied) {
    if (need !== "none") throw new FsError(`拒绝访问：${base} 是敏感文件（${denied}），禁止读写`);
    // read 场景也直接拒绝，避免密钥外泄
    throw new FsError(`拒绝访问：${base} 是敏感文件（${denied}），禁止读取`);
  }
  if (need === "write" && CFG.mode === "read_only") {
    throw new FsError(`权限不足：当前模式为 read_only，未赋予写权限。将 DBX_FS_MODE 设为 safe_write 后重启 agent。`);
  }
  if (need === "delete" && CFG.mode !== "full_access") {
    throw new FsError(`权限不足：删除/移动需要 full_access 模式，当前为 ${CFG.mode}。`);
  }
  return real;
}

function audit(tool, p, ok, detail) {
  if (!CFG.audit) return;
  const line = JSON.stringify({ t: new Date().toISOString(), tool, path: p ?? null, ok, detail: detail ?? null, mode: CFG.mode }) + "\n";
  process.stderr.write(`[dbx-fs] ${line}`);
  if (CFG.logFile) {
    try { fs.appendFileSync(CFG.logFile, line); } catch { /* 日志失败不影响主流程 */ }
  }
}

function okText(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

/* ------------------------------ 工具实现 ------------------------------ */
const tools = {
  fs_list_dir: {
    description: "列出授权目录下的内容（一级）。返回名称、类型、大小、修改时间。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "目录绝对路径，必须在授权根目录内" } },
      required: ["path"],
    },
    async run({ path: p }) {
      const real = guard(p, "none");
      const st = fs.statSync(real);
      if (!st.isDirectory()) throw new FsError(`${real} 不是目录`);
      const entries = fs.readdirSync(real, { withFileTypes: true }).slice(0, MAX_LIST).map(d => {
        let size = null, mtime = null;
        try { const s = fs.statSync(path.join(real, d.name)); size = s.size; mtime = s.mtime.toISOString(); } catch {}
        return { name: d.name, type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file", size, mtime };
      });
      return { path: real, count: entries.length, entries };
    },
  },

  fs_stat: {
    description: "获取文件或目录的元信息（大小、时间、类型）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async run({ path: p }) {
      const real = guard(p, "none");
      const s = fs.statSync(real);
      return { path: real, type: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString(), ctime: s.ctime.toISOString() };
    },
  },

  fs_read_file: {
    description: "读取授权目录内的文本文件。默认最多返回 2000 行，超出需用 offset/limit 分段。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "起始行，从 1 开始，默认 1" },
        limit: { type: "number", description: "读取行数，默认 2000" },
      },
      required: ["path"],
    },
    async run({ path: p, offset = 1, limit = 2000 }) {
      const real = guard(p, "none");
      const s = fs.statSync(real);
      if (!s.isFile()) throw new FsError(`${real} 不是文件`);
      if (s.size > CFG.maxRead) throw new FsError(`文件 ${s.size} 字节超过单次读取上限 ${CFG.maxRead}，请用 offset/limit 分段或用 fs_search 定位`);
      const text = fs.readFileSync(real, "utf8");
      if (text.includes("\u0000")) throw new FsError("该文件看起来是二进制文件，拒绝以文本返回");
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Number(offset) || 1);
      const end = Math.min(lines.length, start - 1 + (Number(limit) || 2000));
      return {
        path: real, total_lines: lines.length, returned: `${start}-${end}`,
        content: lines.slice(start - 1, end).join("\n"),
      };
    },
  },

  fs_search: {
    description: "在授权目录内递归搜索：按文件名或文件内容匹配。跳过 node_modules/.git 等目录。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜索的子串或正则（/re/flags 形式）" },
        path: { type: "string", description: "搜索起点，默认为第一个授权根目录" },
        content: { type: "boolean", description: "true=搜文件内容，false(默认)=搜文件名" },
      },
      required: ["pattern"],
    },
    async run({ pattern, path: p, content = false }) {
      const start = guard(p || CFG.roots[0], "none");
      let re;
      const m = /^\/(.*)\/([a-z]*)$/.exec(pattern);
      try { re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
      catch (e) { throw new FsError(`正则无效: ${e.message}`); }
      const hits = [];
      const stack = [start];
      while (stack.length && hits.length < MAX_SEARCH_HITS) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of entries) {
          if (hits.length >= MAX_SEARCH_HITS) break;
          const full = path.join(cur, d.name);
          if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(full); continue; }
          if (!content) {
            if (re.test(d.name)) hits.push({ type: "name", path: full });
            continue;
          }
          try {
            const s = fs.statSync(full);
            if (!s.isFile() || s.size > CFG.maxRead) continue;
            const text = fs.readFileSync(full, "utf8");
            if (text.includes("\u0000")) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
              if (re.test(lines[i])) hits.push({ type: "content", path: full, line: i + 1, text: lines[i].slice(0, 300) });
            }
          } catch {}
        }
      }
      return { pattern, searched_from: start, truncated: hits.length >= MAX_SEARCH_HITS, count: hits.length, hits };
    },
  },

  fs_write_file: {
    description: "写入授权目录内的文件（覆盖或追加）。需要 safe_write 及以上模式。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"], description: "默认 overwrite" },
        create_parents: { type: "boolean", description: "父目录不存在时是否创建，默认 true" },
      },
      required: ["path", "content"],
    },
    async run({ path: p, content, mode = "overwrite", create_parents = true }) {
      const real = guard(p, "write");
      if (typeof content !== "string") throw new FsError("content 必须是字符串");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > CFG.maxWrite) throw new FsError(`内容 ${bytes} 字节超过单次写入上限 ${CFG.maxWrite}`);
      const parent = path.dirname(real);
      if (!fs.existsSync(parent)) {
        if (!create_parents) throw new FsError(`父目录不存在: ${parent}`);
        fs.mkdirSync(parent, { recursive: true });
      }
      if (fs.existsSync(real) && !fs.statSync(real).isFile()) throw new FsError(`${real} 已存在且不是文件`);
      const existed = fs.existsSync(real);
      fs.writeFileSync(real, content, { flag: mode === "append" ? "a" : "w" });
      return { path: real, bytes, mode, overwritten: existed && mode === "overwrite", appended: mode === "append" };
    },
  },

  fs_edit_file: {
    description: "对授权目录内文件做精确字符串替换（比整文件覆盖安全）。old_string 必须唯一，除非 replace_all=true。需要 safe_write 及以上模式。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", default: false },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run({ path: p, old_string, new_string, replace_all = false }) {
      const real = guard(p, "write");
      if (!old_string) throw new FsError("old_string 不能为空");
      const text = fs.readFileSync(real, "utf8");
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new FsError("未找到 old_string，未做任何修改");
      if (count > 1 && !replace_all) throw new FsError(`old_string 出现 ${count} 次，不唯一。请提供更多上下文或设 replace_all=true`);
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      if (Buffer.byteLength(next, "utf8") > CFG.maxWrite) throw new FsError(`修改后超过单次写入上限 ${CFG.maxWrite}`);
      fs.writeFileSync(real, next, "utf8");
      return { path: real, replacements: replace_all ? count : 1, bytes_before: Buffer.byteLength(text, "utf8"), bytes_after: Buffer.byteLength(next, "utf8") };
    },
  },

  fs_delete: {
    description: "删除授权目录内的文件或空目录。需要 full_access 模式。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean", default: false, description: "删除目录及其内容" } },
      required: ["path"],
    },
    async run({ path: p, recursive = false }) {
      const real = guard(p, "delete");
      if (!fs.existsSync(real)) throw new FsError(`不存在: ${real}`);
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        if (!recursive) { fs.rmdirSync(real); return { path: real, deleted: "empty-dir" }; }
        fs.rmSync(real, { recursive: true, force: true });
        return { path: real, deleted: "dir-recursive" };
      }
      fs.rmSync(real, { force: true });
      return { path: real, deleted: "file" };
    },
  },

  fs_permission_status: {
    description: "查询本插件当前的授权状态：授权根目录、模式、可用的写/删能力。调用任何文件工具前可先看这个。",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        granted: CFG.roots.length > 0,
        roots: CFG.roots,
        mode: CFG.mode,
        capabilities: {
          read: true,
          write: CFG.mode !== "read_only",
          delete: CFG.mode === "full_access",
        },
        limits: { max_read_bytes: CFG.maxRead, max_write_bytes: CFG.maxWrite, max_search_hits: MAX_SEARCH_HITS },
        note: CFG.roots.length === 0 ? "未授予任何目录，所有文件操作都会被拒绝" : "已授权，操作仅限上述根目录之内",
      };
    },
  },
};

/* ------------------------------ MCP 协议 ------------------------------ */
function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
    return reply({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "文件系统插件。所有路径必须在 DBX_FS_ROOTS 授权的目录内；写操作需要 safe_write，删除需要 full_access。",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    return reply({
      tools: Object.entries(tools).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const t = tools[name];
    if (!t) return reply({ content: [{ type: "text", text: `未知工具: ${name}` }], isError: true });
    return (async () => {
      const started = Date.now();
      try {
        const result = await t.run(args);
        audit(name, args.path ?? args.pattern ?? null, true, { ms: Date.now() - started });
        return reply(okText(result));
      } catch (e) {
        const msg = e instanceof FsError ? e.message : `${e.name}: ${e.message}`;
        audit(name, args.path ?? null, false, msg);
        return reply({ content: [{ type: "text", text: msg }], isError: true });
      }
    })();
  }
  if (method && method.startsWith("notifications/")) return null; // 无需应答
  if (id !== undefined) return fail(-32601, `不支持的方法: ${method}`);
  return null;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const pending = new Map();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (Array.isArray(msg)) {
    const out = msg.map(handle).filter(Boolean);
    if (out.length) process.stdout.write(out.map(m => JSON.stringify(m)).join("\n") + "\n");
    return;
  }
  const res = handle(msg);
  if (res && typeof res.then === "function") {
    res.then(r => { if (r) process.stdout.write(JSON.stringify(r) + "\n"); });
  } else if (res) {
    process.stdout.write(JSON.stringify(res) + "\n");
  }
});
process.stderr.write(`[dbx-fs] ${SERVER_INFO.name} v${SERVER_INFO.version} 启动 mode=${CFG.mode} roots=${CFG.roots.length ? CFG.roots.join(", ") : "(未授权)"}\n`);
