-- ============================================================================
-- scripts/seed-demo.sql —— 本地演示库建表 + 演示数据
--
-- 用途：M1 开发/联调/测试使用的本地 demo 库；表结构按 docs/db-schema-notes.md §2
--       基线（方案 §2.2 常见字段）建立，真实库复验后再校准。
--
-- 执行边界（红线）：
--   * 只允许在名为 new_api_demo 的本地演示库执行；脚本自带库名闸门，其它库直接中止。
--   * 禁止对生产库/任何从库执行：本文件含 DROP/CREATE DDL，仅 demo 库例外。
--   * 本项目不代为执行；由开发者在本地 PostgreSQL 手动运行。
--   * 结构事实未经真实库核验（见 notes §1）；差异以 notes §4 清单为准。
--
-- 用法：
--   createdb new_api_demo
--   psql "postgres://<user>@localhost:5432/new_api_demo" -v ON_ERROR_STOP=1 \
--        -f scripts/seed-demo.sql
--
-- 生成内容（确定性、可重跑）：
--   users      12 行（1 个禁用账号，用于验证状态过滤）
--   quota_data 近 30 天 · 小时桶 · 11 个启用用户 · 每用户每小时 2 个模型 ≈ 1.3 万行
--   logs       由 quota_data 拆分出的请求级记录 ≈ 3 万行
-- 全部重跑即重建，不保留旧数据。
-- ============================================================================

\set ON_ERROR_STOP on

SET TIME ZONE 'Asia/Shanghai';

-- 安全闸门：库名不匹配即中止（防止误连生产/从库）
DO $$
BEGIN
  IF current_database() <> 'new_api_demo' THEN
    RAISE EXCEPTION '拒绝执行：当前库为 %，seed-demo.sql 只允许在 new_api_demo 演示库执行', current_database();
  END IF;
END
$$;

BEGIN;

DROP TABLE IF EXISTS logs;
DROP TABLE IF EXISTS quota_data;
DROP TABLE IF EXISTS users;

-- ---------------------------------------------------------------------------
-- 表结构：与 src/server/schema.ts 的 Database 基线一一对应（未复验）
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id       bigint  PRIMARY KEY,
  username text    NOT NULL,
  status   integer NOT NULL DEFAULT 1,   -- 1 = 启用，2 = 禁用（取值口径待真实库确认）
  quota    bigint  NOT NULL DEFAULT 0
);

CREATE TABLE quota_data (
  user_id           bigint NOT NULL,
  username          text   NOT NULL,
  model_name        text   NOT NULL,
  created_at        bigint NOT NULL,     -- Unix 秒
  token_used        bigint NOT NULL DEFAULT 0,
  quota             bigint NOT NULL DEFAULT 0,
  prompt_tokens     bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0
);

CREATE TABLE logs (
  user_id           bigint NOT NULL,
  username          text   NOT NULL,
  created_at        bigint NOT NULL,     -- Unix 秒
  model_name        text   NOT NULL,
  quota             bigint NOT NULL DEFAULT 0,
  prompt_tokens     bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0
);

-- 索引与方案 §2.4 同名（demo 库可同步建；真实库建索引走 scripts/index-suggestions.sql）
CREATE INDEX idx_quota_data_created_at    ON quota_data (created_at);
CREATE INDEX idx_quota_data_user_created  ON quota_data (user_id, created_at);
CREATE INDEX idx_quota_data_model_created ON quota_data (model_name, created_at);
CREATE INDEX idx_logs_created_at          ON logs (created_at);
CREATE INDEX idx_logs_user_created        ON logs (user_id, created_at);
-- 补充建议项（非 §2.4 条文，见 notes §3.4）
CREATE INDEX idx_logs_model_created       ON logs (model_name, created_at);

-- ---------------------------------------------------------------------------
-- users：12 个账号，id = 11 为禁用账号（无用量数据）
-- ---------------------------------------------------------------------------
INSERT INTO users (id, username, status, quota)
SELECT i,
       'demo_user_' || lpad(i::text, 2, '0'),
       CASE WHEN i = 11 THEN 2 ELSE 1 END,
       1000000 - i * 12345
FROM generate_series(1, 12) AS i;

-- ---------------------------------------------------------------------------
-- quota_data：近 30 天 × 小时桶 × 启用用户 × 每用户每小时 2 个模型
--   模型 id 1–8 轮转命中，保证「多用户 / 多模型 / 跨日 / 每日活跃用户不固定」
-- ---------------------------------------------------------------------------
WITH hours AS (
  SELECT generate_series(
           date_trunc('hour', now()) - interval '29 days',
           date_trunc('hour', now()),
           interval '1 hour'
         ) AS h
),
models(mid, model_name) AS (
  VALUES (1, 'gpt-4o'),
         (2, 'gpt-4o-mini'),
         (3, 'claude-3-5-sonnet'),
         (4, 'deepseek-chat'),
         (5, 'deepseek-reasoner'),
         (6, 'qwen-max'),
         (7, 'gemini-1.5-pro'),
         (8, 'o3-mini')
),
picked AS (
  SELECT u.id AS user_id, u.username, h.h, m.mid, m.model_name
  FROM hours h
  CROSS JOIN (SELECT id, username FROM users WHERE status = 1) AS u
  CROSS JOIN models m
  WHERE m.mid IN (
          1 + ((u.id + extract(hour FROM h)::int) % 8),
          1 + ((u.id + extract(hour FROM h)::int + 3) % 8)
        )
    -- 每天约 1/7 的用户无用量：让「活跃用户数」有区分度
    AND ((u.id + extract(day FROM h)::int) % 7 <> 0)
)
INSERT INTO quota_data (
  user_id, username, model_name, created_at,
  token_used, quota, prompt_tokens, completion_tokens
)
SELECT
  p.user_id,
  p.username,
  p.model_name,
  extract(epoch FROM p.h)::bigint,
  s.prompt_tokens + s.completion_tokens,
  round((s.prompt_tokens + s.completion_tokens) * (0.8 + p.mid * 0.15))::bigint,
  s.prompt_tokens,
  s.completion_tokens
FROM picked p
CROSS JOIN LATERAL (
  SELECT
    300 + ((p.user_id * 73 + p.mid * 151 + extract(hour FROM p.h)::int * 17) % 2400) AS prompt_tokens,
    round((300 + ((p.user_id * 73 + p.mid * 151 + extract(hour FROM p.h)::int * 17) % 2400))
          * (0.2 + (p.mid % 4) * 0.1))::bigint AS completion_tokens
) AS s;

-- ---------------------------------------------------------------------------
-- logs：把每个小时桶拆成 2–3 条请求级记录（同一小时内偏移，便于 RPM/请求数口径）
--   注意：logs 基线无 token_used 列（方案 §2.2），Token 由 prompt+completion 求和。
-- ---------------------------------------------------------------------------
INSERT INTO logs (
  user_id, username, created_at, model_name, quota, prompt_tokens, completion_tokens
)
SELECT
  q.user_id,
  q.username,
  q.created_at + r.n * 600,
  q.model_name,
  q.quota / 3,
  q.prompt_tokens / 3,
  q.completion_tokens / 3
FROM quota_data q
CROSS JOIN generate_series(0, 2) AS r(n)
WHERE (q.user_id + r.n) % 4 <> 0;

COMMIT;

ANALYZE users;
ANALYZE quota_data;
ANALYZE logs;

-- ---------------------------------------------------------------------------
-- 冒烟输出（只读）：行数 / 保留区间（方案 §2.3 口径）/ 一条 §5.1 概览聚合
-- ---------------------------------------------------------------------------
SELECT 'users' AS table_name, count(*) AS row_count FROM users
UNION ALL SELECT 'quota_data', count(*) FROM quota_data
UNION ALL SELECT 'logs', count(*) FROM logs;

SELECT 'quota_data' AS table_name,
       to_timestamp(min(created_at)) AS min_created,
       to_timestamp(max(created_at)) AS max_created,
       round((max(created_at) - min(created_at)) / 86400.0, 1) AS span_days
FROM quota_data
UNION ALL
SELECT 'logs',
       to_timestamp(min(created_at)),
       to_timestamp(max(created_at)),
       round((max(created_at) - min(created_at)) / 86400.0, 1)
FROM logs;

SELECT COALESCE(sum(quota), 0) AS total_quota_30d,
       COALESCE(sum(token_used), 0) AS total_tokens_30d,
       count(DISTINCT user_id) AS active_users_30d
FROM quota_data
WHERE created_at >= extract(epoch FROM date_trunc('day', now()) - interval '29 days')::bigint;

-- ============================================================================
-- 说明：
--   * 演示数据的时间基准是「执行时刻」，每次重跑都会平移到当前窗口；
--   * 若要复现固定窗口，先 SET TIME ZONE / 调整 hours 起点即可；
--   * 真实库结构差异（缺列/类型不符）以 docs/db-schema-notes.md §4 为准，
--     不在本脚本里做兼容分支——demo 库只服务于「基线口径」的开发与测试。
-- ============================================================================
