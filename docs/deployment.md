# 构建与部署

本项目的编译、打包、部署与回滚说明。技术设计见 [方案.md](方案.md)，数据库口径见 [db-schema-notes.md](db-schema-notes.md)。

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | 22 | 镜像基础 `node:22-slim` |
| pnpm | 10.34.5 | 由 `package.json` 的 `packageManager` 固定 |
| PostgreSQL | 16 兼容 | 只读账号，优先连接从库 |

包管理器固定为 pnpm，构建携带 `pnpm-lock.yaml`。

## 2. 构建

```bash
pnpm install
pnpm build
```

`build` 脚本先执行 `scripts/clean-next.mjs` 清空 `.next`，再运行 `next build`（`output: "standalone"`）。

| 产物 | 体积（实测） |
|---|---|
| `.next/standalone` | 27 MB |
| `.next/static` | 2.0 MB |

冷构建耗时（实测）：编译 9.9s，类型检查 8.3s，合计约 1 分钟。

构建约束：

- 构建期不依赖联网资源；字体使用系统字体栈，不使用 `next/font/google`。
- 构建期不校验 `DATABASE_URL` 与访问控制凭据：`src/instrumentation.ts` 在 `phase-production-build` 阶段直接返回。
- `pnpm build` 会清空 `.next`，`pnpm dev` 运行期间不得执行；仅清理缓存可用 `pnpm clean`。

## 3. 运行

```bash
pnpm start                        # next start -p 3088
node .next/standalone/server.js   # 等价直接运行
```

standalone 目录必须同时具备以下内容，缺一不可：

| 路径 | 来源 |
|---|---|
| `server.js` | 构建产物，唯一入口 |
| `.next/static/` | 构建后需复制进 standalone |
| `public/` | 仓库 `public/` |
| `node_modules/echarts/dist/echarts.min.js` | 手动复制；`/api/echarts/runtime` 直接读取该文件，依赖追踪不包含 |

运行时变量：`PORT`（默认 3088）、`HOSTNAME`（容器内为 `0.0.0.0`）。

## 4. 打包

### 4.1 Docker 镜像

多阶段构建，两个可选 target：

| target | 内容 | 用途 |
|---|---|---|
| `runner`（默认） | 运行时依赖，不含浏览器 | 常规部署 |
| `runner-snapshot` | 追加 Playwright 1.49.1、chromium 与系统依赖 | 需要服务端整页快照（`POST /api/snapshot`） |

```bash
docker build -t new-api-dashboard:<tag> .
docker build --target runner-snapshot -t new-api-dashboard:<tag>-snapshot .
```

未指定 `--target` 时构建最后一个 stage，即 `runner`（不含浏览器）。实测体积 271 MB。

国内网络建议指定 npm 源，否则依赖下载可能极慢：

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t new-api-dashboard:<tag> .
```

镜像特性：

- 非 root 运行，用户 `nextjs`（uid/gid 1001）。
- `PORT=3088`、`HOSTNAME=0.0.0.0`、`TZ=Asia/Shanghai`、`NEXT_TELEMETRY_DISABLED=1`。
- `HEALTHCHECK` 请求 `/api/health`：间隔 30s、超时 5s、启动宽限 20s、重试 3 次。
- `/app/data/snapshots` 预建并授权，`SNAPSHOT_DIR` 指向该处。

构建注意：

- 依赖阶段通过 corepack 获取 pnpm，构建机需可联网，或预置 corepack 缓存。
- `.dockerignore` 排除 `.env`、`.env.*`、`docs`、`README.md`、`AGENTS.md`、`data/snapshots`、`public/snapshots`。
- 容器内构建无 `.env`，环境变量在运行期经 `env_file` 或 `-e` 注入。

### 4.2 发布包（tar.gz）

面向「下载即用」的分发形态：不依赖 Docker，也不需要仓库与 pnpm，宿主机有 Node.js 22 即可运行。

```bash
pnpm build
pnpm release:pack
```

输出：

| 文件 | 说明 |
|---|---|
| `dist/new-api-dashboard-<version>.tar.gz` | 自包含安装包，约 10 MB |
| `dist/new-api-dashboard-<version>.tar.gz.sha256` | 校验和 |

包内结构：

```text
new-api-dashboard-<version>/
├── server.js                # 入口
├── package.json
├── node_modules/            # 运行时依赖（含 echarts.min.js）
├── .next/static/
├── public/
├── .env.example
├── Dockerfile               # 需自建镜像时使用
├── docker-compose.yml
├── README.md  LICENSE  SECURITY.md
├── docs/deployment.md
└── scripts/{setup-readonly.sql,seed-demo.sql}
```

使用：

```bash
sha256sum -c new-api-dashboard-<version>.tar.gz.sha256
tar -xzf new-api-dashboard-<version>.tar.gz
cd new-api-dashboard-<version>
cp .env.example .env       # 填写 DATABASE_URL 与登录凭据
node server.js             # 默认监听 3088
```

说明：

- 产物为纯 JavaScript，无原生依赖，跨平台通用（Windows / Linux / macOS）。
- 版本号取自 `package.json` 的 `version`，同时经 `next.config.ts` 内联到 `/api/health` 的 `version` 字段。
- 升级：解压新版本目录、切换软链接或替换目录后重启进程；`data/snapshots` 为外部目录，不受影响。
- **敏感配置**：`next build` 会把构建机上的 `.env` 复制进 `.next/standalone`。`pnpm release:pack` 已自动剔除并断言；若手工分发 standalone 目录，必须先删除其中的 `.env`。
- **符号链接**：pnpm 的 isolated 布局会在 `node_modules` 内生成符号链接，CI 环境下是绝对路径（`/home/runner/work/...`），打包后无法在其他机器解析。打包脚本统一解引用为真实文件，并断言包内无符号链接。

### 4.3 发布流程

发布由 tag 触发，GitHub Actions 完成构建与上传：

```bash
# 1. 更新版本与日志
#    package.json 的 version、CHANGELOG.md 追加对应版本段落（标题形如 "## [0.1.1] - 2026-11-20"）
# 2. 提交后打标签（tag 必须与 version 一致，否则工作流失败）
git tag -a v0.1.1 -m "v0.1.1"
git push origin main
git push origin v0.1.1
```

`Release` 工作流依次执行：校验 tag 与 `version` 一致 → hoisted 布局安装依赖 → 构建 → 打包 → 校验包内无 `.env` 与符号链接 → 解压并冒烟启动 → 生成发布说明 → 创建 Release 并上传 `tar.gz` 与 `.sha256`。

发布说明由 `scripts/release-notes.mjs` 生成：固定区块（下载安装、兼容性、文档）+ `CHANGELOG.md` 中对应版本的段落。**因此 CHANGELOG 的版本段落是发布页内容的唯一来源，发版前必须写。**

## 5. 部署

### 5.1 Docker Compose

```bash
cp .env.example .env       # 填写 DATABASE_URL、ADMIN_TOKEN、登录凭据
docker compose up -d --build
curl http://localhost:3088/api/health
```

| 项 | 配置 |
|---|---|
| 端口 | `3088:3088`，宿主与容器一致 |
| 配置注入 | `env_file: .env` |
| 快照持久化 | `./data/snapshots:/app/data/snapshots` |
| 重启策略 | `unless-stopped` |
| 镜像 target | `${DASHBOARD_TARGET:-runner}` |
| 演示库 | `--profile demo`，`postgres:16-alpine` + `scripts/seed-demo.sql` 初始化 |

### 5.2 裸机

将 `.next/standalone`、`.next/static`（置于 `standalone/.next/static`）、`public` 部署至同一目录，以 `node server.js` 启动，交由 systemd 或 PM2 托管。仓库不提供 unit 文件。

## 6. 环境变量

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
| `SNAPSHOT_DIR` | 否 | 快照目录，默认 `data/snapshots`；容器内 `/app/data/snapshots` |

生产环境缺少 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 时进程拒绝启动（fail-fast）。

## 7. 上线检查清单

1. **只读账号**：`scripts/setup-readonly.sql` 由 DBA 在目标库执行，创建 `dashboard_readonly` 角色、仅授予 SELECT、并设置 `default_transaction_read_only=on` 与 `statement_timeout=30s`。本项目不执行该脚本。
2. **访问控制**：`DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 已配置且非空。
3. **多实例**：显式配置同一 `DASHBOARD_SESSION_SECRET`，否则会话不跨实例通用。
4. **管理端点**：按需配置 `ADMIN_TOKEN`；留空时 `/api/admin/cache/*` 与 `/api/snapshot` 返回 404。
5. **快照目录**：`SNAPSHOT_DIR` 所在路径对运行用户可写。
6. **健康检查**：`GET /api/health` 返回 200。该端点探测数据库连通性，失败返回 503。
7. **反向代理**：终止 TLS 并转发 `X-Forwarded-Proto: https`。会话 Cookie 的 `Secure` 标志依据请求协议或该请求头判定，缺失时不加 `Secure`。
8. **基础地址**：`DASHBOARD_BASE_URL` 与外部访问地址一致，快照与导出链接据此生成。

## 8. 回滚

- 镜像以 tag 区分版本，回退时指定上一版本 tag 重建容器。
- `data/snapshots` 为卷挂载，回滚不丢失已有快照。
- 缓存为进程内 `lru-cache`，重启即失效，回滚无需清理缓存。
- 无数据库迁移与 schema 变更，回滚不涉及数据层操作。

## 9. 已知问题

| 问题 | 影响 | 处理 |
|---|---|---|
| `.next` 累积后构建长时间无进展 | 发布构建阻塞 | `pnpm build` 已内置清理 |
| `middleware.ts` 文件约定在 Next.js 16 废弃 | 构建输出警告 | 迁移至 `proxy.ts`：`npx @next/codemod@canary middleware-to-proxy .` |
| Docker 链路未实机验证 | 首次构建与运行存在未知风险 | 首次部署需人工确认 |
| 无 CI 与镜像仓库 | 构建、分发、版本留存依赖手工 | 待确定目标平台后补充 |
