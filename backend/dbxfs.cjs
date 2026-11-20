#!/usr/bin/env node
/**
 * dbxfs — DBX 文件系统插件 Sidecar
 * ---------------------------------------------------------------------------
 * 实现 DBX Sidecar Protocol v1（JSON-RPC 2.0 / stdio-jsonl），
 * 为 DBX 内置 AI 助手提供「授权目录内的文件读写工具」。
 *
 * 协议方法：
 *   plugin/initialize                握手，返回协议版本 + 插件身份
 *   connection/test|connect|disconnect  连接生命周期（幂等）
 *   mcp/tools                        返回 MCP 工具 schema（DBX 传入 connectionId）
 *   mcp/call                         执行工具，返回 MCP CallToolResult
 *
 * 权限模型（"赋予权限"的唯一入口 = DBX 连接配置，不读任何环境变量）：
 *   root_path       授权根目录，多个用 ; 分隔（Windows）/ : 分隔（POSIX）
 *   fs_mode         read_only | safe_write | full_access
 *   max_read_bytes  单次读取上限
 *   max_write_bytes 单次写入上限
 *
 * 硬编码安全约束（不可通过配置绕过）：
 *   - 路径必须落在授权根之内（realpath 解析后校验，防符号链接逃逸）
 *   - 拒绝 .. 穿越、拒绝绝对路径跳出授权范围
 *   - 敏感文件（密钥/证书/凭据/dbx.db）一律拒绝，读也不允许
 *   - stdout 只输出协议消息，日志全部走 stderr / 审计文件
 *   - 请求 ID 支持并发关联，stdout 写入串行化
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

/* ------------------------------ 常量 ------------------------------ */

const PLUGIN_ID = "com.mawen.dbxfs";
const PLUGIN_VERSION = "0.1.1";
const SIDECAR_PROTOCOL_VERSION = 1;

/**
 * 后端能力声明。必须是**字符串数组**（DBX 反序列化 initialize 结果时
 * 要求 Vec<String>，返回对象会在安装时报
 * "initialize result has invalid 'capabilities': expected an array of strings"）。
 * 取值参考官方 Rust SDK（PluginMetadata::with_capability）与官方模板：
 * "connections" 表示实现了 connection/test|connect|disconnect 生命周期。
 * DBX 是否调用 mcp/tools 由 manifest 的 mcp contribution 决定，不依赖此处声明。
 */
const PLUGIN_CAPABILITIES = ["connections"];

const VALID_MODES = ["read_only", "safe_write", "full_access"];
const DEFAULT_MODE = "read_only";
const DEFAULT_MAX_READ = 512 * 1024;
const DEFAULT_MAX_WRITE = 1024 * 1024;
const MAX_ALLOWED_READ = 16 * 1024 * 1024;
const MAX_ALLOWED_WRITE = 16 * 1024 * 1024;

const MAX_LIST = 500;
const MAX_SEARCH_HITS = 200;
const DEFAULT_READ_LINES = 2000;

const DENY_FILE = [
  /\.key$/i, /\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.jks$/i, /\.keystore$/i,
  /\.dpapi$/i, /\.ppk$/i, /\.gpg$/i, /\.asc$/i,
  /credential/i, /secret/i, /passwd/i, /\.env$/i, /id_rsa/i, /id_ed25519/i,
  /^dbx\.db/i, /\.db-wal$/i, /\.db-shm$/i,
];
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "out", ".next",
  "__pycache__", ".venv", ".dbx-dev", "AppData", "$RECYCLE.BIN", "System Volume Information",
]);

/* ------------------------------ 会话管理 ------------------------------ */

/** connectionId -> 该连接的授权配置 */
const sessions = new Map();

class FsError extends Error {
  constructor(msg) { super(msg); this.name = "FsError"; }
}

function log(line) {
  process.stderr.write(`[dbxfs] ${line}\n`);
}

/** DBX 为每个插件保留的持久化目录；宿主不预创建，首次写入前自行创建 */
function dataDir() {
  const d = process.env.DBX_PLUGIN_DATA_DIR;
  if (!d) return "";
  try { fs.mkdirSync(d, { recursive: true }); return d; } catch { return ""; }
}

function auditFile() {
  const d = dataDir();
  return d ? path.join(d, "audit.jsonl") : "";
}

function audit(tool, target, ok, detail, mode) {
  const rec = { t: new Date().toISOString(), tool, target: target ?? null, ok, detail: detail ?? null, mode: mode ?? null };
  log(JSON.stringify(rec));
  const f = auditFile();
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify(rec) + "\n"); } catch { /* 审计失败不影响主流程 */ }
}

/* ------------------------------ 配置解析 ------------------------------ */

function splitRoots(raw) {
  if (Array.isArray(raw)) return raw.filter(s => typeof s === "string");
  if (typeof raw !== "string") return [];
  const sep = process.platform === "win32" ? ";" : ":";
  return raw.split(sep).map(s => s.trim()).filter(Boolean);
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

/**
 * 从载荷中提取授权配置。兼容官方规范与多种宿主版本结构：
 *   connection/test|connect|disconnect : params.{provider, connection, runtime}
 *   mcp/call                            : params.{tool, arguments, lifecycle}，
 *                                         lifecycle 与 connection/connect 载荷相同
 * 连接配置可能位于 connection.config，也可能平铺在 connection 上。
 */
function resolveConfig(params) {
  const p = params || {};
  const life = p.lifecycle && typeof p.lifecycle === "object" ? p.lifecycle : {};

  const conn = [life.connection, p.connection].find(c => c && typeof c === "object") || {};
  const cfg = [conn.config, life.config, p.config].find(c => c && typeof c === "object") || {};
  const flat = { ...conn, ...cfg, ...life, ...p };

  const rootsRaw = firstDefined(
    cfg.root_path, conn.root_path, p.root_path,
    cfg.roots, conn.roots, p.roots,
    cfg.root_paths, conn.root_paths, p.root_paths
  );
  const roots = splitRoots(rootsRaw).map(r => path.resolve(r));

  const modeRaw = String(firstDefined(cfg.fs_mode, conn.fs_mode, p.fs_mode, cfg.mode, conn.mode, p.mode, DEFAULT_MODE)).toLowerCase();
  if (!VALID_MODES.includes(modeRaw)) {
    throw new FsError(`fs_mode 非法: ${modeRaw}，可选 ${VALID_MODES.join(" / ")}`);
  }

  const maxRead = clampInt(
    firstDefined(cfg.max_read_bytes, conn.max_read_bytes, p.max_read_bytes, DEFAULT_MAX_READ),
    1024, MAX_ALLOWED_READ, DEFAULT_MAX_READ
  );
  const maxWrite = clampInt(
    firstDefined(cfg.max_write_bytes, conn.max_write_bytes, p.max_write_bytes, DEFAULT_MAX_WRITE),
    1024, MAX_ALLOWED_WRITE, DEFAULT_MAX_WRITE
  );

  const connectionId = firstDefined(conn.id, life.connectionId, p.connectionId, p.connection_id, "") || "";
  const name = firstDefined(conn.name, p.name, "") || "";

  return { connectionId, name, roots, mode: modeRaw, maxRead, maxWrite };
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * 取得某个连接生效的配置。
 * 优先级：连接载荷 > connect 时缓存 > 未授权占位。
 * 注意：载荷永远优先于缓存，避免连接配置改窄后仍沿用旧的宽权限。
 */
function sessionFor(params) {
  const cfg = resolveConfig(params);
  if (cfg.roots.length > 0) return cfg;
  const id = cfg.connectionId;
  if (id && sessions.has(id)) {
    const c = sessions.get(id);
    return { ...cfg, name: cfg.name || c.name, roots: c.roots, mode: c.mode, maxRead: c.maxRead, maxWrite: c.maxWrite };
  }
  return cfg;
}

/* ------------------------------ 路径与权限 ------------------------------ */

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
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function norm(p) { return process.platform === "win32" ? p.toLowerCase() : p; }

function inRoots(realPath, roots) {
  const target = norm(realPath);
  return roots.some(root => {
    const rel = path.relative(norm(root), target);
    return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  });
}

/** 权限总闸：任何文件操作前必须调用 */
function guard(cfg, p, need) {
  if (!cfg.roots || cfg.roots.length === 0) {
    throw new FsError("未授权：该连接没有配置 root_path，本插件未获得任何目录权限。请在连接配置中填写授权根目录。");
  }
  const rp = abs(p);
  const real = realpathSecure(rp);
  if (!inRoots(real, cfg.roots)) {
    throw new FsError(`拒绝访问：${rp} 不在授权目录内（授权根：${cfg.roots.join(", ")}）`);
  }
  const base = path.basename(real);
  const denied = DENY_FILE.find(re => re.test(real) || re.test(base));
  if (denied) {
    throw new FsError(`拒绝访问：${base} 是敏感文件（${denied}），禁止读取和写入`);
  }
  if (need === "write" && cfg.mode === "read_only") {
    throw new FsError("权限不足：当前连接模式为 read_only，未赋予写权限。请在连接配置中把 fs_mode 改为 safe_write。");
  }
  if (need === "delete" && cfg.mode !== "full_access") {
    throw new FsError(`权限不足：删除/移动需要 full_access 模式，当前连接为 ${cfg.mode}。`);
  }
  return real;
}

/* ------------------------------ 工具定义 ------------------------------ */

const TOOLS = {
  list_dir: {
    access: "read",
    description: "列出授权目录下一级的内容。返回名称、类型、大小、修改时间。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "目录绝对路径，必须在授权根目录内" } },
      required: ["path"],
    },
    async run(cfg, a) {
      const real = guard(cfg, a.path, "none");
      const st = fs.statSync(real);
      if (!st.isDirectory()) throw new FsError(`${real} 不是目录`);
      const entries = fs.readdirSync(real, { withFileTypes: true }).slice(0, MAX_LIST).map(d => {
        let size = null, mtime = null;
        try { const s = fs.statSync(path.join(real, d.name)); size = s.size; mtime = s.mtime.toISOString(); } catch {}
        return { name: d.name, type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file", size, mtime };
      });
      return { path: real, count: entries.length, truncated: entries.length >= MAX_LIST, entries };
    },
  },

  stat: {
    access: "read",
    description: "获取文件或目录的元信息（大小、修改时间、创建时间、类型）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async run(cfg, a) {
      const real = guard(cfg, a.path, "none");
      const s = fs.statSync(real);
      return {
        path: real, type: s.isDirectory() ? "dir" : "file",
        size: s.size, mtime: s.mtime.toISOString(), ctime: s.ctime.toISOString(),
      };
    },
  },

  read_file: {
    access: "read",
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
    async run(cfg, a) {
      const real = guard(cfg, a.path, "none");
      const s = fs.statSync(real);
      if (!s.isFile()) throw new FsError(`${real} 不是文件`);
      if (s.size > cfg.maxRead) {
        throw new FsError(`文件 ${s.size} 字节超过单次读取上限 ${cfg.maxRead}，请用 offset/limit 分段或用 search 定位`);
      }
      const text = fs.readFileSync(real, "utf8");
      if (text.includes("\u0000")) throw new FsError("该文件看起来是二进制文件，拒绝以文本返回");
      const lines = text.split(/\r?\n/);
      // 末尾换行会产生一个空元素，不计入行数
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const start = Math.max(1, Number(a.offset) || 1);
      const limit = Number(a.limit) || DEFAULT_READ_LINES;
      const end = Math.min(lines.length, start - 1 + limit);
      return {
        path: real, total_lines: lines.length, returned: `${start}-${end}`,
        truncated: end < lines.length,
        content: lines.slice(start - 1, end).join("\n"),
      };
    },
  },

  search: {
    access: "read",
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
    async run(cfg, a) {
      const start = guard(cfg, a.path || cfg.roots[0], "none");
      let re;
      const m = /^\/(.*)\/([a-z]*)$/.exec(a.pattern);
      try { re = m ? new RegExp(m[1], m[2]) : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
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
          if (!a.content) {
            if (re.test(d.name)) hits.push({ type: "name", path: full });
            continue;
          }
          try {
            const s = fs.statSync(full);
            if (!s.isFile() || s.size > cfg.maxRead) continue;
            const text = fs.readFileSync(full, "utf8");
            if (text.includes("\u0000")) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
              if (re.test(lines[i])) hits.push({ type: "content", path: full, line: i + 1, text: lines[i].slice(0, 300) });
            }
          } catch {}
        }
      }
      return { pattern: a.pattern, searched_from: start, truncated: hits.length >= MAX_SEARCH_HITS, count: hits.length, hits };
    },
  },

  write_file: {
    access: "write",
    description: "写入授权目录内的文件（覆盖或追加）。需要连接模式为 safe_write 及以上。",
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
    async run(cfg, a) {
      const real = guard(cfg, a.path, "write");
      if (typeof a.content !== "string") throw new FsError("content 必须是字符串");
      const bytes = Buffer.byteLength(a.content, "utf8");
      if (bytes > cfg.maxWrite) throw new FsError(`内容 ${bytes} 字节超过单次写入上限 ${cfg.maxWrite}`);
      const parent = path.dirname(real);
      if (!fs.existsSync(parent)) {
        if (a.create_parents === false) throw new FsError(`父目录不存在: ${parent}`);
        fs.mkdirSync(parent, { recursive: true });
      }
      if (fs.existsSync(real) && !fs.statSync(real).isFile()) throw new FsError(`${real} 已存在且不是文件`);
      const existed = fs.existsSync(real);
      fs.writeFileSync(real, a.content, { flag: a.mode === "append" ? "a" : "w" });
      return { path: real, bytes, mode: a.mode || "overwrite", overwritten: existed && a.mode !== "append", appended: a.mode === "append" };
    },
  },

  edit_file: {
    access: "write",
    description: "对授权目录内文件做精确字符串替换（比整文件覆盖安全）。old_string 必须唯一，除非 replace_all=true。需要 safe_write 及以上模式。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "默认 false" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(cfg, a) {
      const real = guard(cfg, a.path, "write");
      if (!a.old_string) throw new FsError("old_string 不能为空");
      const text = fs.readFileSync(real, "utf8");
      const count = text.split(a.old_string).length - 1;
      if (count === 0) throw new FsError("未找到 old_string，未做任何修改");
      if (count > 1 && !a.replace_all) {
        throw new FsError(`old_string 出现 ${count} 次，不唯一。请提供更多上下文或设 replace_all=true`);
      }
      const next = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, a.new_string);
      if (Buffer.byteLength(next, "utf8") > cfg.maxWrite) throw new FsError(`修改后超过单次写入上限 ${cfg.maxWrite}`);
      fs.writeFileSync(real, next, "utf8");
      return {
        path: real, replacements: a.replace_all ? count : 1,
        bytes_before: Buffer.byteLength(text, "utf8"), bytes_after: Buffer.byteLength(next, "utf8"),
      };
    },
  },

  delete: {
    access: "full",
    description: "删除授权目录内的文件或目录。需要连接模式为 full_access。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "删除目录及其全部内容，默认 false" },
      },
      required: ["path"],
    },
    async run(cfg, a) {
      const real = guard(cfg, a.path, "delete");
      if (!fs.existsSync(real)) throw new FsError(`不存在: ${real}`);
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        if (!a.recursive) { fs.rmdirSync(real); return { path: real, deleted: "empty-dir" }; }
        fs.rmSync(real, { recursive: true, force: true });
        return { path: real, deleted: "dir-recursive" };
      }
      fs.rmSync(real, { force: true });
      return { path: real, deleted: "file" };
    },
  },

  permission_status: {
    access: "read",
    description: "查询当前连接的授权状态：授权根目录、模式、可用的读写删能力。调用任何文件工具前可先看这个。",
    inputSchema: { type: "object", properties: {} },
    async run(cfg) {
      const granted = cfg.roots.length > 0;
      return {
        granted,
        roots: cfg.roots,
        mode: cfg.mode,
        capabilities: { read: true, write: cfg.mode !== "read_only", delete: cfg.mode === "full_access" },
        limits: { max_read_bytes: cfg.maxRead, max_write_bytes: cfg.maxWrite, max_search_hits: MAX_SEARCH_HITS },
        note: granted ? "已授权，操作仅限上述根目录之内" : "未授予任何目录，所有文件操作都会被拒绝",
      };
    },
  },
};

/* ------------------------------ JSON-RPC 传输 ------------------------------ */

/** stdout 写队列：保证多条协议消息不交叉写坏 */
let writeChain = Promise.resolve();
function send(obj) {
  writeChain = writeChain.then(() => new Promise(resolve => {
    process.stdout.write(JSON.stringify(obj) + "\n", () => resolve());
  }));
  return writeChain;
}

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function fail(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function textResult(text, isError) {
  return { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }], isError: !!isError };
}

/* ------------------------------ 方法实现 ------------------------------ */

function onInitialize(params) {
  const host = params && params.host ? params.host : {};
  const offered = Array.isArray(host.protocolVersions) ? host.protocolVersions : [1];
  if (!offered.includes(SIDECAR_PROTOCOL_VERSION)) {
    throw { code: -32602, message: `Sidecar 协议版本不匹配：宿主提供 ${JSON.stringify(offered)}，本端仅支持 ${SIDECAR_PROTOCOL_VERSION}` };
  }
  return {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    capabilities: PLUGIN_CAPABILITIES,
    plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
  };
}

function onConnectionTest(params) {
  const cfg = resolveConfig(params);
  if (cfg.roots.length === 0) {
    return { success: false, message: "未配置 root_path：请填写至少一个授权根目录" };
  }
  const bad = [];
  for (const r of cfg.roots) {
    try {
      const st = fs.statSync(r);
      if (!st.isDirectory()) bad.push(`${r} 不是目录`);
    } catch { bad.push(`${r} 不存在或不可访问`); }
  }
  if (bad.length) return { success: false, message: `授权目录校验失败：${bad.join("；")}` };
  return { success: true, message: `授权目录可用（${cfg.roots.length} 个），模式 ${cfg.mode}` };
}

function onConnectionConnect(params) {
  const cfg = resolveConfig(params);
  const id = cfg.connectionId || `anon-${process.pid}`;
  sessions.set(id, {
    connectionId: id, name: cfg.name, roots: cfg.roots,
    mode: cfg.mode, maxRead: cfg.maxRead, maxWrite: cfg.maxWrite,
  });
  log(`connected ${id} roots=${JSON.stringify(cfg.roots)} mode=${cfg.mode}`);
  return { success: true, message: `已授权 ${cfg.roots.length} 个目录（模式 ${cfg.mode}）` };
}

function onConnectionDisconnect(params) {
  const cfg = resolveConfig(params);
  const id = cfg.connectionId;
  if (id && sessions.has(id)) {
    sessions.delete(id);
    log(`disconnected ${id}`);
  }
  return { success: true, message: "已断开（幂等）" };
}

function onMcpTools(params) {
  const tools = Object.entries(TOOLS).map(([name, t]) => {
    const entry = {
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    };
    // 只读工具加标注，宿主才会免确认直接执行
    if (t.access === "read") entry.annotations = { readOnlyHint: true, destructiveHint: false };
    return entry;
  });
  return { tools };
}

async function onMcpCall(params) {
  const name = params && params.tool;
  const args = (params && params.arguments) || {};
  const t = TOOLS[name];
  if (!t) return textResult(`未知工具: ${name}。可用工具：${Object.keys(TOOLS).join(", ")}`, true);

  const cfg = sessionFor(params);
  const started = Date.now();
  try {
    const result = await t.run(cfg, args);
    audit(name, args.path ?? args.pattern ?? null, true, { ms: Date.now() - started }, cfg.mode);
    return textResult(result, false);
  } catch (e) {
    const msg = e instanceof FsError ? e.message : `${e.name || "Error"}: ${e.message}`;
    audit(name, args.path ?? null, false, msg, cfg.mode);
    return textResult(msg, true);
  }
}

/* ------------------------------ 分发 ------------------------------ */

async function dispatch(msg) {
  const { id, method, params } = msg;

  // 通知（无 id）不应答
  if (id === undefined || id === null) {
    if (method === "exit") process.exit(0);
    return null;
  }

  try {
    switch (method) {
      case "plugin/initialize": return reply(id, onInitialize(params));
      case "ping": return reply(id, {});
      case "connection/test": return reply(id, onConnectionTest(params));
      case "connection/connect": return reply(id, onConnectionConnect(params));
      case "connection/disconnect": return reply(id, onConnectionDisconnect(params));
      case "mcp/tools": return reply(id, onMcpTools(params));
      case "mcp/call": return reply(id, await onMcpCall(params));
      default:
        return fail(id, -32601, `不支持的方法: ${method}`);
    }
  } catch (e) {
    if (e && typeof e === "object" && typeof e.code === "number" && typeof e.message === "string") {
      return fail(id, e.code, e.message);
    }
    log(`handler error on ${method}: ${e && e.stack ? e.stack : e}`);
    return fail(id, -32603, `内部错误: ${e && e.message ? e.message : String(e)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch { log("收到无法解析的行，已忽略"); return; }

  const batch = Array.isArray(msg) ? msg : [msg];
  for (const one of batch) {
    if (!one || typeof one !== "object" || typeof one.method !== "string") {
      if (one && one.id !== undefined) send(fail(one.id, -32600, "无效的请求对象"));
      continue;
    }
    dispatch(one).then(res => { if (res) send(res); }).catch(e => {
      log(`dispatch crash: ${e && e.stack ? e.stack : e}`);
      if (one.id !== undefined) send(fail(one.id, -32603, "内部错误"));
    });
  }
});

// stdin 关闭（宿主退出）时干净退出，避免成为孤儿进程
rl.on("close", () => { log("stdin closed, exiting"); process.exit(0); });

process.on("uncaughtException", (e) => { log(`uncaughtException: ${e && e.stack ? e.stack : e}`); });
process.on("unhandledRejection", (e) => { log(`unhandledRejection: ${e && e.stack ? e.stack : e}`); });

log(`sidecar ready pid=${process.pid} plugin=${PLUGIN_ID}@${PLUGIN_VERSION} protocol=${SIDECAR_PROTOCOL_VERSION}`);
