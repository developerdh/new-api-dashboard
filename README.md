# new-api-dashboard

New API 用户使用量统计看板。独立部署的 TypeScript 全栈应用（Next.js App Router + PostgreSQL 只读直连），服务端完成 SQL 聚合，前端负责可视化、导出与快照。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/方案.md](docs/方案.md) | 技术方案，唯一权威设计 |
| [docs/db-schema-notes.md](docs/db-schema-notes.md) | 数据库实测结构与 schema 口径 |
| [AGENTS.md](AGENTS.md) | 仓库规范：命令、Git、架构红线 |

## 快速开始

环境要求：Node.js ≥ 20、pnpm ≥ 9。

```bash
pnpm install                 # 安装依赖
cp .env.example .env         # 配置环境变量（不提交）
pnpm dev                     # http://localhost:3088（/ 自动跳转 /dashboard）
```

| 命令 | 用途 |
|---|---|
| `pnpm build` | 生产构建（standalone） |
| `pnpm start` | 运行生产构建（3088） |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest，单测位于 `src/**/*.test.ts` |

## 访问控制

- 独立登录页 `/login` + HttpOnly 会话 Cookie（HMAC-SHA256 签名，有效期 12h）。
- 未登录访问页面重定向登录页，访问接口返回 401。
- 凭据由 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 配置；缺失时开发环境返回 503，生产环境拒绝启动。
- 控制台采用侧栏布局，顶栏支持明暗主题切换与退出登录。

## 功能

| 模块 | 内容 |
|---|---|
| 全局总览 | 消耗、请求数、Token、活跃用户、模型数；用户排行、每日热力图、消耗趋势（环比 / 同比） |
| 沉默用户 | 「上期活跃 · 本期沉默」清单：用户名、最后活跃时间、上期请求数、详情链接 |
| 模型分析 | 模型排行、多模型趋势、用户 × 模型交叉分布、单次请求平均成本 |
| 用户详情 | 个人总览、使用趋势、模型分布、Token 占比、活跃热力图、最近使用记录 |
| 导出 | 图表导出 HTML、数据导出 CSV、服务端整页快照 |

## 统计口径

- **时间**：Unix 秒，区间左闭右开 `[start, end)`，日/周/月边界按 `Asia/Shanghai` 计算。
- **数据源**：额度与 Token 总量取 `quota_data`（最多 5 分钟延迟）；请求数与 Token 输入/输出拆分取 `logs`（`type = 2` 消费流水）。
- **用户展示**：账号 `users.username` 与昵称 `users.display_name` 并存，昵称优先展示，账号作为次要信息保留。
- **排除账号**：所有统计排除管理员账号 `admin`，不计入任何指标、排行与沉默用户清单。
- **沉默用户**：本期无消费、上期（等长紧邻前一周期）有消费的用户；日志保留约 97 天，超出保留期的上期数据不回补。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | New API PostgreSQL 连接串，只读账号，优先从库 |
| `TZ` | 时区，默认 `Asia/Shanghai` |
| `DASHBOARD_BASE_URL` | 看板自身地址，供快照与导出使用 |
| `ADMIN_TOKEN` | 管理端点 Bearer 令牌（`/api/admin/cache/*`、`/api/snapshot`）；留空则端点禁用 |
| `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` | 登录凭据；生产环境缺失将拒绝启动 |
| `DASHBOARD_SESSION_SECRET` | 会话签名密钥；留空时由登录凭据派生，多实例部署须显式配置同一值 |
| `SNAPSHOT_DIR` | 快照目录，默认 `data/snapshots`（容器内 `/app/data/snapshots`） |

## Docker

> 仓库开发环境未安装 Docker，以下命令未实机验证。

```bash
cp .env.example .env                 # 填写 DATABASE_URL、ADMIN_TOKEN、登录凭据
docker compose up -d --build         # 默认镜像（不含浏览器）
curl http://localhost:3088/api/health
```

- 含快照能力（Playwright + chromium）：`DASHBOARD_TARGET=runner-snapshot docker compose up -d --build`
- 演示库：`docker compose --profile demo up -d --build`，连接串 `postgres://demo:demo@demo-db:5432/new_api_demo`
- 宿主与容器端口均为 3088；快照产物挂载到宿主 `./data/snapshots`，经受保护路由 `/api/snapshots/<file>` 读取。
- 镜像内已包含 `echarts.min.js`（单图导出运行时依赖）。
- 直接构建：`docker build -t new-api-dashboard .`；含快照：`docker build --target runner-snapshot -t new-api-dashboard:snapshot .`

## 目录结构

```text
src/
├── app/
│   ├── (console)/            # 受保护控制台：dashboard / models / users/[id]
│   ├── login/                # 独立登录页
│   └── api/                  # 统计、认证、导出、快照路由
├── server/
│   ├── db.ts                 # 只读连接池与 Kysely 实例
│   ├── cache.ts              # 进程内 lru-cache
│   ├── queries/              # SQL 构造：overview / trend / user / model / inactive
│   ├── services/             # 缓存编排、导出、快照
│   └── session.ts            # 会话签名与校验
├── components/
│   ├── ui/                   # shadcn/ui 源码
│   ├── cards/                # 看板卡片
│   └── charts/               # ECharts 封装
└── lib/                      # 格式化、时间区间、展示名等工具

scripts/                      # 快照脚本与数据库初始化 SQL
```
