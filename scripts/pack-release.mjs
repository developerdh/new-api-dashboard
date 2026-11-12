/**
 * 生成可分发安装包：把 standalone 产物组装成自包含目录并打包为 tar.gz。
 *
 * 用法：pnpm build && pnpm release:pack
 * 输出：dist/new-api-dashboard-<version>.tar.gz 与同名 .sha256
 *
 * 包内已含运行所需的全部内容（server.js / .next/static / public / node_modules），
 * 解压后填写 .env 即可 `node server.js` 启动，不依赖仓库与 pnpm。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const name = `${pkg.name}-${pkg.version}`;
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("[pack] 缺少 .next/standalone/server.js，请先执行 pnpm build");
  process.exit(1);
}

const distDir = path.join(root, "dist");
const stageDir = path.join(distDir, name);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 1) standalone 运行时（server.js + node_modules + package.json）
//    dereference：pnpm isolated 布局会在 node_modules 内生成指向 .pnpm 的符号链接，
//    在 CI 中这些链接是绝对路径（/home/runner/work/...），打进包里后在任何机器上都无法解析。
//    统一解引用为真实文件，保证包自包含、跨平台可用。
cpSync(standalone, stageDir, { recursive: true, dereference: true });
// 2) 静态资源与 public（standalone 不含，需按 Dockerfile 同样方式补齐）
cpSync(path.join(root, ".next", "static"), path.join(stageDir, ".next", "static"), {
  recursive: true,
  dereference: true,
});
cpSync(path.join(root, "public"), path.join(stageDir, "public"), {
  recursive: true,
  dereference: true,
});

/** 递归查找符号链接；发布包不允许存在。 */
function findSymlinks(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(path.relative(stageDir, full));
    } else if (entry.isDirectory()) {
      findSymlinks(full, found);
    }
  }
  return found;
}

const symlinks = findSymlinks(stageDir);
if (symlinks.length > 0) {
  console.error(`[pack] 中止：发布包内存在符号链接 ${symlinks.length} 个，例如：`);
  for (const link of symlinks.slice(0, 5)) console.error(`  ${link}`);
  process.exit(1);
}

// 3) 配置与文档
const extras = [
  ".env.example",
  "Dockerfile",
  "docker-compose.yml",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/deployment.md",
  "docs/db-schema-notes.md",
  "docs/images",
  "scripts/setup-readonly.sql",
  "scripts/seed-demo.sql",
];
for (const rel of extras) {
  const from = path.join(root, rel);
  if (!existsSync(from)) {
    console.warn(`[pack] 跳过不存在的文件：${rel}`);
    continue;
  }
  const to = path.join(stageDir, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

// 4) 剔除构建机敏感配置。
//    Next.js 的 `output: "standalone"` 会把构建时存在的 `.env` 一并复制进 standalone，
//    直接分发会把真实数据库连接串与登录凭据带出去。此处删除并断言，缺一即中止。
const isSecretEnv = (file) => file === ".env" || (file.startsWith(".env.") && file !== ".env.example");
const removed = readdirSync(stageDir).filter(isSecretEnv);
for (const file of removed) rmSync(path.join(stageDir, file), { force: true });
if (removed.length > 0) console.log(`[pack] 已剔除构建机配置：${removed.join(", ")}`);

const leftover = readdirSync(stageDir).filter(isSecretEnv);
if (leftover.length > 0) {
  console.error(`[pack] 中止：发布包内仍存在敏感配置 ${leftover.join(", ")}`);
  process.exit(1);
}
if (!existsSync(path.join(stageDir, ".env.example"))) {
  console.error("[pack] 中止：发布包缺少 .env.example");
  process.exit(1);
}

// 5) 打包：优先 tar（Windows 10+ 与 Linux/macOS 均自带 bsdtar/gnutar）
//    注意：必须以相对路径并在 distDir 内调用——Windows 盘符里的冒号会被 tar 误判为远程主机
const archive = path.join(distDir, `${name}.tar.gz`);
rmSync(archive, { force: true });
try {
  execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd: distDir, stdio: "inherit" });
} catch {
  console.error("[pack] 调用 tar 失败：请确认系统提供 tar 命令");
  process.exit(1);
}

// 6) 校验和
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);

const mb = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) => sum + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1),
    0,
  );

console.log(`[pack] 目录 ${name}  ${countFiles(stageDir)} 个文件`);
console.log(`[pack] ${archive}  ${mb(archive)}`);
console.log(`[pack] sha256 ${digest}`);
console.log(`[pack] 使用：tar -xzf ${name}.tar.gz && cd ${name} && cp .env.example .env && node server.js`);
