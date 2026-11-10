/**
 * 数据库连接层（BE-M0-02）：只读 PostgreSQL 连接池 + Kysely 实例 + 健康探活。
 *
 * 红线（方案 §0/§2.1/§9.1–§9.2）：
 * - 只读账号、优先从库；不写入、不执行 DDL、不改 schema；
 * - 类型层不暴露写入口（见 `ReadOnlyDatabase`）；
 * - 参数化查询，禁止字符串拼接 SQL（一律走 Kysely 表达式或 `sql` 模板）；
 * - 连接池上限硬约束 10–20；每连接 `statement_timeout = 30s`。
 *
 * 会话加固两层（互为兜底，任何一层生效都不会放行未加固的会话）：
 * 1. 启动参数 `options`：服务端在建连阶段即应用，原子且无额外往返；
 * 2. 池级 `verify` 钩子：新连接交付前再断言一次两个 GUC，失败即销毁连接
 *    （pg-pool 语义：verify 回传错误 → 连接被移除，不会交给调用方）。
 *    第 2 层同时覆盖「中间件/pooler 丢弃启动参数」的场景。
 */
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool, types, type PoolClient, type PoolConfig } from "pg";

import type { Database } from "./schema";

/** 连接池上限（方案 §2.1：建议 10–20）。 */
export const MIN_POOL_MAX = 10;
export const DEFAULT_POOL_MAX = 10;
export const MAX_POOL_MAX = 20;
/** 建连超时：探活端点必须有界返回。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** 空闲连接回收（长驻进程卫生；pg 默认 10s）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** 语句超时（方案 §9.2）：固定 30s，不提供 env 放宽入口。 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** `/api/health` 等待上限：超过即判 down，不让运维端点挂住。 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
/** 连接标识：便于 DBA 在 pg_stat_activity 中识别只读看板会话。 */
export const APPLICATION_NAME = "new_api_dashboard";

/**
 * int8（OID 20）默认被 pg 反序列化为字符串；本看板统计口径统一按 number 处理。
 * 进程级注册，幂等（结论来源：本卡风险项）。
 */
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

/** 配置缺失/非法：不尝试连接，直接抛出结构化错误。 */
export class DatabaseConfigError extends Error {
  readonly code = "DB_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/** 只读 env 视图（默认 `process.env`；显式注入用于单测覆盖降级分支）。 */
export type DbEnv = Readonly<Record<string, string | undefined>>;

export interface DbConnectionConfig {
  connectionString: string;
  poolMax: number;
  connectTimeoutMs: number;
}

/** 启动参数形式下发会话 GUC（服务端建连阶段应用）。 */
export const READ_ONLY_SESSION_OPTIONS = `-c statement_timeout=${DEFAULT_STATEMENT_TIMEOUT_MS} -c default_transaction_read_only=on`;

/** 会话加固语句（`verify` 钩子下发；同时是「只读 + 30s 超时」的可断言事实）。 */
export const READ_ONLY_SESSION_STATEMENTS = [
  `SET statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`,
  "SET default_transaction_read_only = on",
] as const;

/**
 * Kysely 类型层只读守卫：不声明任何写入口。
 * 想写入必须绕开 `getDb()` 直接构造 Kysely 实例——评审可见的显式越权。
 */
export type ReadOnlyDatabase = Omit<
  Kysely<Database>,
  "insertInto" | "replaceInto" | "updateTable" | "deleteFrom" | "mergeInto"
>;

interface DbHolder {
  pool: Pool;
  db: Kysely<Database>;
}

/** Next dev 热重载会重复执行模块：实例挂 globalThis，避免每轮热更新新建连接池。 */
const GLOBAL_DB_KEY = "__newApiDashboardDb__";

type GlobalWithDb = typeof globalThis & {
  [GLOBAL_DB_KEY]?: DbHolder;
};

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseConfigError(
      `${name} 必须是 ${min}–${max} 之间的整数（当前值 ${JSON.stringify(raw.slice(0, 16))}）`,
    );
  }
  return value;
}

function assertPostgresUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DatabaseConfigError(
      "DATABASE_URL 不是合法 URL，应形如 postgres://user:password@host:5432/dbname",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigError(
      `DATABASE_URL 协议必须是 postgres:// 或 postgresql://（当前为 ${parsed.protocol}//）`,
    );
  }
}

/**
 * 解析连接配置：连接串唯一来源 `DATABASE_URL`（方案 §2.1）。
 * 只读依赖调用时传入 env 快照，便于单测覆盖各降级分支。
 */
export function resolveDbConnectionConfig(
  env: DbEnv = process.env,
): DbConnectionConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new DatabaseConfigError(
      "缺少环境变量 DATABASE_URL：请在 .env 配置只读账号连接串（方案 §2.1，参考 .env.example）",
    );
  }
  assertPostgresUrl(connectionString);

  return {
    connectionString,
    poolMax: parseBoundedInt(
      env.DB_POOL_MAX,
      DEFAULT_POOL_MAX,
      "DB_POOL_MAX",
      MIN_POOL_MAX,
      MAX_POOL_MAX,
    ),
    connectTimeoutMs: parseBoundedInt(
      env.DB_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "DB_CONNECT_TIMEOUT_MS",
      100,
      60_000,
    ),
  };
}

/** 会话加固：只读事务 + 30s 语句超时（方案 §9.2）。 */
export async function applyReadOnlySession(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  for (const statement of READ_ONLY_SESSION_STATEMENTS) {
    await client.query(statement);
  }
}

/** 构造 pg 池配置（纯函数，便于单测断言红线参数）。 */
export function createPoolConfig(config: DbConnectionConfig): PoolConfig {
  return {
    connectionString: config.connectionString,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    options: READ_ONLY_SESSION_OPTIONS,
    verify: (client, done) => {
      applyReadOnlySession(client).then(
        () => done(),
        (error: unknown) =>
          done(error instanceof Error ? error : new Error(String(error))),
      );
    },
  };
}

function readHolder(): DbHolder | undefined {
  return (globalThis as GlobalWithDb)[GLOBAL_DB_KEY];
}

/**
 * 取进程内唯一的 Kysely 实例（懒创建；未配置 DATABASE_URL 时不建池，直接抛配置错误）。
 */
export function getKysely(): Kysely<Database> {
  const existing = readHolder();
  if (existing) return existing.db;

  const config = resolveDbConnectionConfig();
  const pool = new Pool(createPoolConfig(config));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  (globalThis as GlobalWithDb)[GLOBAL_DB_KEY] = { pool, db };
  return db;
}

/** 业务代码入口：只读视图，类型层无写方法。 */
export function getDb(): ReadOnlyDatabase {
  return getKysely();
}

/** 关闭并清空单例（测试、优雅退出用）。 */
export async function destroyDb(): Promise<void> {
  const holder = readHolder();
  if (!holder) return;
  delete (globalThis as GlobalWithDb)[GLOBAL_DB_KEY];
  await holder.db.destroy();
}

export interface DbHealthError {
  code: string;
  message: string;
}

export interface DbHealthResult {
  ok: boolean;
  status: "up" | "down";
  latencyMs: number;
  error?: DbHealthError;
}

/** 抹掉连接串里的账号密码，避免探活错误/日志泄漏凭据。 */
export function redactCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]*:[^/@\s]*@/g, "//***:***@");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function toHealthError(error: unknown): DbHealthError {
  if (error instanceof DatabaseConfigError) {
    return { code: error.code, message: error.message };
  }
  if (isAbortError(error)) {
    return {
      code: "DB_TIMEOUT",
      message: `数据库探活超时（>${DEFAULT_HEALTH_TIMEOUT_MS}ms）`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "DB_UNAVAILABLE", message: redactCredentials(message) };
}

/**
 * 探活：`SELECT 1` 往返 + 延迟测量；任何失败（未配置/连不上/超时）都收敛为 down，
 * 不抛出——运维端点必须自身可用。
 */
export async function checkDbHealth(
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<DbHealthResult> {
  const startedAt = performance.now();
  try {
    const db = getKysely();
    await sql`select 1`.execute(db, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: "up", latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      ok: false,
      status: "down",
      latencyMs: elapsedMs(startedAt),
      error: toHealthError(error),
    };
  }
}
