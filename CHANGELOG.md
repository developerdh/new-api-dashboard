# 更新日志

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-12

### 修复

- **经反向代理、域名或 IP 访问时无法登录（403 `invalid_origin`）**：登录接口的同源校验用
  `new URL(request.url).origin` 与浏览器 `Origin` 比较，而 Next.js 在 Route Handler 中把
  `request.url` 解析为服务端自身的监听地址（`http://localhost:<PORT>`），忽略 `Host`。
  因此除「本地 localhost 直连」外，两者恒不相等。现改为按 `X-Forwarded-Host` → `Host`
  与 `X-Forwarded-Proto` 解析对外 origin 后再判定，同时保留跨站拦截。

## [0.1.0] - 2026-11-12

首次公开发布。

### 新增

- **全局总览**：消耗、请求数、Token、活跃用户、模型数；用户消耗排行、每日消耗热力图、消耗趋势（环比 / 同比）。
- **沉默用户**：按「上期活跃 − 本期活跃」给出用户清单，含最后活跃时间、上期请求数与详情入口。
- **模型分析**：模型排行（按额度 / 请求数 / Token 切换）、多模型趋势、用户 × 模型交叉分布、单次请求平均成本。
- **用户详情**：个人总览、使用趋势、模型分布、Token 输入/输出占比、活跃热力图、最近使用记录。
- **导出**：图表导出为自包含 HTML、四类数据集 CSV 导出、服务端整页快照。
- **访问控制**：独立登录页 + HttpOnly 会话 Cookie（HMAC-SHA256，12h）；页面未登录重定向、接口返回 401。
- **工程**：Next.js 16（App Router / Turbopack / standalone）、Kysely 只读查询层、进程内 `lru-cache`、`/api/health` 连通与 schema 自检。
- **交付**：多阶段 Dockerfile（含 Playwright 快照变体）、docker compose、演示数据库 profile、`pnpm release:pack` 生成 tar.gz 安装包。

### 说明

- 所有统计排除管理员账号 `admin`。
- 用户展示以昵称优先，账号作为次要信息保留。
- 时间区间左闭右开，边界按 `Asia/Shanghai` 计算。
