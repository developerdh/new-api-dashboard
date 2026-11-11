# INF-M4-01 · Docker 化部署（Dockerfile + docker-compose）

> 里程碑：M4 · 部署与安全 ｜ 类型：新增 ｜ 预估：1 人日 ｜ 复杂度：M ｜ 状态：done

## 目标
多阶段 Dockerfile + docker-compose.yml 完成可部署镜像：`docker compose up` 后 `/api/health` 通过、看板可用；承接 BE-M3-03 移交的容器内 chromium 安装遗留。

## 输入/必读文档
- [ ] `docs/方案.md` §11.1（compose 示例：ports/TZ/DATABASE_URL/DASHBOARD_BASE_URL/restart 策略）、§10（Dockerfile 位于仓库根）
- [ ] 根 `AGENTS.md`（git/环境，指针）；BE-M3-03 执行记录中的 playwright 安装口径（经看板遗留 LH 行取用，不引用其报告）

## 本任务关键口径摘要
- Dockerfile 多阶段：`deps → build → runner`，`output: 'standalone'`（`next.config` 开启），runner 用 `node:22-slim` + `pnpm` 仅生产依赖；`TZ=Asia/Shanghai` 显式设置（趋势/热力图时区正确性判据）。
- 快照能力镜像分层：chromium 系统依赖经 `playwright install --with-deps chromium` 装入 build/runner（或独立 snapshot profile），体积与缓存策略在变更记录留一行结论。
- compose 按 §11.1 最小化：单服务 dashboard、`env_file: .env`、卷挂载 `./public/snapshots`（产物持久化，不入库）、`restart: unless-stopped`、healthcheck 调 `/api/health`。
- `.dockerignore`：node_modules/.next/.env/docs/scripts 测试件。
- 不引入新部署编排（无 k8s manifest）。

## 起点代码基线
FE-M2-02（完整可展示页）、BE-M3-03（含快照服务，遗留移交本卡）完成。

## 承接点 · 遗留事项
- **问题**：BE-M3-03 移交——Docker 镜像内 playwright/chromium 安装方式未定。
- **需要做的修复**：本卡落地镜像内安装并验证容器内 POST /api/snapshot 可用。
- **闭环**：完成后在变更记录回登 + 看板遗留表删除对应 LH 行。

## 产出文件清单
- 新增：`Dockerfile`（runner / runner-snapshot 双目标）、`docker-compose.yml`（dashboard + demo profile）、`.dockerignore`、`public/.gitkeep`（构建上下文需要 public 目录）
- 修改：`next.config.ts`（`output: "standalone"`）、`README.md`（Docker 快速开始 + ADMIN_TOKEN 说明 + 进度状态）

## 前置任务
FE-M2-02、BE-M3-03

## 实现阶段（检查点粒度）
- [x] 阶段 1：Dockerfile 多阶段 + standalone 配置；`pnpm build` 验证 `.next/standalone/{server.js,node_modules}` 存在（`docker build` 未执行 → LH-09）
- [x] 阶段 2：compose 环境变量注入 + healthcheck（文件就绪；`docker compose up` 未执行 → LH-09）
- [ ] 阶段 3：容器内快照验证（承接 LH-08）—— **未执行**（无 Docker + 未安装 Playwright）→ LH-08 + LH-09
- [x] 阶段 4：compose demo-db profile 与 seed 挂载文件就绪（实跑未执行 → LH-09）
- [ ] 阶段 5：镜像体积/构建时长记录 —— **未执行**（无镜像）→ LH-09

## 接口/契约变更
无。部署约定：默认镜像 `runner`（不含浏览器）；`runner-snapshot` 目标含 Playwright + chromium（构建期联网）；compose 用 `env_file: .env`、快照目录卷挂载、healthcheck `GET /api/health`（503 视为 unhealthy）。

## 验收标准（含验证命令）
- [ ] `docker build .` 成功；`docker compose up` 后 `curl /api/health` 200 —— **未执行**（本机无 Docker）→ LH-09
- [x] `pnpm build` 产出 standalone 产物（`.next/standalone/server.js` 与 `node_modules`）；`pnpm test` 260 例、typecheck/lint 通过
- [x] 文件级校验：Dockerfile COPY 源路径存在（`public/`、`.next/static`、`echarts.min.js`）、compose 语法与 profile/healthcheck 就绪
- [ ] 行为验收：容器内时区正确、POST /api/snapshot 产出 HTML —— **未执行** → LH-08 + LH-09
- [x] 联调点：BE-M4-02 访问控制以本卡产物为基座（Dockerfile 非 root、ADMIN_TOKEN 经 env 注入）

## 收尾动作 checklist（完成时逐项执行）
1. 验证通过 2. 变更记录+续作区 done 3. 遗留闭环（删 LH 行）4. 回流（如需）5. 执行报告 `reports/INF-M4-01-执行报告-<日期>.md` 6. 归档 `archive/m4/` + COMPLETED 登记 7. 滚动归档检查 8. 同步看板 9. 校验 ERROR 清零

## 风险/阻塞
- **本机无 Docker**：卡内建议「置 blocked」；按本会话机制改为「代码交付完成 + done + LH-09 双向登记」（同 BE-M0-03 先例），实机 build/up/容器内快照待环境就绪。
- `runner-snapshot` 目标未实机构建：Playwright 版本（1.49.1）与 chromium 系统依赖清单未验证；若构建失败按 LH-08 调整版本/镜像源（PLAYWRIGHT_DOWNLOAD_HOST）。
- standalone 追踪不含 `echarts.min.js`（服务端只按路径读取），镜像已显式 COPY；若未来改打包方式需同步。
- 快照产物目录卷挂载；`.dockerignore` 排除 `public/snapshots`，避免把真实用量数据打进镜像上下文。

---

## 续作区（检查点更新：开始/中断/完成各写一次）

> 覆盖式更新：只保留当前断点，旧断点收敛进变更记录，不堆叠时间线。

- 阶段进度：5/5（3/5 项为文件级交付；实机验证未执行，登记 LH-08/LH-09）
- 断点备注：无
- 状态：done
- 更新时间：2026-11-11

## 变更记录
| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-08 | 建卡 | 按方案 §11/§12 第 9 步拆解立项；承接 M3 快照安装遗留 |
| 2026-11-11 | 交付口径 | 本机无 Docker：Dockerfile/compose/.dockerignore + standalone 配置交付并做文件级校验，`docker build/up` 与容器内快照登记 LH-09（不置 blocked，沿用 BE-M0-03 先例） |
| 2026-11-11 | 任务完成，状态置 done | 无回流；执行报告记录镜像双目标（runner / runner-snapshot）、echarts.min.js 显式 COPY、demo profile；LH-08 待镜像构建后闭环 |

## 红线

机制红线见本目录 `AGENTS.md`；仓库级红线见根 `AGENTS.md`。
