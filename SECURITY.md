# 安全策略

## 报告漏洞

请通过 GitHub 仓库的 Security 页发起私密漏洞报告（Security → Report a vulnerability），不要公开提 issue。

报告请包含：受影响版本（`GET /api/health` 的 `version` 字段）、复现步骤、影响范围。收到后会在 7 天内确认，修复版本发布后一并公开致谢（如需匿名请注明）。

## 部署前提

本项目直连 New API 的生产数据库，部署方必须自行保证以下前提。缺失任何一项都可能造成数据暴露：

| 前提 | 要求 |
|---|---|
| 数据库账号 | 只读。授予 `SELECT` 与 `CONNECT`，并令 `default_transaction_read_only = on`（见 `scripts/setup-readonly.sql`） |
| 连接来源 | 优先连接只读从库；不要使用具备写入或 DDL 权限的账号 |
| 访问控制 | 必须配置 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS`；生产环境缺失会拒绝启动 |
| 传输层 | 经反向代理终止 TLS，并转发 `X-Forwarded-Proto: https`；否则会话 Cookie 不带 `Secure` 标志 |
| 会话密钥 | 多实例部署须显式设置同一 `DASHBOARD_SESSION_SECRET` |
| 网络暴露 | 不建议直接暴露在公网；必须暴露时，前置 WAF 或至少限制来源 IP |
| 管理端点 | `ADMIN_TOKEN` 留空即整体禁用；设置时使用强随机值，不写入版本库 |

## 不视为漏洞的情形

- 未按上述前提部署导致的暴露（例如用可写账号连接、未配置登录凭据、明文 HTTP 暴露公网）。
- `ADMIN_TOKEN` 为空时管理端点返回 404 的行为，属于设计。
- 只读账号无法访问的表或列，不属于本项目的权限缺陷。

## 数据处理说明

- 本项目不写入数据库、不建表、不执行 DDL、不改 schema。
- 进程内 `lru-cache` 缓存仅存放聚合结果，不落盘，进程退出即失效。
- 快照文件存放于 `SNAPSHOT_DIR`（默认 `data/snapshots`），不经 `public/` 直接暴露，读取须经鉴权路由。
- 日志默认不输出数据库连接串、令牌或用户凭据。

## 分发注意

`next build` 会把构建机上的 `.env` 复制进 `.next/standalone`。因此：

- 用 `pnpm release:pack` 生成发布包（脚本会剔除 `.env` 并断言，缺失 `.env.example` 即中止）。
- 手工分发 standalone 目录、或基于本地构建产物制作镜像时，必须先删除其中的 `.env`。
- 提交前确认 `git status` 未出现 `.env`；该文件由 `.gitignore` 覆盖。
