# new-api-dashboard

New API 用户使用量统计看板。独立部署的 TypeScript 全栈应用：Next.js App Router + PostgreSQL 只读直连，服务端完成 SQL 聚合，前端负责可视化、导出与快照。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a)](package.json)

![全局总览](docs/images/overview.png)

> 本项目是非官方第三方看板，与 New API 官方无关联。它只读取 New API 的数据库，不修改其数据与结构。

## 功能

| 模块 | 内容 |
|---|---|
| 全局总览 | 消耗、请求数、Token、活跃用户、模型数；用户排行、每日热力图、消耗趋势（环比 / 同比） |
| 沉默用户 | 「上期活跃 · 本期沉默」清单：用户、最后活跃时间、上期请求数、详情入口 |
| 模型分析 | 模型排行、多模型趋势、用户 × 模型交叉分布、单次请求平均成本 |
| 用户详情 | 个人总览、使用趋势、模型分布、Token 占比、活跃热力图、最近使用记录 |
| 导出 | 图表导出 HTML、数据导出 CSV、服务端整页快照 |

![用户详情](docs/images/user-detail.png)

## 快速开始

环境要求：Node.js ≥ 22、pnpm 10.34.5（由 `packageManager` 固定）。

### 方式一：源码运行

```bash
pnpm install
cp .env.example .env         # 填写 DATABASE_URL、登录凭据（不提交）
pnpm build
pnpm start                   # http://localhost:3088
```

### 方式二：Docker

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:3088/api/health
```

镜像构建、双 target（含/不含 Playwright）、上线检查与回滚见 [docs/deployment.md](docs/deployment.md)。

### 先用演示数据试跑

无需连接真实库，`--profile demo` 会拉起一个带演示数据的 PostgreSQL：

```bash
docker compose --profile demo up -d --build
# .env 中设置：DATABASE_URL=postgres://demo:demo@demo-db:5432/new_api_demo
```

演示数据由 `scripts/seed-demo.sql` 生成：12 个虚构账号、60 天用量、8 个公开模型名，含昼夜与周末波动。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | New API PostgreSQL 连接串，只读账号，优先从库 |
| `DB_POOL_MAX` | 否 | 连接池上限，默认 10 |
| `DB_CONNECT_TIMEOUT_MS` | 否 | 建连超时，默认 5000 |
| `TZ` | 否 | 默认 `Asia/Shanghai` |
| `DASHBOARD_BASE_URL` | 否 | 看板对外地址，快照与导出使用 |
| `ADMIN_TOKEN` | 否 | 管理端点与快照端点的 Bearer 令牌；留空则端点禁用 |
| `DASHBOARD_AUTH_USER` | 生产必填 | 登录账号 |
| `DASHBOARD_AUTH_PASS` | 生产必填 | 登录密码 |
| `DASHBOARD_SESSION_SECRET` | 多实例必填 | 会话签名密钥；留空时由登录凭据派生 |
| `SNAPSHOT_DIR` | 否 | 快照目录，默认 `data/snapshots` |

## 统计口径

- **时间**：Unix 秒，区间左闭右开 `[start, end)`，日/周/月边界按 `Asia/Shanghai` 计算。
- **数据源**：额度与 Token 总量取 `quota_data`（最多 5 分钟延迟）；请求数与 Token 输入/输出拆分取 `logs`（`type = 2` 消费流水）。
- **用户展示**：账号 `users.username` 与昵称 `users.display_name` 并存，昵称优先展示，账号作为次要信息保留。
- **排除账号**：所有统计排除管理员账号 `admin`，不计入任何指标、排行与沉默用户清单。
- **沉默用户**：本期无消费、上期（等长紧邻前一周期）有消费的用户；日志保留约 97 天，超出保留期的上期数据不回补。

## 访问控制

- 独立登录页 `/login` + HttpOnly 会话 Cookie（HMAC-SHA256 签名，有效期 12h）。
- 未登录访问页面重定向登录页，访问接口返回 401。
- 凭据由 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 配置；缺失时开发环境返回 503，生产环境拒绝启动。
- 快照目录不在 `public/`，读取经受保护路由。

## 兼容性

| 依赖 | 要求 |
|---|---|
| New API | 需具备 `users` / `logs` / `quota_data` 三表，且包含统计实际引用的列（`users.display_name`、`logs.type`、`quota_data.token_used` 等，完整清单见 `src/server/schema-check.ts`） |
| PostgreSQL | 16 及以上（已在 18.2 实测） |
| 部署 | Node.js 22，或使用 Docker |

启动后访问 `GET /api/health` 会做 schema 自检：

```json
{
  "ok": false,
  "version": "0.1.0",
  "db": { "status": "up", "latencyMs": 12 },
  "schema": { "ok": false, "missing": ["users.display_name", "logs.type"] }
}
```

存在缺失列时 `ok` 为 `false`、HTTP 503，并列出具体缺项。不同 New API 版本的结构差异见 [docs/db-schema-notes.md](docs/db-schema-notes.md)。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/方案.md](docs/方案.md) | 技术方案，唯一权威设计 |
| [docs/db-schema-notes.md](docs/db-schema-notes.md) | 数据库实测结构与 schema 口径 |
| [docs/deployment.md](docs/deployment.md) | 构建、打包、部署与回滚 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见问题排查（按现象索引） |
| [docs/nginx.example.conf](docs/nginx.example.conf) | 反向代理参考配置 |
| [SECURITY.md](SECURITY.md) | 漏洞报告与部署安全前提 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、提交规范与代码红线 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [AGENTS.md](AGENTS.md) | 仓库规范：命令、Git、架构红线 |

## 目录结构

```text
src/
├── app/
│   ├── (console)/            # 受保护控制台：dashboard / models / users/[id]
│   ├── login/                # 独立登录页
│   └── api/                  # 统计、认证、导出、快照、健康检查
├── server/
│   ├── db.ts                 # 只读连接池与 Kysely 实例
│   ├── cache.ts              # 进程内 lru-cache
│   ├── queries/              # SQL 构造：overview / trend / user / model / inactive
│   ├── services/             # 缓存编排、导出、快照
│   └── session.ts            # 会话签名与校验
├── components/               # ui / cards / charts / layout
└── lib/                      # 格式化、时间区间、展示名等工具
scripts/                      # 演示数据、只读授权 SQL、快照脚本、打包脚本
```

## 开发命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发服务器（3088） |
| `pnpm build` | 生产构建（先清空 `.next`，产物为 standalone） |
| `pnpm start` | 运行生产构建（3088） |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest |
| `pnpm clean` | 清空 `.next` |
| `pnpm release:pack` | 生成可分发的 tar.gz（见 docs/deployment.md） |

## 常见问题

完整排查手册见 [docs/troubleshooting.md](docs/troubleshooting.md)（按现象索引，含登录 403、反代配置、health 503、快照与构建问题）。

几个最常遇到的：

**经反向代理访问时登录报 403 `invalid_origin`**

0.1.0 及更早版本存在缺陷：同源校验误用了 Next 在 Route Handler 中解析出的服务端地址，导致除 localhost 直连外一律拒绝。升级到 0.1.1 及以上；同时确认 nginx 使用 `proxy_set_header Host $http_host;`（`$host` 会丢端口）。

**Windows 上 `pnpm dev` 报 `Could not find the Next.js package`**

Next.js 16 的 Turbopack 在 Windows 上无法解析 pnpm 默认的 isolated 布局。改为 hoisted：

```bash
pnpm config set node-linker hoisted --location project
```

该设置写入本地 `.npmrc`，已被 `.gitignore` 排除，不影响其他平台。

**构建耗时异常长或卡住**

`.next` 中累积的开发缓存会让构建长时间无进展。`pnpm build` 已内置清理；单独清理用 `pnpm clean`。

**`/api/health` 返回什么**

```json
{
  "ok": true,
  "version": "0.1.1",
  "db": { "status": "up", "latencyMs": 12 },
  "schema": { "ok": true, "missing": [] }
}
```

`ok` 为 `false` 时返回 503：`db.status` 为 `down` 表示数据库不可达，`schema.missing` 非空表示表结构与查询依赖不一致。响应头为 `no-store`。

## 许可

[MIT](LICENSE)
