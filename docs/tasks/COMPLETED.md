# 已完成任务记录（COMPLETED）

> 作用：已完成任务的一行式索引，按里程碑滚动归档（机制见 `AGENTS.md`）；已收口里程碑段在 `archive/COMPLETED-m<n>.md`（归档域，仅用户明确指示时查阅）。
> 主文件只保留：① 在办批次相关的已完成行；② 「遗留」列仍活跃的行。
> 「遗留」列指向看板 §5 的开放遗留编号（LH-xx）；该遗留闭环后本列改记「已闭环」。
> 任务卡定位约定：`archive/<里程碑目录>/<编号>.md`，编号即路径。

| 编号 | 任务 | 里程碑 | 完成日期 | 遗留 |
|---|---|---|---|---|
| INF-M0-01 | 项目骨架初始化（Next.js+TS+Tailwind+shadcn/ui+Tremor+ECharts） | M0 | 2026-10-09 | LH-01；LH-02 已闭环 |
| BE-M0-02 | 数据库连接层（pg + Kysely + 只读守卫 + /api/health） | M0 | 2026-10-12 | LH-03 |
| BE-M0-03 | 数据源核验与 schema 口径（db-schema-notes + 只读 SQL 清单） | M0 | 2026-11-10 | LH-03；LH-04 |
| BE-M0-04 | 进程内缓存基座（lru-cache 1GB + 分级 TTL + 防慢泄漏） | M0 | 2026-11-10 | 无 |
| BE-M1-01 | 查询公共基座（Zod 参数 / 时间语义 / 错误格式 / getOrCache 接入） | M1 | 2026-11-10 | 无 |
| BE-M1-02 | GET /api/overview 全局总览 | M1 | 2026-11-11 | LH-05 |
| BE-M1-03 | GET /api/trend 全局趋势（day/week/month + 环比同比） | M1 | 2026-11-11 | LH-05 |
| BE-M1-04 | GET /api/users/ranking 用户消耗排行 | M1 | 2026-11-11 | LH-05 |
| BE-M1-05 | 单用户统计 API（overview/trend/models） | M1 | 2026-11-11 | LH-05 |
| BE-M1-06 | 模型统计 API（ranking/trend/cross） | M1 | 2026-11-11 | LH-05；LH-06 |
| FE-M2-01 | 看板骨架与共享 UI（主题/布局/时间选择器/图表封装） | M2 | 2026-11-11 | 无（LH-01 已闭环） |
| FE-M2-02 | 全局总览页 /dashboard（指标卡/趋势/排行/热力图） | M2 | 2026-11-11 | LH-05；LH-07 |
| FE-M2-03 | 用户详情页 /users/[id] | M2 | 2026-11-11 | LH-05；LH-07 |
| FE-M2-04 | 模型分析页 /models（排行/趋势/交叉） | M2 | 2026-11-11 | LH-05；LH-06；LH-07 |
