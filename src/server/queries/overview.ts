/**
 * 全局总览查询（BE-M1-02 / 方案 §3.1、§5.1）。
 *
 * SQL 口径（只读、参数化）：
 * - quota_data 聚合：`COALESCE(SUM(quota/token_used/prompt_tokens/completion_tokens), 0)::bigint`；
 * - 请求数：`COUNT(*) FROM logs`（quota_data 有最多 5 分钟延迟，精确请求数走原始日志）；
 * - 活跃用户 / 模型数：`COUNT(DISTINCT user_id/model_name)`，取 quota_data 的范围口径。
 *
 * 数值类型说明（docs/db-schema-notes.md §5.3）：PG 的 `SUM(bigint)` 返回 numeric，
 * node-postgres 默认解析为 string；这里统一 `::bigint`，由 `db.ts` 注册的 int8 解析器转 number。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import type { QueryRange } from "@/server/queries/common";

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
  prompt_tokens: number;
  completion_tokens: number;
  active_users: number;
  model_count: number;
}

/** logs 计数行。 */
export interface RequestCountRow {
  request_count: number;
}

/** quota_data 聚合查询（§5.1 前半段）。 */
export function buildQuotaAggregateQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("quota_data")
    .select([
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
      sql<number>`COUNT(DISTINCT user_id)::bigint`.as("active_users"),
      sql<number>`COUNT(DISTINCT model_name)::bigint`.as("model_count"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** logs 请求数查询（§5.1 后半段）。 */
export function buildRequestCountQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("logs")
    .select(sql<number>`COUNT(*)::bigint`.as("request_count"))
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
  return {
    totalQuota: toInteger(quotaRow?.total_quota),
    requestCount: toInteger(logRow?.request_count),
    totalTokens: toInteger(quotaRow?.total_tokens),
    promptTokens: toInteger(quotaRow?.prompt_tokens),
    completionTokens: toInteger(quotaRow?.completion_tokens),
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
