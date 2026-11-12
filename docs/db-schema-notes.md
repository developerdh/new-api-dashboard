# 数据库 schema 核验记录

记录 New API 数据库 `quota_data` / `logs` / `users` 的实测列、类型、索引与保留区间，是统计口径的 schema 依据。与 `docs/方案.md` §2.2 的差异见 §4。

本文不记录连接串、主机、账号与口令；连接配置仅存在于 `.env`。

## 1. 核验状态

| 项 | 值 |
|---|---|
| 核验时间 | 2026-11-11 |
| 数据库 | PostgreSQL 18.2，库 `new-api`，只读账号 |
| 库形态 | 主库（`pg_is_in_recovery() = false`）；只读依赖账号权限与会话 GUC |
| 会话加固 | `default_transaction_read_only = on`、`statement_timeout = 30s` |
| 类型声明 | `src/server/schema.ts` 已按实测列校准，`SCHEMA_VERIFICATION.verified = true` |

结论：真实库与方案 §2.2 存在 4 项影响统计口径的差异（D2 / D4 / D6 / D10）；实现按实测结构落地。

## 2. 核验方法

- 仅执行附录 A 的只读 SQL（`information_schema` / `pg_catalog` / `MIN` / `MAX`）。
- 连接后先执行：

  ```sql
  SET default_transaction_read_only = on;
  SET statement_timeout = '30s';
  ```

- `logs` 精确 `COUNT(*)` 可能超过 30s，规模估算使用 `pg_class.reltuples`。
- 不执行授权、建索引等写操作；相关脚本见 §6、§7，执行由 DBA 决策。

## 3. 三表事实

### 3.1 quota_data

`public.quota_data`，12 列，主键 `id`：

```text
id             int8      NOT NULL
user_id        int8      NULL
username       varchar   NULL
model_name     varchar   NULL
created_at     int8      NULL   -- Unix 秒
use_group      varchar   NULL
token_id       int8      NULL
channel_id     int8      NULL
node_name      varchar   NULL
token_used     int8      NULL
count          int8      NULL   -- 桶内请求数
quota          int8      NULL
```

**无** `prompt_tokens` / `completion_tokens`，Token 拆分只能取 `logs`。

### 3.2 logs

`public.logs`，21 列，主键 `id`，统计相关列：

```text
id                  int8    NOT NULL
user_id             int8    NULL
username            text    NULL
created_at          int8    NULL   -- Unix 秒
type                int8    NULL   -- 1 充值 / 2 消费 / 3 管理 / 5 错误 / 7 其它
model_name          text    NULL
quota               int8    NULL
prompt_tokens       int8    NULL
completion_tokens   int8    NULL
```

其余列：`use_time`、`is_stream`、`channel_id`、`channel_name`、`token_id`、`group`、`ip`、`request_id`、`upstream_request_id`、`other`、`content`、`token_name`。

近 7 天分布：`type = 2` 66,971 行；`type = 5` 364 行、`7` 15 行、`3` 10 行、`1` 3 行，非消费行 `quota = 0`。

### 3.3 users

`public.users`，29 列，主键 `id`，统计相关列：

```text
id             int8    NOT NULL
username       text    NULL
display_name   text    NULL
status         int8    NULL   -- 实测全部为 1
quota          int8    NULL   -- 语义待确认（D9）
used_quota     int8    NULL
request_count  int8    NULL
created_at     int8    NULL
last_login_at  int8    NULL
```

### 3.4 索引

| 表 | 实测索引 |
|---|---|
| `quota_data` | `quota_data_pkey(id)`、`idx_qdt_created_at(created_at)`、`idx_qdt_model_user_name`、`idx_quota_data_user_id`、`idx_quota_data_channel_id`、`idx_quota_data_node_name`、`idx_quota_data_token_id`、`idx_quota_data_use_group` |
| `logs` | `logs_pkey(id)`、`idx_created_at_id`、`idx_created_at_type`、`idx_logs_user_id`、`idx_user_id_id`、`idx_logs_model_name`、`index_username_model_name` 及 channel/group/ip/request/token 相关索引 |
| `users` | `users_pkey(id)`、`users_username_key(username)`、`idx_users_username` |

方案 §2.4 的 5 个索引名均不存在；实际索引覆盖 `created_at` 与 `user_id` 单列过滤，但**没有** `(user_id, created_at)` / `(model_name, created_at)` 复合索引。

### 3.5 保留区间

| 表 | MIN(created_at) | MAX(created_at) | 覆盖 | 规模 |
|---|---|---|---|---|
| `quota_data` | 2026-08-06 03:00 UTC | 2026-11-11 04:00 UTC | ~97 天 | 8,459 行 / 2.1 MB |
| `logs` | 2026-08-06 03:27 UTC | 2026-11-11 04:05 UTC | ~97 天 | ~545k 行 / 497 MB |

两表区间一致，未发生剪裁。

### 3.6 其它结构事实

| 项 | 结论 |
|---|---|
| schema | 三表均位于 `public` |
| `created_at` | `int8`，Unix 秒 |
| 分区 | 三表均非分区表 |
| `quota_data` 粒度 | 非严格小时唯一：近 7 天 704 个桶对应 730 行（差异来自 `use_group` / `token_id` / `channel_id` / `node_name`） |
| `users.quota` | 语义待产品确认，M1 聚合未使用 |
| 行数量级 | `quota_data` 8.4k、`logs` 545k、`users` 47 |
| 只读权限 | `INSERT` / `UPDATE` / `DELETE` / `CREATE` 断言均为 `f` |

## 4. 与方案 §2.2 的差异清单

| 编号 | 差异 | 实测 | 口径处理 |
|---|---|---|---|
| D2 | `quota_data` 缺 `prompt_tokens` / `completion_tokens` | 确认缺失 | Token 拆分取 `logs WHERE type = 2`；总量取 `max(token_used, prompt + completion)` 兼容 5 分钟延迟 |
| D4 | `logs` 含非消费记录 | 近 7 天非消费 392 行，`quota = 0` | 所有 `logs` 统计固定 `type = 2` |
| D6 | `quota_data` 非严格小时唯一 | 7 天 704 桶 / 730 行 | 请求数不得由行数推导，统一取 `logs` |
| D9 | `users.quota` 语义未定 | 全部 `status = 1` | 待产品确认；不影响聚合 |
| D10 | 方案 §2.4 索引不存在 | 索引命名与列序不同，缺复合索引 | 建索引由 DBA 按实际查询评估 |

其余核验点（`model_name` 存在、`created_at` 为 int8、schema 为 `public`、非分区、列名一致、两表保留区间一致）与方案基线一致。

## 5. 对 `src/server/schema.ts` 的校准

### 5.1 已落地

- `QuotaDataTable` 12 列（含 `count`，不含 prompt/completion）；`LogsTable` 9 列（含 `type`）；`UsersTable` 7 列（含 `display_name` / `used_quota` / `request_count`）。
- 可空性按 `information_schema.is_nullable` 声明；`created_at` 统一 `number`（Unix 秒），int8 → number 由 `db.ts` 进程级解析器完成。
- `src/server/__tests__/schema.test.ts` 锁定实测列集合与复验状态。

### 5.2 再校准规则

1. New API 升级导致列变化时，重跑附录 A，更新 `*Table` 与本文。
2. 差异影响统计口径时，先经维护者批准修改 `docs/方案.md`，再同步本文与查询实现。

### 5.3 类型映射

| PostgreSQL | TypeScript | 说明 |
|---|---|---|
| `int2` / `int4` / `int8` | `number` | int8 由 `db.ts` 注册解析器；超过 `2^53` 会丢精度 |
| `text` / `varchar` | `string` | 空串与 NULL 需按数据区分 |
| `numeric` | `string` | node-postgres 不解析 numeric |
| `boolean` | `boolean` | — |
| `timestamptz` / `timestamp` | `Date` | 当前 `created_at` 非此类型 |
| `jsonb` | `unknown` | 本看板未涉及 |

聚合口径：`SUM(bigint)` 在 PG 侧返回 `numeric`，node-postgres 默认解析为字符串。SQL 内显式 `::bigint`，Kysely 类型声明与接口契约保持一致；`COUNT(*)` 返回 int8，已按 `number` 解析。

## 6. 只读账号授权

脚本：`scripts/setup-readonly.sql`。

- 内容：方案 §2.1 的角色与权限，加写权限收紧（`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`、`REVOKE CREATE ON SCHEMA`）与角色级会话加固（只读事务、30s 语句超时、60s 空闲事务超时）。
- `ALTER DEFAULT PRIVILEGES` 仅对执行者或 `FOR ROLE` 指定角色新建的对象生效；建表角色与执行脚本角色不同时须传 `-v table_owner=<应用角色>`。
- 脚本末尾断言：三表 `SELECT = t`、`INSERT/UPDATE/DELETE = f`、schema `CREATE = f`。
- 口令只写入 `.env` 与 `psql -v` / `\password`，不进入文档与脚本。

## 7. 索引建议

脚本：`scripts/index-suggestions.sql`。

- 内容：方案 §2.4 的 5 条 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`，附现状核查、失效索引检查与回滚语句。
- `CREATE INDEX CONCURRENTLY` 不能位于事务块；中断会留下 `indisvalid = false` 的索引，需先 DROP 再重建。
- 物理从库只读，索引只能建在主库低峰窗口或独立看板库。
- 判据：对目标查询执行 `EXPLAIN (ANALYZE, BUFFERS)`，出现 `Seq Scan` 且耗时/读页随范围线性增长才建；建后复测。行数 < 约 10 万的表通常无需索引。
- 建索引会影响主库写入吞吐与复制延迟，需评估磁盘与时间预算。

## 8. 核验记录

| 日期 | 环境 | 结论 |
|---|---|---|
| 2026-11-11 | 生产主库，PostgreSQL 18.2，只读账号 | 三表列/索引/保留区间/粒度已核验；D2 / D4 / D6 / D10 成立；只读 GUC 与权限断言通过；`/api/health` 200 |

## 附录 A. 只读核验 SQL

连接后先执行：

```sql
SET default_transaction_read_only = on;
SET statement_timeout = '30s';
```

### A.1 列与类型

```sql
-- 表存在性与 schema
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_name IN ('quota_data', 'logs', 'users')
ORDER BY table_schema, table_name;

-- 列、类型、可空性
SELECT table_name, ordinal_position, column_name, data_type, udt_name,
       is_nullable, column_default, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('quota_data', 'logs', 'users')
ORDER BY table_name, ordinal_position;

-- 分区与 relkind（r = 普通表，p = 分区父表）
SELECT c.relname AS object_name,
       c.relkind,
       (pt.partrelid IS NOT NULL) AS is_partitioned,
       pt.partstrat
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname IN ('quota_data', 'logs', 'users')
ORDER BY c.relname;
```

### A.2 索引

```sql
-- 索引定义
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('quota_data', 'logs', 'users')
ORDER BY tablename, indexname;

-- 索引有效性（indisvalid = false 为 CONCURRENTLY 中断残骸）
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

### A.3 保留区间与规模

```sql
-- 精确区间与行数
SELECT 'quota_data' AS table_name, count(*) AS rows,
       to_timestamp(min(created_at)) AS min_created,
       to_timestamp(max(created_at)) AS max_created,
       round((max(created_at) - min(created_at)) / 86400.0, 1) AS span_days
FROM quota_data
UNION ALL
SELECT 'logs', count(*),
       to_timestamp(min(created_at)),
       to_timestamp(max(created_at)),
       round((max(created_at) - min(created_at)) / 86400.0, 1)
FROM logs;

-- 大表备选：估算行数与物理大小
SELECT relname, reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN ('quota_data', 'logs', 'users')
  AND relkind IN ('r', 'p')
ORDER BY relname;
```

### A.4 聚合粒度与日志成分

```sql
-- quota_data 是否严格小时唯一
SELECT count(*) AS duplicated_buckets
FROM (
  SELECT user_id, model_name, created_at / 3600 AS hour_bucket
  FROM quota_data
  WHERE created_at >= extract(epoch FROM now())::bigint - 7 * 86400
  GROUP BY 1, 2, 3
  HAVING count(*) > 1
) AS t;

-- logs 类型分布
SELECT type, count(*)::bigint
FROM logs
WHERE created_at >= extract(epoch FROM now())::bigint - 7 * 86400
GROUP BY 1
ORDER BY 2 DESC;

-- 用量总量对账
SELECT COALESCE(sum(quota), 0) AS quota_sum_7d, count(*) AS rows_7d
FROM logs
WHERE created_at >= extract(epoch FROM now())::bigint - 7 * 86400;
```

### A.5 会话加固验证

```sql
SHOW statement_timeout;
SHOW default_transaction_read_only;
SELECT current_database(), current_user, version(), pg_is_in_recovery();

SELECT has_table_privilege(current_user, 'public.quota_data', 'INSERT') AS can_insert,
       has_table_privilege(current_user, 'public.quota_data', 'UPDATE') AS can_update,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create;
```

期望：`statement_timeout = 30s`、`default_transaction_read_only = on`，写权限断言全部为 `f`。
