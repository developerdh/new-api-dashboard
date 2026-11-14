# e2e 冒烟测试（Playwright）

看板 GUI 的**确定性**冒烟测试：登录 → 概览 → 会话卡片 → 过滤 → 双路径详情（旧布局/段式）→ 线程 → 独立页 → 抽样提示。定位全部基于 `data-testid`（唯一权威清单见 [TESTIDS.md](TESTIDS.md)）；探索性/人工执行的完整用例见 [TESTPLAN.md](TESTPLAN.md)。

**与执行工具无关**：只要环境里有 Node 22 + Chromium，`pnpm test:e2e` 一条命令即可运行——不依赖任何特定 agent 工具；agent 工具（或人工）也可以按 TESTPLAN.md 执行同一套用例。

## 环境准备（一次性）

```bash
pnpm install                      # 安装 @playwright/test
pnpm e2e:install                  # 下载 Chromium（一次性；约 150MB）
cp tests/e2e/.env.e2e.example .env.e2e   # 填写目标环境与凭据（.env.e2e 不入库）
```

**约定：运行时缺 Chromium 只报告、不自动下载**（global-setup 预检，缺了会给出安装命令并停止）。目标不可达、缺 `E2E_TOKEN` 同样明确报错退出。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_BASE_URL` | `http://127.0.0.1:3088` | 看板地址；换环境改这里 |
| `E2E_USERNAME` / `E2E_PASSWORD` | `admin` / 无默认 | 看板登录凭据（部署时 `DASHBOARD_AUTH_USER/PASS`） |
| `E2E_TOKEN` | 无（必填） | 造数用完整 Authorization 头（如 `Bearer sk-…`），须属于 `E2E_USER_ID` 名下的 token |
| `E2E_USER_ID` | `1` | 造数记录归属的用户 |
| `E2E_SEED_HOST` | 看板主机名 + `:3090` | 采集代理地址；跨机时显式指定或用 SSH 隧道 |
| `E2E_SAMPLING_ENABLED` | `0` | 目标环境开了抽样时置 `1`（断言提示条出现） |

凭据与 token 不入库：写进仓库根目录 `.env.e2e`（已 gitignore）。

## 运行

```bash
pnpm test:e2e     # 造数（seed.mjs）→ 跑 smoke.spec.ts
pnpm e2e:seed     # 只造数
```

- 造数经**采集代理**发 3 条带唯一标记 `e2e-smoke-<runId>` 的真实请求（1 非流式 + 2 条同会话键流式），走的是采集管线本身，不写数据库；
- 断言全部**相对化**：找"含本次标记"的记录/详情，不依赖既有数据量——换任何环境，seed 成功即可通过；
- 失败时 `tests/e2e/test-results/` 里有截图与 trace（已 gitignore）。

## 测试数据残留

造数记录会留在目标环境的 `DASHCAM_DIR` 里（trace id 形如 `e2esmoke-<runId>-*`）。随保留期清理，或按 `clean-dashcam.sh` 的口径人工删除日期目录；不清理不影响后续运行（断言基于当次标记）。

## 跨机运行

看板与代理不同机时：`E2E_SEED_HOST` 指向代理可达地址；代理只绑回环时用 SSH 隧道，例如：

```bash
ssh -N -L 3090:127.0.0.1:3090 root@<目标机>   # 本地 3090 → 目标机 3090
E2E_SEED_HOST=http://127.0.0.1:3090 pnpm test:e2e
```

## 目录

| 文件 | 职责 |
|---|---|
| `playwright.config.ts` | 配置 + 加载 `.env.e2e`（存在才加载，环境变量优先） |
| `global-setup.ts` | 预检：缺 Chromium / 缺 `E2E_TOKEN` / 看板不可达 → 明确报错停止（不自动安装） |
| `seed.mjs` + `shanghai-date.mjs` | 造数与东八区日期口径 |
| `smoke.spec.ts` | T1-T9 确定性用例 |
| `TESTIDS.md` | data-testid 唯一权威清单（组件 ↔ 用例映射） |
| `TESTPLAN.md` | 工具中立全量用例（agent / 人工执行） |
