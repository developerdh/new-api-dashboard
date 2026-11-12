/**
 * 生成 Release 说明：固定区块（下载安装 / 兼容性 / 文档）+ CHANGELOG 中该版本的变更段落。
 *
 * 用法：node scripts/release-notes.mjs [--out dist/RELEASE_NOTES.md]
 * CI 中由 release 工作流调用，输出路径通过 `body_path` 交给 GitHub Release。
 *
 * 设计取舍：CHANGELOG 是变更内容的唯一事实来源，避免发布页与仓库文档两处维护；
 * 固定的安装与兼容性说明由本脚本拼装，保证每个版本页面对使用者都完整。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const archive = `${pkg.name}-${version}`;
const repo = process.env.GITHUB_REPOSITORY ?? "developerdh/new-api-dashboard";
const site = `https://github.com/${repo}`;

const outArgIndex = process.argv.indexOf("--out");
const outPath = path.resolve(
  root,
  outArgIndex === -1 ? path.join("dist", "RELEASE_NOTES.md") : process.argv[outArgIndex + 1],
);

/** 从 CHANGELOG 抽取 `## [version]` 起的段落（到下一个二级标题为止）。 */
function extractChangelog(changelog, target) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("## ") && line.includes(target));
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

const changelogPath = path.join(root, "CHANGELOG.md");
if (!existsSync(changelogPath)) {
  console.error("[notes] 缺少 CHANGELOG.md");
  process.exit(1);
}
const section = extractChangelog(readFileSync(changelogPath, "utf8"), version);
if (section === null || section === "") {
  console.error(`[notes] CHANGELOG.md 中未找到版本 ${version} 的段落（需形如 "## [${version}] - YYYY-MM-DD"）`);
  process.exit(1);
}

const notes = `New API 用户使用量统计看板。独立部署的 TypeScript 全栈应用，只读直连 PostgreSQL，服务端完成 SQL 聚合。

## 下载安装

运行环境：Node.js ≥ 22（或使用仓库内的 Dockerfile 自行构建镜像）。

\`\`\`bash
sha256sum -c ${archive}.tar.gz.sha256
tar -xzf ${archive}.tar.gz
cd ${archive}
cp .env.example .env      # 填写 DATABASE_URL 与登录凭据
node server.js            # http://localhost:3088
\`\`\`

## 本次变更

${section}

## 兼容性

需要 New API 的 \`users\` / \`logs\` / \`quota_data\` 三表。启动后访问 \`GET /api/health\` 会做 schema 自检，缺列时返回 503 并列出具体缺失的「表.列」，便于判断版本是否匹配。

数据库账号必须只读，授权脚本见 \`scripts/setup-readonly.sql\`（由 DBA 在目标库执行）。

## 文档

- [README](${site}#readme)
- [构建与部署](${site}/blob/main/docs/deployment.md)
- [安全策略](${site}/blob/main/SECURITY.md)
- [更新日志](${site}/blob/main/CHANGELOG.md)

---

本项目为非官方第三方看板，与 New API 官方无关联。以 [MIT](${site}/blob/main/LICENSE) 许可发布。
`;

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, notes);
console.log(`[notes] ${path.relative(root, outPath)}（版本 ${version}，${notes.length} 字符）`);
