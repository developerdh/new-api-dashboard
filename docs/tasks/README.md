# new-api-dashboard · 任务中央看板

> 定位：任务体系的唯一入口与执行索引。只承载：当前指针、在办任务、开放遗留、权威文档清单——全部为任务状态与事实。机制运行逻辑见本目录 [`AGENTS.md`](AGENTS.md)；git 约定见根 [`AGENTS.md`](../../AGENTS.md)（指针，不复制正文）。

## 1. 目录结构

```text
docs/tasks/
├── AGENTS.md          机制载体（本目录内自动加载，规则唯一权威）
├── README.md          中央看板（本文件）
├── _template.md       任务卡模板
├── FEEDBACK.md        用户反馈入口（F-编号，转出即删）
├── BACKLOG.md         待排期与取消项
├── COMPLETED.md       完成索引（一行式，滚动归档）
├── validate-tasks.mjs 一致性校验（仓库根运行 node docs/tasks/validate-tasks.mjs）
├── m0/  m1/  m2/  m3/  m4/   在办任务卡，按里程碑分目录
├── leftover/          遗留任务卡（LO-编号）
├── reports/           任务执行报告（终点文档）
└── archive/           归档域（默认不读不引不扫）
```

任务编号：`<ROLE>-M<里程碑>-<序号>`，ROLE ∈ BE/FE/INF（详见 [`AGENTS.md`](AGENTS.md)「编号族」）。
里程碑：M0 基础与脚手架 ｜ M1 核心统计 API ｜ M2 前端看板 ｜ M3 导出与快照 ｜ M4 部署与安全。

## 2. 续作流程（新会话）

1. 看本文件 §3：`current_task` 即现在应推进的任务。
2. 打开对应任务卡，读「关键口径摘要 + 续作区」（续作区是状态唯一事实源）。
3. 开场提示词按 [`AGENTS.md`](AGENTS.md)「会话接力」节生成；此后按检查点制推进，完成走卡内收尾 checklist。

## 3. 当前指针

| 指针 | 值 |
|---|---|
| `current_task` | FE-M2-01 · 看板骨架与共享 UI（主题/布局/时间选择器/图表封装） |
| `next_task` | FE-M2-02 · 全局总览页 /dashboard（指标卡/趋势/排行/热力图） |

> 更新规则：任务完成时 `current_task ← next_task`（或按用户指示/卡内前置关系指定）。只写编号与一句话；需要注意的点写进任务卡，不写在这里。

## 4. 在办任务表（todo / in_progress）

| 编号 | 任务 | 里程碑 | 类型 | 前置任务 | 状态 |
|---|---|---|---|---|---|
| FE-M2-01 | 看板骨架与共享 UI（主题/布局/时间选择器/图表封装） | M2 | 新增 | INF-M0-01 | todo |
| FE-M2-02 | 全局总览页 /dashboard（指标卡/趋势/排行/热力图） | M2 | 新增 | FE-M2-01、BE-M1-02、BE-M1-03、BE-M1-04 | todo |
| FE-M2-03 | 用户详情页 /users/[id] | M2 | 新增 | FE-M2-01、BE-M1-05 | todo |
| FE-M2-04 | 模型分析页 /models（含用户×模型交叉） | M2 | 新增 | FE-M2-01、BE-M1-06 | todo |
| BE-M3-01 | GET /api/export/csv 导出（限流） | M3 | 新增 | BE-M1-03、BE-M1-04、BE-M1-06 | todo |
| FE-M3-02 | 前端单图导出（自包含 HTML 模板） | M3 | 新增 | FE-M2-02 | todo |
| BE-M3-03 | 服务端看板快照（POST /api/snapshot + Playwright） | M3 | 新增 | FE-M2-02、BE-M0-04 | todo |
| INF-M4-01 | Docker 化部署（Dockerfile+compose） | M4 | 新增 | FE-M2-02、BE-M3-03 | todo |
| BE-M4-02 | 访问控制与查询安全收口 | M4 | 新增 | BE-M3-01、BE-M3-03、INF-M4-01 | todo |

> 已完成任务不在本表，见 [`COMPLETED.md`](COMPLETED.md)。前置任务可引用已完成编号（定位方式见 COMPLETED 头注）。

## 5. 跨任务遗留事项（open）

| 编号 | 遗留项 | 来源任务 | 归属/触发条件 | 简短说明 |
|---|---|---|---|---|
| LH-01 | Tremor v3 主题 token 在 Tailwind v4 下的映射 | INF-M0-01 | FE-M2-01（主题与共享 UI） | `tremor-*`/`dark-tremor-*` 约 25 组 token 需 `@theme` 映射；peer 声明 react ^18 已用 pnpm.peerDependencyRules 放行，DatePicker 运行期兼容未验证 |
| LH-03 | BE-M0-02 真库连通冒烟未执行（本机无 Docker/PostgreSQL，按用户决定不安装） | BE-M0-02 | 真实库接入时（BE-M1 联调前） | 连接层与 503 降级路径已验收；待补验真库 200 + latencyMs 与只读会话加固生效（只读 SQL 与断言见 `docs/db-schema-notes.md` §8/A.5） |
| LH-04 | BE-M0-03 真实库结构复验未执行（列/类型/索引/保留区间；schema.ts 候选列待晋升） | BE-M0-03 | 真实库接入时（BE-M1-01 前） | 按 `docs/db-schema-notes.md` §8 清单回填 §3/§4；候选列按 §5.2 晋升；差异成立时走回流 |
| LH-05 | BE-M1-02 M1 统计数值对数未执行（本机无 PG，无 demo 库/真实库可对比） | BE-M1-02 | 真实库接入时（M1 各 API 联调前） | 用 `docs/方案.md` §5.1–§5.6 手工 SQL 与 API 响应逐项对比数值；注意 quota_data 5 分钟延迟导致请求数/额度存在口径差（响应已注 `meta.source`） |
| LH-06 | BE-M1-06 `/api/models/cross` 为 §4 清单外增补端点，回流未决 | BE-M1-06 | 用户回流审批（FE-M2-04 联调前） | 批准→`docs/方案.md` §4 增一行并闭环本行；不批准→端点保留但方案不记，或按《回流说明》回滚下线 |
<!-- 登记与闭环规则见 AGENTS.md「遗留处理机制」；闭环=删行 -->

## 6. 权威文档清单（何时读哪个）

| 文档 | 何时查阅 |
|---|---|
| `docs/方案.md` | 技术方案唯一权威定稿（**红线：不可修改，改动走回流审批**）。按主题定位：技术栈 §1 / 数据库对接与索引 §2 / 统计维度 §3 / API 契约 §4 / SQL 口径 §5 / 缓存与防泄漏 §6 / 前端页面 §7 / 快照导出 §8 / 安全性能 §9 / 目录结构 §10 / 部署 §11 |
| 根 `AGENTS.md` | 环境命令、git 约定、架构红线（仓库级权威，任务卡一律指针引用） |
| 本目录 `AGENTS.md` | 任务机制规则（本目录内自动加载，无需显式读） |

## 7. 更新记录

| 日期 | 摘要 |
|---|---|
| 2026-10-08 | 体系初始化，按 `docs/方案.md` §12 路线图拆解 M0–M4 共 19 张任务卡入在办表 |
| 2026-10-08 | 方案文档迁移至 `docs/方案.md`，体系内全部引用同步 |
| 2026-10-09 | INF-M0-01 完成并归档（Next.js 全栈骨架，build/lint/test/dev 实测通过）；指针推进至 BE-M0-02；登记遗留 LH-01（Tremor 主题 token）、LH-02（§8.1 exportToHTML 待回流） |
| 2026-10-09 | 回流批准执行：`docs/方案.md` §8.1 改为「自包含 HTML 模板 + `getOption()` 序列化 + echarts 运行时内联」，FE-M3-02 卡与 LH-02 同步（LH-02 闭环删行） |
| 2026-10-12 | BE-M0-02 完成并归档（连接层 + `/api/health`，实测未配置库时 503 降级）；真库连通冒烟环境受限，登记 LH-03 并移交 BE-M0-03；指针推进至 BE-M0-03 |
| 2026-11-10 | BE-M0-03 完成并归档（db-schema-notes 核验框架 + 三份只读 SQL 清单 + schema.ts 候选列隔离）；无可用数据库，结构复验登记 LH-04、LH-03 随行移交；指针推进至 BE-M0-04 |
| 2026-11-10 | BE-M0-04 完成并归档（缓存基座 + 分级 TTL + 管理端点守卫 + instrumentation）；单测 60 例与生产模式 e2e 通过；指针推进至 BE-M1-01 |
| 2026-11-10 | BE-M1-01 完成并归档（查询公共基座：Zod 归一/时区边界/环比同比/统一响应/缓存接入）；单测 87 例通过；指针推进至 BE-M1-02 |
| 2026-11-11 | BE-M1-02 完成并归档（/api/overview：§5.1 聚合 + logs 请求数 + 60s 缓存 + meta.source）；无库数值对数登记 LH-05；指针推进至 BE-M1-03 |
| 2026-11-11 | BE-M1-03 完成并归档（/api/trend：三粒度桶 + logs 请求数合并 + compare prev/yoy + 动态 TTL）；单测 140 例通过；指针推进至 BE-M1-04 |
| 2026-11-11 | BE-M1-04 完成并归档（/api/users/ranking：§5.7 聚合 + 改名名称策略 + 请求数二次查询 + limit 收紧 + 120s 缓存）；单测 158 例通过；指针推进至 BE-M1-05 |
| 2026-11-11 | BE-M1-05 完成并归档（单用户 overview/trend/models：活跃天数、30s 缓存、模型占比、最近 50 条）；单测 179 例通过；指针推进至 BE-M1-06 |
| 2026-11-11 | BE-M1-06 完成并归档（模型 ranking/trend/cross：平均成本、models 过滤、Top10 矩阵 + others）；cross 回流待批登记 LH-06；单测 201 例通过；指针推进至 FE-M2-01 |
