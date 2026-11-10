# 数据库 schema 核验记录（db-schema-notes）

> **定位**：项目内 schema 口径权威，M1 各统计任务的输入必读。记录 `quota_data` / `logs` / `users` 的**实际**列、类型、索引与数据保留区间，以及与 `docs/方案.md` §2.2 的差异清单。
> **权威边界**：`docs/方案.md` 是技术方案唯一权威（红线：不可修改）。本文件只记录「库的实际情况」，与方案口径冲突时按 §4 差异清单登记；影响 M1 统计口径的差异按回流规则出《回流说明》，不自行改写方案。
> **敏感信息**：本文件不出现连接串、host、账号与口令；连接配置只落 `.env`（不提交）。

## 1. 核验状态

| 项 | 值 |
|---|---|
| 核验状态 | **未对真实库复验**（2026-11-10） |
| 原因 | 执行环境无 `psql` / Docker / PostgreSQL，且按约束不安装数据库；未获得可连的真实只读从库连接串（用户确认走「只交付脚本 + 核验清单」路径） |
| 已确认 | 方案 §2.2 的「常见字段」清单（文档口径，方案自述「字段以实际 `\d` 为准」，故**不构成库事实**） |
| 未确认 | 三表实际列与类型、实际索引、数据保留区间、行数/分区、logs 是否含非消费记录、quota_data 聚合粒度 |
| schema.ts 现状 | 保持方案 §2.2 基线列，候选列隔离在 `*CandidateColumns`（见 §5） |
| 复验触发 | 用户提供生产只读从库连接串（写 `.env`，不提交）→ 按 §8 清单逐项执行、回填 §3、更新 §4 |
| 关联遗留 | LH-03（真库 200 + latencyMs + 只读会话加固生效）、LH-04（真实库结构/保留区间复验与 schema.ts 晋升） |

**一句话结论**：本文件当前是一份**待填的核验台账**——结构事实（列/类型/索引/保留区间）全部为空位，配套的只读核验 SQL（附录 A）、差异判据（§4）、schema 校准规则（§5）与交付脚本（§6/§7）已就绪；填入实测值即完成复验，不需要重写本文件结构。

## 2. 核验方法与只读约束

- **只用 SELECT**：附录 A 全部为 `information_schema` / `pg_catalog` 查询与 `MIN/MAX` 聚合，不含任何 DDL/DML。
- **会话前置**（连上后先执行，再跑核验）：
  ```sql
  SET default_transaction_read_only = on;
  SET statement_timeout = '30s';
  ```
  与应用侧 `src/server/db.ts` 的双层加固（启动参数 + 池级 `verify`）保持同一口径。
- **大表计数**：`logs` 精确 `COUNT(*)` 可能超 30s；先用 `pg_class.reltuples` 估算（A.3），精确计数只在低峰或独立看板库执行。
- **文档回填**：把结果填进 §3，判定用 §3.1 图例；任何「非命中」项必须在 §4 登记并给结论。
- **不做的事**：本项目不执行 §2.1 授权语句、不执行 §2.4 `CREATE INDEX`（只出脚本清单，执行属用户/运维决策）；不改 `docs/方案.md`。

## 3. 三表事实（复验时回填）

> 判定图例：`命中` = 与方案 §2.2 基线一致；`缺列` / `类型不符` / `多列` = 与基线有差异（在 §4 登记编号）；`待核验` = 尚未实测。

### 3.1 quota_data（按小时聚合的用量数据）

| 列 | M1 用途（方案引用） | 实际类型 | 可空 | 判定 |
|---|---|---|---|---|
| user_id | 单用户查询、用户排行（§5.5–§5.7） | 待填 | 待填 | 待核验 |
| username | 排行展示（§5.7） | 待填 | 待填 | 待核验 |
| model_name | 模型分布/趋势（§5.6、§3.4） | 待填 | 待填 | 待核验 |
| created_at | 全部时间范围过滤（§5.1–§5.8）；Unix 秒假设 | 待填 | 待填 | 待核验 |
| token_used | 总 Token（§5.1–§5.7） | 待填 | 待填 | 待核验 |
| quota | 消耗额度（§5.1–§5.7） | 待填 | 待填 | 待核验 |
| prompt_tokens | 输入 Token（§5.1、§5.6） | 待填 | 待填 | 待核验 |
| completion_tokens | 输出 Token（§5.1、§5.6） | 待填 | 待填 | 待核验 |

### 3.2 logs（原始消费日志）

| 列 | M1 用途（方案引用） | 实际类型 | 可空 | 判定 |
|---|---|---|---|---|
| user_id | 单用户请求数、最近使用记录 | 待填 | 待填 | 待核验 |
| username | 展示 | 待填 | 待填 | 待核验 |
| created_at | 请求数（§5.1）、RPM（§5.8） | 待填 | 待填 | 待核验 |
| model_name | 模型维度（若精确口径走 logs） | 待填 | 待填 | 待核验 |
| quota | 单请求成本（§3.4） | 待填 | 待填 | 待核验 |
| prompt_tokens | 输入 Token 拆分 | 待填 | 待填 | 待核验 |
| completion_tokens | 输出 Token 拆分 | 待填 | 待填 | 待核验 |

> 方案 §2.2 的 logs 基线**不含** `token_used`：Token 一律由 `prompt_tokens + completion_tokens` 求和，勿假设存在该列。

### 3.3 users（用户基础信息）

| 列 | M1 用途（方案引用） | 实际类型 | 可空 | 判定 |
|---|---|---|---|---|
| id | 用户详情页路由/关联（§7） | 待填 | 待填 | 待核验 |
| username | 展示 | 待填 | 待填 | 待核验 |
| status | 启用/禁用过滤 | 待填 | 待填 | 待核验 |
| quota | 额度展示（语义另见 §4-D9） | 待填 | 待填 | 待核验 |

### 3.4 索引

| 索引 | 列序 | 来源 | 实际存在 | 判定 |
|---|---|---|---|---|
| idx_quota_data_created_at | (created_at) | 方案 §2.4 | 待核验 | 待核验 |
| idx_quota_data_user_created | (user_id, created_at) | 方案 §2.4 | 待核验 | 待核验 |
| idx_quota_data_model_created | (model_name, created_at) | 方案 §2.4 | 待核验 | 待核验 |
| idx_logs_created_at | (created_at) | 方案 §2.4 | 待核验 | 待核验 |
| idx_logs_user_created | (user_id, created_at) | 方案 §2.4 | 待核验 | 待核验 |
| idx_logs_model_created | (model_name, created_at) | 补充建议（非 §2.4 条文，§4-D11） | 待核验 | 待核验 |
| 其它既有索引 | — | 实际库发现 | 待核验 | 待核验 |

> 复验时把实际索引逐条抄进本表：同名但列序不同也算差异（D10）；`indisvalid = false` 的残骸需先 DROP 再重建。

### 3.5 数据保留区间（方案 §2.3）

| 表 | MIN(created_at) | MAX(created_at) | 覆盖天数 | 估算行数 | 判定 |
|---|---|---|---|---|---|
| quota_data | 待填 | 待填 | 待填 | 待填 | 待核验 |
| logs | 待填 | 待填 | 待填 | 待填 | 待核验 |

判据（复验时按此下结论，写进上行「判定」）：
- 两表区间基本一致 → 保留策略未剪裁，M1 可全范围使用；
- logs 区间明显短于 quota_data → logs 被清理（D13）：精确请求数/RPM 只能覆盖较短窗口，趋势仍走 quota_data；
- 任一表覆盖 < 90 天 → 「本月/自定义」范围需在 UI 提示数据不足，须在 M2 卡登记；
- 区间起点不是整日 → 记录首尾截断情况，避免趋势首末桶被误判为「用量骤降」。

### 3.6 其它结构事实

| 项 | 判据 | 结论 |
|---|---|---|
| schema 归属 | A.1 返回的 `table_schema` | 待核验（方案默认 `public`） |
| `created_at` 类型 | `udt_name` 是否为 `int8` | 待核验（若为 `timestamptz` → §4-D5，§5 全部 SQL 口径需改） |
| quota_data 聚合粒度 | 同 `(user_id, model_name, 小时)` 是否多行（A.4） | 待核验（多行 → §4-D6，请求数不可由行数推） |
| logs 是否含非消费记录 | 抽样对照（A.4 及只读账号总量对比） | 待核验（→ §4-D4，请求数口径） |
| 是否分区表 | `pg_partitioned_table` 命中（A.1） | 待核验（→ §4-D8） |
| users.quota 语义 | 与 `logs`/`quota_data` 累计对比（只读） | 待核验（→ §4-D9） |
| 行数量级 | `reltuples`（A.3） | 待核验（同时用于 §7 索引判据） |

## 4. 与方案 §2.2 的差异清单

> 「当前结论」只有四种取值：`待核验`（未实测）、`不成立`（实测与基线一致）、`成立`（差异确认，按「M1 影响」处理）、`已澄清`（文档口径问题，非库差异）。

| 编号 | 核验点 | 判据 | 若成立的 M1 影响 | 是否回流 | 当前结论 |
|---|---|---|---|---|---|
| D1 | quota_data 缺 `model_name` | A.1 列清单 | 模型排行/趋势、单用户模型分布不可用 → 需改方案统计维度或换数据源 | 是 | 待核验 |
| D2 | quota_data 缺 `prompt_tokens`/`completion_tokens` | A.1 列清单 | Token 输入输出拆分退化（§3.1、§5.1、§5.6） | 是 | 待核验 |
| D3 | logs 缺 `model_name` | A.1 列清单 | 精确口径下的模型维度不可用，模型统计只能走 quota_data | 是（若 M1 依赖 logs 模型维度） | 待核验 |
| D4 | logs 含非消费记录（如充值/错误日志） | 抽样 + 只读账号总量对照 | `COUNT(*)` 高估请求数（§5.1、§5.8）→ 需加过滤条件 | 是 | 待核验 |
| D5 | `created_at` 非 int8 Unix 秒（如 timestamptz/numeric） | `udt_name` | §5 全部 `to_timestamp(created_at)` / epoch 比较失效，需改 SQL 与 TS 类型 | 是 | 待核验 |
| D6 | quota_data 非小时聚合（同键多行/粒度不同） | A.4 重复桶计数 | 请求数不能从 quota_data 行数推导；趋势需先聚合到桶 | 是 | 待核验 |
| D7 | 三表不在 `public` schema | A.1 `table_schema` | 授权、索引清单与查询的 schema 前缀需调整 | 否（实现细节） | 待核验 |
| D8 | quota_data/logs 为分区表 | A.1 `relkind`/`pg_partitioned_table` | §2.4 索引需分别建在分区父表与各分区；查询计划不同 | 否 | 待核验 |
| D9 | users.quota 为「剩余额度」而非「累计额度」 | 与 logs/quota_data 累计对照 | 用户额度展示口径需明确（M2），不影响 M1 聚合 | 否 | 待核验 |
| D10 | 已存在与 §2.4 同名/同前缀索引 | A.2 与 §3.4 对照 | 少建或不建，避免重复索引写放大 | 否 | 待核验 |
| D11 | §2.4 条目数口径：方案列 **5 条**，任务卡写「六条」 | 文档对照 | 交付按方案 5 条 + 1 条补充建议（`idx_logs_model_created`，标注非条文） | 否 | 已澄清 |
| D12 | 「在从库建索引」不可行：物理从库只读 | `pg_is_in_recovery()` | 索引落点 = 主库低峰窗口或独立看板库；从库仅承载查询 | 否（机制说明） | 已澄清 |
| D13 | logs 保留区间短于 quota_data | §3.5 对比 | 精确请求数/RPM 仅覆盖较短窗口，需在 UI/接口注明 | 是（若影响接口时间范围语义） | 待核验 |
| D14 | 列名大小写/保留字差异（如 `quota`、`user_id` 拼写） | A.1 逐列比对 | Kysely 类型与 SQL 需同步改名；影响 M1 全部查询 | 否 | 待核验 |

**回流判据**：D1/D2/D3/D4/D5/D6/D13 任一项「成立」且改变 §3/§4/§5 的统计口径 → 按 `docs/tasks/AGENTS.md`「回流规则」出《回流说明》（改动点/原因/回滚方式）交用户决策，批准后才改方案；未批准前一律以本文件记录实际事实、在任务卡标注口径冲突。

## 5. 对 `src/server/schema.ts` 的校准

### 5.1 本次已落地（未复验前提下的可做项）

- `Database` 仅保留方案 §2.2 基线列：共 8 + 7 + 4 列，与 §3.1–§3.3 表逐行对应；
- 未核验候选列隔离为 `QuotaDataCandidateColumns` / `LogsCandidateColumns` / `UsersCandidateColumns`，**不进入 `Database`**：M1 若「照猜测」写 `quota_data.count` 或 `logs.type`，类型检查直接失败；
- `created_at` 统一 `number`（Unix 秒），int8 → number 由 `db.ts` 进程级注册（`2^53` 内安全）；
- 候选列清单与「基线列集合」由 `src/server/__tests__/schema.test.ts` 锁定：晋升/删除必须同步改测试与本文件；
- `SCHEMA_VERIFICATION.verified = false` 作为机器可读状态位，复验通过后才置 `true` 并填日期。

### 5.2 复验后的晋升规则

1. 按 §3.1–§3.3 实测列与类型改 `*Table`：缺列删、多列加、类型按 `udt_name` 映射；
2. 候选列按 §4 结论二选一：成立 → 移入对应 `*Table` 并从 `*CandidateColumns` 删除；不成立 → 直接删候选；
3. 可空性按 `is_nullable` 修正（`YES` → `field: T | null`）；
4. 同步：`schema.test.ts` 的列集合断言、本文件 §1/§3/§5；看板 LH-04 闭环（删行）并留结论。

### 5.3 类型映射口径（复验后按实际 `udt_name` 套用）

| PostgreSQL 类型 | TS 类型 | 备注 |
|---|---|---|
| `int2` / `int4` / `int8` | `number` | int8 已由 `db.ts` 注册解析器；超出 `2^53` 会丢精度（时间戳远低于此界；额度若出现异常大值需评估） |
| `text` / `varchar` | `string` | 空串 vs NULL 语义需按数据核对 |
| `numeric` | `string` | **node-postgres 不解析 numeric**：`SUM(bigint)`、`AVG()` 结果默认是字符串 |
| `boolean` | `boolean` | — |
| `timestamptz` / `timestamp` | `Date` | 若 `created_at` 为此类 → 触发 D5，§5 SQL 口径整体重写 |
| `jsonb` | `unknown` | 本看板基线不涉及 |

**聚合口径（M1 必读）**：`SUM(quota)`、`SUM(token_used)` 在 PG 侧返回 `numeric`，node-postgres 默认给 `string`。若接口契约是 `number`，SQL 内显式 `::bigint`（或 `::double precision`），不要依赖隐式转换——Kysely 的类型声明必须与之一致。`COUNT(*)` 返回 `int8`，已按 `number` 解析。

## 6. 只读账号授权：`scripts/setup-readonly.sql`

- **内容**：方案 §2.1 的角色/连接/schema USAGE/SELECT/默认权限，加两侧收紧——收敛写权限（`REVOKE INSERT,UPDATE,DELETE,TRUNCATE,...`、`REVOKE CREATE ON SCHEMA`）与角色级会话加固（`default_transaction_read_only=on`、`statement_timeout=30s`、`idle_in_transaction_session_timeout=60s`）。
- **执行者**：DBA/用户；本项目**不执行**（只读红线，见根 `AGENTS.md`）。
- **口令传递**：口令只出现在 `.env` 的 `DATABASE_URL`（不提交）与 `psql -v role_password=...` / 交互式 `\password` 中；不写进文档、脚本、命令历史以外的任何位置。注意服务端 `log_statement=all` 会把 `CREATE ROLE ... PASSWORD` 记进日志，高安全场景请改用 `\password`。
- **默认权限的坑**：`ALTER DEFAULT PRIVILEGES` 只对「执行者或 `FOR ROLE` 指定角色」新建的对象生效。New API 建表角色与执行脚本的 DBA 账号不同时，**必须**用 `-v table_owner=<应用角色>`，否则升级新增的表会让看板报 `permission denied`。
- **执行后断言**（脚本末尾已带）：`quota_data`/`logs`/`users` 的 `has_table_privilege(...,'SELECT')=t`、`INSERT/UPDATE/DELETE=f`；`has_schema_privilege(...,'CREATE')=f`。

## 7. 索引建议：`scripts/index-suggestions.sql`

- **内容**：方案 §2.4 的 5 条 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` + 1 条补充建议 `idx_logs_model_created`（非 §2.4 条文，见 §4-D11），并带现状核查、失效索引检查、执行后核查与回滚语句。
- **执行边界**：本项目只出清单；是否建、在哪建、何时建属用户/DBA 决策。
- **硬约束**：`CREATE INDEX CONCURRENTLY` 不能进事务块（脚本无 `BEGIN/COMMIT`）；中断会留下 `indisvalid=false` 的索引残骸，需先 DROP 再重建；物理从库只读，**不能**在从库建索引（§4-D12）。
- **判据（实测，不凭感觉）**：对 §5.1 的「近 30 天」查询做 `EXPLAIN (ANALYZE, BUFFERS)`，记录计划与实际耗时；出现 `Seq Scan` 且耗时/读页数随范围线性增长才建；建完重跑同语句复测。行数 < ~10 万的表，顺序扫描往往已是最优，不建。
- **写入放大**：主库上建索引会影响 New API 写入吞吐与复制延迟，需低峰窗口与磁盘/时间预算。

## 8. 真实库复验清单（拿到只读连接串后逐项执行）

> 前置：连接串写入 `.env`（不提交）；`DATABASE_URL` 使用只读账号；全程只跑 Appendix A 的只读 SQL。

- [ ] 1. 只读会话生效：`SHOW default_transaction_read_only` = `on`、`SHOW statement_timeout` = `30s`（A.5）
- [ ] 2. 写权限为假：三表 `INSERT/UPDATE/DELETE` 断言全为 `f`（§6 断言）
- [ ] 3. 应用连通：`GET /api/health` 返回 200 + 合理 `latencyMs`，`/dashboard` 可打开（**LH-03**）
- [ ] 4. 列与类型：跑 A.1，回填 §3.1–§3.3 与 §3.6 的 `created_at`/schema/分区三项
- [ ] 5. 索引：跑 A.2，回填 §3.4，逐条判 D10
- [ ] 6. 保留区间与规模：跑 A.3，回填 §3.5，判 D13
- [ ] 7. 聚合粒度与日志成分：跑 A.4，判 D4/D6
- [ ] 8. 差异定论：把 §4 每行「当前结论」改成 成立/不成立；`成立` 的按「是否回流」列处理（需回流 → 出《回流说明》）
- [ ] 9. schema.ts 晋升：按 §5.2 改 `*Table`/候选列/可空性，`SCHEMA_VERIFICATION` 置 `true` 并填日期
- [ ] 10. 回归：`pnpm test`、`pnpm typecheck`、`pnpm build` 通过；`node docs/tasks/validate-tasks.mjs` ERROR 清零
- [ ] 11. 遗留闭环：按结论删除看板 LH-03 / LH-04 对应行（闭环 = 删行），结论写进执行报告
- [ ] 12. 复验记录：在 §9 追加一行（环境只写「生产只读从库 / 独立看板库」，不写 host）

## 9. 复验记录

| 日期 | 环境 | 结论 | 执行人 |
|---|---|---|---|
| 2026-11-10 | 无可用 PG（本机无 psql/Docker/PostgreSQL，未安装） | 未复验；本文件结构与判据就绪 | BE-M0-03 |

## 附录 A. 只读核验 SQL

> 全部为 SELECT；连上先执行：
> ```sql
> SET default_transaction_read_only = on;
> SET statement_timeout = '30s';
> ```

### A.1 列与类型（回填 §3.1–§3.3、§3.6）

```sql
-- A.1.1 表是否存在、在哪个 schema、是表/视图/分区
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_name IN ('quota_data', 'logs', 'users')
ORDER BY table_schema, table_name;

-- A.1.2 列与类型（判定依据：data_type / udt_name / is_nullable / column_default）
SELECT table_name,
       ordinal_position,
       column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default,
       character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('quota_data', 'logs', 'users')
ORDER BY table_name, ordinal_position;

-- A.1.3 分区与 relkind（r = 普通表，p = 分区父表）
SELECT c.relname AS object_name,
       c.relkind,
       CASE WHEN pt.partrelid IS NULL THEN false ELSE true END AS is_partitioned,
       pt.partstrat
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname IN ('quota_data', 'logs', 'users')
ORDER BY c.relname;
```

### A.2 索引（回填 §3.4，判 D10）

```sql
-- A.2.1 现有索引定义（与 §3.4 期望清单逐条比对：名称、列序）
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('quota_data', 'logs', 'users')
ORDER BY tablename, indexname;

-- A.2.2 索引有效性（indisvalid = false 是 CONCURRENTLY 中断残骸）
SELECT t.relname AS table_name,
       c.relname AS index_name,
       i.indisunique,
       i.indisvalid,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN ('quota_data', 'logs', 'users')
ORDER BY table_name, index_name;
```

### A.3 保留区间与规模（回填 §3.5，判 D13）

```sql
-- A.3.1 精确区间（created_at 为 int8 Unix 秒时直接可用；若为 timestamptz，见 D5 改用 min/max 原值）
SELECT 'quota_data' AS table_name,
       count(*) AS rows,
       to_timestamp(min(created_at)) AS min_created,
       to_timestamp(max(created_at)) AS max_created,
       round((max(created_at) - min(created_at)) / 86400.0, 1) AS span_days
FROM quota_data
UNION ALL
SELECT 'logs',
       count(*),
       to_timestamp(min(created_at)),
       to_timestamp(max(created_at)),
       round((max(created_at) - min(created_at)) / 86400.0, 1)
FROM logs;

-- A.3.2 大表备选：估算行数 + 物理大小（避免 logs 精确 count 超时）
SELECT relname,
       reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN ('quota_data', 'logs', 'users')
  AND relkind IN ('r', 'p')
ORDER BY relname;
```

### A.4 聚合粒度与日志成分（判 D4/D6）

```sql
-- A.4.1 quota_data 是否小时聚合：近 7 天同 (user_id, model_name, 小时) 出现多行则粒度更细
SELECT count(*) AS duplicated_buckets
FROM (
  SELECT user_id, model_name, created_at / 3600 AS hour_bucket
  FROM quota_data
  WHERE created_at >= extract(epoch FROM now())::bigint - 7 * 86400
  GROUP BY 1, 2, 3
  HAVING count(*) > 1
) AS t;

-- A.4.2 logs 的消费成分：抽样近 1 小时，按是否存在 type/内容类列判断是否需过滤
--   若 A.1 显示存在 type 列，取消下面注释并记录分布（类型取值语义需用户确认）：
-- SELECT type, count(*) FROM logs
-- WHERE created_at >= extract(epoch FROM now())::bigint - 3600
-- GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS logs_last_hour
FROM logs
WHERE created_at >= extract(epoch FROM now())::bigint - 3600;

-- A.4.3 只读账号可见的用量总量（与 New API 后台展示对账，用于识别非消费日志）
SELECT COALESCE(sum(quota), 0) AS quota_sum_7d,
       count(*) AS rows_7d
FROM logs
WHERE created_at >= extract(epoch FROM now())::bigint - 7 * 86400;
```

### A.5 会话加固验证（LH-03 的只读部分）

```sql
-- A.5.1 会话级 GUC
SHOW statement_timeout;
SHOW default_transaction_read_only;
SELECT current_database(), current_user, version(), pg_is_in_recovery();

-- A.5.2 角色级加固（只读断言：期望 t / f）
SELECT has_table_privilege(current_user, 'public.quota_data', 'INSERT') AS can_insert_should_be_false,
       has_table_privilege(current_user, 'public.logs', 'UPDATE') AS can_update_should_be_false,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_should_be_false;
```

> 写权限断言全为 `f` 且 `default_transaction_read_only = on` 时，只读加固闭环；应用侧 `/api/health` 的 200 + `latencyMs` 在真实库复验时补测（LH-03）。
