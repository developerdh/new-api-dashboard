# new-api-dashboard

New API 用户使用量统计看板：独立部署的 TypeScript 全栈看板（Next.js + PostgreSQL 只读直连），服务端 SQL 聚合，shadcn/ui + Tremor + ECharts 可视化，lru-cache 进程内缓存，支持 CSV 导出与静态 HTML 快照。

| 文档 | 说明 |
|---|---|
| [方案.md](docs/方案.md) | 技术方案定稿（权威，红线不可改） |
| [docs/tasks/README.md](docs/tasks/README.md) | 任务中央看板（开发推进入口，当前指针在此） |
| [AGENTS.md](AGENTS.md) | 仓库级规范：环境命令 / git 约定 / 架构红线 |

## 快速开始

环境要求：Node.js ≥ 20、pnpm ≥ 9。

```bash
pnpm install                 # 安装依赖
cp .env.example .env         # 配置环境变量（不提交，见下）
pnpm dev                     # 开发服务器 http://localhost:3000（/ 自动跳转 /dashboard）
```

> 访问控制（BE-M4-02）：页面与查询接口走 HTTP Basic Auth（`DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS`）。
> 开发环境未配置时受保护路径返回 503；生产环境缺少凭据会拒绝启动（fail-fast）。

其他命令：

```bash
pnpm build                   # 生产构建
pnpm start                   # 运行生产构建
pnpm lint                    # ESLint（eslint-config-next + TypeScript 规则）
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run（单测落 src/**/*.test.ts）
```

## Docker 部署（可选）

> 由 INF-M4-01 提供；**本仓库开发环境未安装 Docker，以下命令未实机验证**（看板遗留 LH-09）。

```bash
cp .env.example .env                 # 填写 DATABASE_URL（只读账号）、ADMIN_TOKEN 与 DASHBOARD_AUTH_USER/PASS
docker compose up -d --build         # 默认 runner（不含浏览器）
curl http://localhost:3000/api/health
```

- 快照能力（`POST /api/snapshot`）需要 Playwright + chromium，镜像更大：
  `DASHBOARD_TARGET=runner-snapshot docker compose up -d --build`
- 演示库（可选，初始化 `scripts/seed-demo.sql`）：
  `docker compose --profile demo up -d --build`，随后 `DATABASE_URL=postgres://demo:demo@demo-db:5432/new_api_demo`
- 快照产物挂载到宿主 `./data/snapshots`（不入库；镜像内 `SNAPSHOT_DIR=/app/data/snapshots`，读取经受保护路由 `/api/snapshots/<file>`）。
- 镜像内已复制 `node_modules/echarts/dist/echarts.min.js`（单图导出端点运行时依赖，standalone 追踪不包含）。
- 直接构建镜像：`docker build -t new-api-dashboard .`；含快照：`docker build --target runner-snapshot -t new-api-dashboard:snapshot .`

## 环境变量

复制 `.env.example` 为 `.env` 后按环境填写：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | New API 的 PostgreSQL 连接串，**只读账号 + 优先从库**（方案 §2.1） |
| `TZ` | 时区，默认 `Asia/Shanghai` |
| `DASHBOARD_BASE_URL` | 看板自身地址（快照/导出使用） |
| `ADMIN_TOKEN` | 管理/快照端点 Bearer 令牌（`/api/admin/cache/*`、`/api/snapshot`）；留空 = 端点禁用（404） |
| `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` | 全站 Basic Auth 凭据（页面/查询/导出/快照读取）；生产环境缺失将拒绝启动 |
| `SNAPSHOT_DIR` | 快照产物目录（默认 `data/snapshots`；容器内为 `/app/data/snapshots`，卷挂载持久化） |

## 目录结构

```text
src/
├── app/                 # App Router：/ 跳转 /dashboard；/dashboard、/users/[id]、/models 占位页
│   └── api/             # API Routes（服务端聚合，按方案 §4 实现）
├── server/              # 服务端：db.ts / cache.ts / queries/ / services/（方案 §10）
├── components/
│   ├── ui/              # shadcn/ui 基础组件源码（button/card/tabs/select/dialog/table/dropdown-menu）
│   ├── cards/           # 看板卡片封装
│   └── charts/          # ECharts 封装（自建 hook，不引入第三方 React 包装库）
├── lib/                 # 工具函数（cn 等）
└── types/               # 共享类型
scripts/                 # 运维脚本（快照等）
```

当前进度：M0 基座、M1 统计 API、M2 前端看板、M3 导出与快照已完成；剩余任务与开放遗留见 [docs/tasks/README.md](docs/tasks/README.md)。