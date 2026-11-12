/**
 * 全局总览查询（方案 §3.1、§5.1；2026-11-11 真实库复验后校准）。
 *
 * SQL 口径：
 * - quota_data 聚合：`COALESCE(SUM(quota/token_used), 0)::bigint`（真实库无 prompt/completion 列）；
 * - 请求数 + Token 拆分：logs `type = 2`（消费流水）聚合 `COUNT(*) / SUM(prompt_tokens) / SUM(completion_tokens)`；
 * - 活跃用户 / 模型数：`COUNT(DISTINCT user_id/model_name)`，取 quota_data 的范围口径。
 *
 * 数值类型说明（docs/db-schema-notes.md §5.3）：PG 的 `SUM(bigint)` 返回 numeric，
 * node-postgres 默认解析为 string；这里统一 `::bigint`，由 `db.ts` 注册的 int8 解析器转 number。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import {
  EXCLUDE_STAT_USERS_SQL,
  LOG_TYPE_CONSUME,
  type QueryRange,
} from "@/server/queries/common";

/** 总览响应体（方案 §3.1：消耗、请求数、Token 拆分、活跃用户、模型数）。 */
export interface OverviewSnapshot {
  totalQuota: number;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  activeUsers: number;
  modelCount: number;
}

/** quota_data 聚合行（列别名与 SQL 对齐）。 */
export interface QuotaAggregateRow {
  total_quota: number;
  total_tokens: number;
  active_users: number;
  model_count: number;
}

/** logs 消费聚合行（请求数 + Token 拆分）。 */
export interface RequestCountRow {
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** quota_data 聚合查询（§5.1 前半段）。 */
export function buildQuotaAggregateQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("quota_data")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COUNT(DISTINCT user_id)::bigint`.as("active_users"),
      sql<number>`COUNT(DISTINCT model_name)::bigint`.as("model_count"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** logs 消费流水聚合（§5.1 后半段 + Token 拆分）。 */
export function buildRequestCountQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      sql<number>`COUNT(*)::bigint`.as("request_count"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
    ])
    .where("type", "=", LOG_TYPE_CONSUME)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** 空结果/异常值兜底：整数化，非有限值记 0（空区间必须返回全 0，不能返回 null）。 */
function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/** 聚合行 → 响应体（拆出来便于无库单测「空区间全 0」）。 */
export function toOverviewSnapshot(
  quotaRow: QuotaAggregateRow | undefined,
  logRow: RequestCountRow | undefined,
): OverviewSnapshot {
  const promptTokens = toInteger(logRow?.prompt_tokens);
  const completionTokens = toInteger(logRow?.completion_tokens);
  return {
    totalQuota: toInteger(quotaRow?.total_quota),
    requestCount: toInteger(logRow?.request_count),
    // Token 总量取 quota_data.token_used 与 logs 拆分和的较大值：
    // quota_data 最多延迟 5 分钟，当前桶内 logs 通常更大；聚合完成后两者一致。
    totalTokens: Math.max(toInteger(quotaRow?.total_tokens), promptTokens + completionTokens),
    promptTokens,
    completionTokens,
    activeUsers: toInteger(quotaRow?.active_users),
    modelCount: toInteger(quotaRow?.model_count),
  };
}

/** 执行两条聚合（并发）；任一失败向调用方抛出，由路由收敛为 500 `query_failed`。 */
export async function runOverviewQuery(
  range: QueryRange,
  db: ReadOnlyDatabase = getDb(),
): Promise<OverviewSnapshot> {
  const [quotaRow, logRow] = await Promise.all([
    buildQuotaAggregateQuery(db, range).executeTakeFirst(),
    buildRequestCountQuery(db, range).executeTakeFirst(),
  ]);
  return toOverviewSnapshot(quotaRow as QuotaAggregateRow | undefined, logRow as RequestCountRow | undefined);
}
