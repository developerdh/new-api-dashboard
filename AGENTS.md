# AGENTS.md — 仓库规范

New API 用户使用量统计看板：Next.js（App Router）+ TypeScript 全栈，只读直连 PostgreSQL，服务端完成 SQL 聚合，前端负责可视化与导出。

## 文档职责

| 文档 | 职责 |
|---|---|
| `docs/方案.md` | 技术方案，唯一权威设计 |
| `docs/db-schema-notes.md` | 数据库实测结构，schema 口径依据 |
| `docs/deployment.md` | 构建、打包、部署与回滚 |
| `docs/troubleshooting.md` | 常见问题排查（按现象索引，含反代与登录问题） |
| `docs/nginx.example.conf` | 反向代理参考配置（`Host` 必须 `$http_host`） |
| `docs/audit-proxy/` | 提示词与响应采集（audit-proxy）的背景、设计、部署与决策 |
| `SECURITY.md` | 漏洞报告渠道与部署安全前提 |
| `CONTRIBUTING.md` | 开发环境、提交规范、代码红线与 PR 流程 |
| `CHANGELOG.md` | 版本变更记录（发版时更新） |
| `README.md` | 安装、配置与部署说明 |

## 环境与命令

- Node.js ≥ 22（`package.json` 的 `engines` 声明），pnpm 10.34.5（`packageManager` 固定）；提交携带 `pnpm-lock.yaml`。
- 开发地址 `http://localhost:3088`，`/` 跳转 `/dashboard`。
- `.npmrc` 不入库：Windows 下 Turbopack 需要 `node-linker=hoisted`，属本地环境差异，由开发者自行设置（见 README 常见问题）。

| 命令 | 用途 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 开发服务器（3088） |
| `pnpm build` | 生产构建（先清空 `.next`，产物为 standalone） |
| `pnpm clean` | 清空 `.next` |
| `pnpm start` | 运行生产构建（3088） |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest，单测位于 `src/**/*.test.ts` |
| `pnpm release:pack` | 生成 tar.gz 发布包（需先 `pnpm build`） |

- 构建期不得依赖联网资源（如 `next/font/google`），字体使用 `src/app/globals.css` 的系统字体栈。
- 环境变量写入 `.env`（不提交），见 `.env.example`；必填 `DATABASE_URL`（只读账号）。

## Git 约定

- 单一主分支 `main`，小步提交；提交由维护者发起。
- 提交信息格式：`<type>(<scope>): <subject>`；type ∈ `feat` `fix` `docs` `refactor` `chore` `test`。
- 禁止提交：`.env`、`node_modules/`、`.next/`、`.pnpm-store/`、`.npmrc`、`dist/`、`public/snapshots/`、`data/snapshots/`。

## 架构红线

1. **只读数据库**：不写入、不执行 DDL、不修改 schema；查询必须参数化，禁止拼接 SQL。
2. **依赖约束**：不引入 Redis、Python；缓存仅使用进程内 `lru-cache`，容量上限 1GB。
3. **分层约束**：服务端聚合，前端只展示；查询会话固定 `statement_timeout = 30s`。
4. **目录骨架**：`src/components/ui` 为 shadcn/ui 源码；`src/components/{cards,charts}` 为看板封装；`src/server/{db.ts,cache.ts,queries,services}` 为服务端层。
5. **方案变更**：`docs/方案.md` 的修改须经维护者批准后执行。
6. **审计正文只读**：会话正文来自 `AUDIT_DIR` 的本地文件（生产 `:ro` 挂载），读取层 `src/server/audit/` 与 `getDb()` 完全隔离；不写入、不建表、不提供删除接口。
