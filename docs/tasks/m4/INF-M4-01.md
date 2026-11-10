# INF-M4-01 · Docker 化部署（Dockerfile + docker-compose）

> 里程碑：M4 · 部署与安全 ｜ 类型：新增 ｜ 预估：1 人日 ｜ 复杂度：M ｜ 状态：todo

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
- 新增：`Dockerfile`、`docker-compose.yml`、`.dockerignore`
- 修改：`next.config.ts`（standalone）、README「快速开始」追加 Docker 路径小节

## 前置任务
FE-M2-02、BE-M3-03

## 实现阶段（检查点粒度）
- [ ] 阶段 1：Dockerfile 多阶段 + standalone 构建通过
- [ ] 阶段 2：compose 环境变量注入 + healthcheck
- [ ] 阶段 3：容器内快照验证（承接遗留闭环）
- [ ] 阶段 4：本地 docker compose up + demo 库联调（compose profiles 加可选 demo-db 便于演示）
- [ ] 阶段 5：镜像体积/构建时长记录，走收尾

## 接口/契约变更
无。

## 验收标准（含验证命令）
- [ ] `docker build .` 成功；`docker compose up` 后 `curl /api/health` 200
- [ ] 行为验收：容器内时区正确（趋势桶日界与宿主机 Asia/Shanghai 一致）；POST /api/snapshot 在容器内产出 HTML
- [ ] 联调点：BE-M4-02 访问控制以本卡产物为基座

## 收尾动作 checklist（完成时逐项执行）
1. 验证通过 2. 变更记录+续作区 done 3. 遗留闭环（删 LH 行）4. 回流（如需）5. 执行报告 `reports/INF-M4-01-执行报告-<日期>.md` 6. 归档 `archive/m4/` + COMPLETED 登记 7. 滚动归档检查 8. 同步看板 9. 校验 ERROR 清零

## 风险/阻塞
- 本机无 Docker 环境：置 blocked 并在断点备注说明验证缺口，待环境就绪续作。
- playwright 基础镜像体积大（数百 MB）：与方案无冲突（独立部署可接受），若需瘦身走 slim + 手工依赖清单，结论留痕。

---

## 续作区（检查点更新：开始/中断/完成各写一次）

> 覆盖式更新：只保留当前断点，旧断点收敛进变更记录，不堆叠时间线。

- 阶段进度：未开始（0 = 未开始）
- 断点备注：无
- 状态：todo
- 更新时间：2026-10-08

## 变更记录
| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-08 | 建卡 | 按方案 §11/§12 第 9 步拆解立项；承接 M3 快照安装遗留 |

## 红线

机制红线见本目录 `AGENTS.md`；仓库级红线见根 `AGENTS.md`。
