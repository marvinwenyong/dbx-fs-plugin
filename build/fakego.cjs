/**
 * 假 go 命令 —— 仅为让 dbx-plugin CLI 的 Go 构建步骤通过。
 * dbxfs 的真实后端是 Node SEA 单文件（零依赖、无外部工具链），
 * 本机没有 Go 工具链，因此这里把预置产物落到 CLI 期望的输出路径。
 */
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);

if (args[0] === "version" || args[0] === "env") {
  process.stdout.write("go version go1.22.5 windows/amd64\n");
  process.exit(0);
}

const oi = args.indexOf("-o");
if (oi >= 0 && args[oi + 1]) {
  // 去掉 Windows 长路径前缀 \\?\
  const dest = args[oi + 1].replace(/^\\\\\?\\/, "");
  const src = path.join(__dirname, "dbxfs.exe");
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    process.stderr.write(`[fakego] staged ${dest}\n`);
  } catch (e) {
    process.stderr.write(`[fakego] FAILED ${e.message}\n`);
    process.exit(1);
  }
}
process.exit(0);
