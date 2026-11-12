-- ============================================================================
-- scripts/index-suggestions.sql
-- 查询索引建议清单（方案 §2.4）—— 清单交付，**本项目不执行**
--
-- 执行边界：
--   * 本项目只出清单与判据；是否建、在哪建、何时建属用户/DBA 的运维决策；
--   * CREATE INDEX CONCURRENTLY 不能跑在事务块里：用 psql -f 逐条执行（自动提交），
--     不要包 BEGIN/COMMIT，也不要放进迁移框架的事务批次；
--   * 物理从库（pg_is_in_recovery() = true）是只读副本，**无法建索引**；
--     方案 §2.4「在从库或独立看板库处理」的实际落点 = 主库低峰窗口，或独立看板库；
--   * 本清单不含 BEGIN/COMMIT，且全部 IF NOT EXISTS，重跑安全。
--
-- 执行前提（缺一不建）：
--   1. 现有索引未覆盖同等前缀（先跑步骤 0 核查）；
--   2. EXPLAIN (ANALYZE, BUFFERS) 实测显示相关查询走 Seq Scan 且耗时不可接受；
--   3. 已评估主库写入放大、CONCURRENTLY 期间的磁盘与时间开销、长事务阻塞。
--
-- 覆盖查询：方案 §5.1–§5.8（概览/天周月趋势/单用户/用户排行/RPM）
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 步骤 0：现状核查（只读，先看清再建）
-- ---------------------------------------------------------------------------

-- 0.1 三表现有索引（与下面清单比对名称与列序）
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('quota_data', 'logs', 'users')
ORDER BY tablename, indexname;

-- 0.2 失效索引（CONCURRENTLY 中断会留下 indisvalid = false 的残骸，需先 DROP 再重建）
SELECT t.relname AS table_name,
       c.relname AS index_name,
       i.indisvalid,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN ('quota_data', 'logs', 'users')
  AND NOT i.indisvalid;

-- 0.3 载体确认：物理从库只读，不能建索引
SELECT pg_is_in_recovery() AS is_standby,
       current_database() AS database,
       (SELECT count(*) FROM pg_class WHERE relname IN ('quota_data', 'logs', 'users')) AS target_tables;

-- 0.4 规模估算（决定是否值得建：小表顺序扫描往往更快）
SELECT relname,
       reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class
WHERE relname IN ('quota_data', 'logs', 'users')
  AND relkind IN ('r', 'p')
ORDER BY relname;

-- ---------------------------------------------------------------------------
-- 步骤 1：方案 §2.4 原列 5 条（逐条对应 §5 查询）
-- ---------------------------------------------------------------------------

-- 时间范围过滤：§5.1 概览、§5.2–§5.4 趋势、§5.8 RPM
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_data_created_at
  ON quota_data (created_at);

-- 单用户时间范围：§5.5 单用户趋势、§5.6 单用户模型分布
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_data_user_created
  ON quota_data (user_id, created_at);

-- 模型时间范围：§3.4 模型趋势/排行（quota_data 侧）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quota_data_model_created
  ON quota_data (model_name, created_at);

-- 日志时间范围：§5.1 请求数、§5.8 RPM、实时指标
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_created_at
  ON logs (created_at);

-- 单用户日志：单用户请求数/最近使用记录
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_user_created
  ON logs (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 步骤 2：补充建议（**非方案 §2.4 条文**，执行与否由用户/运维决策）
--   背景：方案 §2.4 共 5 条索引，此处补充第 6 条（差异见
--   docs/db-schema-notes.md §3.4）。若模型维度直接从 logs 取
--   （精确请求数/平均单请求成本），需要下面的组合索引；若模型维度只走
--   quota_data，则不必建。
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_model_created
  ON logs (model_name, created_at);

-- ---------------------------------------------------------------------------
-- 步骤 3：执行后核查
-- ---------------------------------------------------------------------------
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx!_%' ESCAPE '!'
ORDER BY tablename, indexname;

-- 至少应为 6 行（若库里另有 idx_ 前缀索引会更多）；若某条缺失或 indisvalid = false，
-- 重跑步骤 0.2 后单独重建该条。

-- ---------------------------------------------------------------------------
-- 回滚（按需手动执行；同样不能放在事务块里）
-- ---------------------------------------------------------------------------
-- DROP INDEX CONCURRENTLY IF EXISTS idx_logs_model_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_logs_user_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_logs_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_quota_data_model_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_quota_data_user_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_quota_data_created_at;

-- ============================================================================
-- 判据（实测口径，写入执行报告/复验记录时附数据）：
--   * 基线：对 §5.1 近 30 天范围查询做 EXPLAIN (ANALYZE, BUFFERS)，
--     记录 Seq Scan / Index Scan 与实际耗时；
--   * 触发：Seq Scan 且 shared read 页数/耗时随范围线性增长 → 建；
--   * 复测：建完后同语句重跑，对比耗时与计划（预期 Index Scan / Bitmap Heap Scan）；
--   * 反例：quota_data/logs 行数 < ~10 万时顺序扫描可能已是最优，不建。
-- ============================================================================
