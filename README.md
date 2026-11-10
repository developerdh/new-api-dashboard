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

其他命令：

```bash
pnpm build                   # 生产构建
pnpm start                   # 运行生产构建
pnpm lint                    # ESLint（eslint-config-next + TypeScript 规则）
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run（单测落 src/**/*.test.ts）
```

## 环境变量

复制 `.env.example` 为 `.env` 后按环境填写：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | New API 的 PostgreSQL 连接串，**只读账号 + 优先从库**（方案 §2.1） |
| `TZ` | 时区，默认 `Asia/Shanghai` |
| `DASHBOARD_BASE_URL` | 看板自身地址（快照/导出使用） |
| `ADMIN_TOKEN` | 看板访问令牌（用途由 BE-M0-04 定义，当前为占位） |

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

当前为 M0 骨架阶段：页面均为占位页，数据接入与图表见 [docs/tasks/README.md](docs/tasks/README.md) 看板在办任务。