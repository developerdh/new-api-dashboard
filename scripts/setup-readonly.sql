-- ============================================================================
-- scripts/setup-readonly.sql
-- 只读账号授权（方案 §2.1）—— 供 DBA / 用户在**目标库**执行
--
-- 执行边界（红线）：
--   * 本项目不执行本脚本：看板只读访问，不建角色、不改权限、不做 DDL（方案 §0/§2.1）；
--   * 由 DBA 在目标库执行；角色/默认权限属库级治理，执行时机与审批走用户侧流程；
--   * 幂等：角色已存在时不重建，只补授权与收敛权限，可重复执行。
--
-- 用法（Windows cmd 的 ^ 为续行符；bash/PowerShell 换成 \ 或整行输入）：
--   psql "host=<db-host> port=5432 dbname=<db> user=<admin>" ^
--        -v role_name=dashboard_readonly ^
--        -v role_password=<strong-password> ^
--        -v table_owner=<new_api_app_role> ^
--        -f scripts/setup-readonly.sql
--
-- 参数说明：
--   role_name      看板只读角色名（与 .env 的 DATABASE_URL 用户一致）。
--   role_password  强口令。注意：CREATE/ALTER ROLE 语句在服务端 log_statement=all
--                  时会被记入日志；更高安全要求下请省略本参数，改用文末「交互式设密」。
--   table_owner    New API 应用/迁移所用建表角色（可省略）。
--                  ALTER DEFAULT PRIVILEGES 只对「执行者或 FOR ROLE 指定角色」新建的
--                  对象生效；省略时未来新表不会自动获得 SELECT（见步骤 4 注释）。
-- ============================================================================

\set ON_ERROR_STOP on

\if :{?role_password}
\else
  \echo 'FATAL: 缺少 -v role_password=<强口令>；或按文末「交互式设密」改走 \password。'
  \q
\endif

BEGIN;

-- 1) 角色（幂等：不存在才建）
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec

-- 2) 连接与 schema 使用（方案 §2.1 原文）
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'role_name')
\gexec
GRANT USAGE ON SCHEMA public TO :"role_name";

-- 3) 现有对象：只给 SELECT（覆盖表/视图/物化视图/外部表）
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"role_name";

-- 4) 未来对象：默认权限。
--    注意：不带 FOR ROLE 时只对「当前执行者」新建的表生效；New API 建表角色不是执行者时
--    必须传 table_owner，否则升级新增的表会在看板侧报 permission denied。
\if :{?table_owner}
ALTER DEFAULT PRIVILEGES FOR ROLE :"table_owner" IN SCHEMA public
  GRANT SELECT ON TABLES TO :"role_name";
\else
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO :"role_name";
\endif

-- 5) 最小权限收敛（防御性）：角色若此前被授过写权限则收回。
--    仅能收回「当前执行者或其所属角色授出的」权限；其余需由对应 grantor 处理。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM :"role_name";
REVOKE CREATE ON SCHEMA public FROM :"role_name";
ALTER ROLE :"role_name" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- 6) 角色级会话加固（与 src/server/db.ts 的启动参数/池级 verify 互为兜底）
--    连接层硬约束：default_transaction_read_only=on、statement_timeout=30s（方案 §9.2）。
ALTER ROLE :"role_name" SET default_transaction_read_only = on;
ALTER ROLE :"role_name" SET statement_timeout = '30s';
ALTER ROLE :"role_name" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE :"role_name" SET search_path = public, pg_catalog;

COMMIT;

-- 7) 执行后断言（只读）：期望 can_* = t，can_write_* = f
SELECT r.rel AS relation,
       CASE WHEN to_regclass(r.rel) IS NULL THEN NULL
            ELSE has_table_privilege(:'role_name', r.rel, 'SELECT') END AS can_select,
       CASE WHEN to_regclass(r.rel) IS NULL THEN NULL
            ELSE has_table_privilege(:'role_name', r.rel, 'INSERT') END AS can_insert,
       CASE WHEN to_regclass(r.rel) IS NULL THEN NULL
            ELSE has_table_privilege(:'role_name', r.rel, 'UPDATE') END AS can_update,
       CASE WHEN to_regclass(r.rel) IS NULL THEN NULL
            ELSE has_table_privilege(:'role_name', r.rel, 'DELETE') END AS can_delete
FROM unnest(ARRAY['public.quota_data', 'public.logs', 'public.users']) AS r(rel);

SELECT has_database_privilege(:'role_name', current_database(), 'CONNECT') AS can_connect,
       has_schema_privilege(:'role_name', 'public', 'USAGE') AS can_use_public,
       has_schema_privilege(:'role_name', 'public', 'CREATE') AS can_create_in_public,
       (SELECT count(*) FROM pg_roles WHERE rolname = :'role_name') AS role_rows;

\echo '完成：请到真实库执行 docs/db-schema-notes.md 附录 A 的只读核验 SQL，回填 §3 事实表。'

-- ============================================================================
-- 交互式设密（替代 -v role_password 的高安全路径）：
--   psql> \password dashboard_readonly
-- 已存在角色的口令重置不写进本脚本（避免误改）；需要时单独执行上述命令。
-- 回滚（撤销看板账号，按需手动执行）：
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dashboard_readonly;
--   REVOKE ALL ON SCHEMA public FROM dashboard_readonly;
--   REVOKE CONNECT ON DATABASE <db> FROM dashboard_readonly;
--   DROP ROLE IF EXISTS dashboard_readonly;
-- ============================================================================
