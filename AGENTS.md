# AGENTS.md — 仓库级规范（new-api-dashboard）

项目：New API 用户使用量统计看板，TypeScript 全栈（Next.js App Router）直连只读 PostgreSQL，服务端 SQL 聚合、前端可视化与导出。

- 技术方案权威定稿：`docs/方案.md` —— **红线：不可修改**；实现偏差需《回流说明》交用户决策（回流规则见 `docs/tasks/AGENTS.md`）。
- 任务看板与续作入口：`docs/tasks/README.md`；任务机制载体 `docs/tasks/AGENTS.md`（在该目录工作时自动加载）。
- 本文件只管仓库级规范：环境命令 / git 约定 / 架构红线。任务机制事实不入本文件。

## 环境与命令

- Node.js ≥ 20 LTS；pnpm ≥ 9（包管理器固定 pnpm，提交携带 `pnpm-lock.yaml`）。
- 常用命令：`pnpm install` ｜ `pnpm dev`（http://localhost:3000，`/` 跳转 `/dashboard`）｜ `pnpm build` ｜ `pnpm lint` ｜ `pnpm typecheck`（`tsc --noEmit`）｜ `pnpm test`（vitest，单测落 `src/**/*.test.ts`）。
- 构建期不联网：不使用 `next/font/google` 等需要下载远程资源的字体方案（内网/CI 无外网时会使构建失败），字体统一走 `src/app/globals.css` 的系统字体栈。
- 环境变量：复制 `.env.example` 为 `.env`（不提交）；核心为 `DATABASE_URL`（只读账号，优先从库，见 `docs/方案.md` §2.1），另有 `TZ`、`DASHBOARD_BASE_URL`、`ADMIN_TOKEN`。
- 任务体系校验：`node docs/tasks/validate-tasks.mjs`（仓库根运行，只读）。

## Git 约定

- 单一主分支 `main`，小步提交；任务收尾（卡内 checklist）即一次提交，commit message 末括任务编号。
- 提交信息：`<type>(<scope>): <subject>`，type ∈ feat/fix/docs/refactor/chore/test；scope ∈ api/dashboard/cache/db/deploy/tasks 等模块名。
- 禁止提交：`.env` 等敏感文件、`node_modules/`、`.next/`、`.pnpm-store/`、`public/snapshots/`（见 `.gitignore`）。

## 架构红线（指针，出处见 docs/方案.md 对应章节）

- 只读访问 New API 数据库：不写入、不执行 DDL、不改 schema（方案 §0、§2.1）；参数化查询，禁止字符串拼接 SQL（§9.1）。
- 不引入 Redis、不引入 Python；缓存仅用进程内 lru-cache，1GB 上限并按 §6.3 防慢泄漏。
- 服务端完成聚合，前端只展示（§0）；查询设 `statement_timeout = '30s'`（§9.2）。
- 目录骨架按方案 §10：`src/components/ui` 为 shadcn/ui 源码（可改）；`src/components/{cards,charts}` 放本项目看板封装；`src/server/{db.ts,cache.ts,queries,services}` 为服务端层。