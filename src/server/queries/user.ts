/**
 * 用户查询（BE-M1-04 排行 / BE-M1-05 单用户统计；方案 §3.3、§5.5–§5.7）。
 *
 * - 排行：按 user_id 聚合 Top N；username 取区间内消耗最大的名称；请求数二次查询。
 * - 单用户 overview：区间聚合 + 活跃天数（东八区自然日去重）；请求数走 logs。
 * - 单用户 trend：复用 trend 模块的分桶 SQL 与合并逻辑（带 userId 过滤）。
 * - 单用户 models：§5.6 模型分布 + 行内 Token 占比 + 最近 50 条使用记录。
 *
 * 数值类型：`SUM(...)::bigint` / `COUNT(*)::bigint`，由 `db.ts` 的 int8 解析器转 number（notes §5.3）。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import {
  QueryValidationError,
  type Granularity,
  type QueryRange,
} from "@/server/queries/common";
import {
  buildTrendQuotaQuery,
  buildTrendRequestQuery,
  mergeTrendRows,
  type TrendBucketData,
  type TrendLogRow,
  type TrendQuotaRow,
} from "@/server/queries/trend";

/** limit 缺省 20、上限 100（§4 收紧口径，卡内定稿）。 */
export const RANKING_DEFAULT_LIMIT = 20;
export const RANKING_MAX_LIMIT = 100;

/** 响应行。 */
export interface UserRankingRow {
  userId: number;
  username: string;
  totalQuota: number;
  totalTokens: number;
  requestCount: number;
}

export interface RankingTotalsRow {
  user_id: number;
  total_quota: number;
  total_tokens: number;
}

export interface RankingNameRow {
  user_id: number;
  username: string;
  name_quota: number;
}

export interface RankingRequestRow {
  user_id: number;
  request_count: number;
}

function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/** Top N 用户消耗聚合（§5.7 的聚合部分；username 另行取值以处理改名）。 */
export function buildRankingTotalsQuery(db: ReadOnlyDatabase, range: QueryRange, limit: number) {
  return db
    .selectFrom("quota_data")
    .select([
      "user_id",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .groupBy("user_id")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc")
    .orderBy("user_id", "asc")
    .limit(limit);
}

/** 入选用户的名称候选：按 (user_id, username) 聚合，消耗高的排前面（JS 取每条首个）。 */
export function buildRankingNamesQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  userIds: number[],
) {
  return db
    .selectFrom("quota_data")
    .select([
      "user_id",
      "username",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("name_quota"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "in", userIds)
    .groupBy(["user_id", "username"])
    .orderBy("user_id", "asc")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc");
}

/** 入选用户的请求数（logs 按 user_id 聚合）。 */
export function buildRankingRequestsQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  userIds: number[],
) {
  return db
    .selectFrom("logs")
    .select(["user_id", sql<number>`COUNT(*)::bigint`.as("request_count")])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "in", userIds)
    .groupBy("user_id");
}

/**
 * 合并三次查询结果为排行行：
 * - 顺序以 totals 为准（已是消耗降序 + user_id 升序）；
 * - username 取 names 中该用户的首条（names 已按 user_id, name_quota desc 排序）；
 * - 请求数缺失记 0。
 */
export function assembleUserRanking(
  totals: RankingTotalsRow[],
  names: RankingNameRow[],
  requests: RankingRequestRow[],
  limit: number,
): UserRankingRow[] {
  const nameByUser = new Map<number, string>();
  for (const row of names) {
    const userId = toInteger(row.user_id);
    if (!nameByUser.has(userId)) nameByUser.set(userId, row.username);
  }

  const requestsByUser = new Map<number, number>();
  for (const row of requests) {
    requestsByUser.set(toInteger(row.user_id), toInteger(row.request_count));
  }

  return totals.slice(0, limit).map((row) => {
    const userId = toInteger(row.user_id);
    return {
      userId,
      username: nameByUser.get(userId) ?? "",
      totalQuota: toInteger(row.total_quota),
      totalTokens: toInteger(row.total_tokens),
      requestCount: requestsByUser.get(userId) ?? 0,
    };
  });
}

/** 执行排行查询：先取 Top N 用户，再并发取名称与请求数；Top N 为空时不再发后续查询。 */
export async function runUserRankingQuery(
  range: QueryRange,
  limit: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<UserRankingRow[]> {
  const totals = (await buildRankingTotalsQuery(db, range, limit).execute()) as RankingTotalsRow[];
  if (totals.length === 0) return [];

  const userIds = totals.map((row) => toInteger(row.user_id));
  const [names, requests] = await Promise.all([
    buildRankingNamesQuery(db, range, userIds).execute() as Promise<RankingNameRow[]>,
    buildRankingRequestsQuery(db, range, userIds).execute() as Promise<RankingRequestRow[]>,
  ]);

  return assembleUserRanking(totals, names, requests, limit);
}

/* ------------------------------------------------------------------ */
/* 单用户统计（BE-M1-05）                                              */
/* ------------------------------------------------------------------ */

/** 数据来源标注（quota_data 聚合 + logs 请求数/最近记录）。 */
export const USER_DETAIL_SOURCE = "quota_data+logs" as const;

/** 最近使用记录条数上限（§3.3「最近使用记录」）。 */
export const USER_RECENT_LIMIT = 50;

/**
 * 路径参数 `id` 解析：只接受十进制正整数（安全整数）；非法抛 400 语义（issues.path=id）。
 * 注意：用户不存在不是 400/404——由查询返回空数据，避免探测用户存在性。
 */
export function parseUserId(raw: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new QueryValidationError([{ path: "id", message: "用户 id 必须是正整数" }]);
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new QueryValidationError([{ path: "id", message: "用户 id 必须是正整数" }]);
  }
  return id;
}

export interface UserOverviewSnapshot {
  totalQuota: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  /** 区间内活跃天数（东八区自然日去重）。 */
  activeDays: number;
}

export interface UserOverviewRow {
  total_quota: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  active_days: number;
}

export interface UserRequestCountRow {
  request_count: number;
}

/**
 * 单用户区间聚合（§5.5 的聚合部分 + 活跃天数）。
 * 活跃天数口径：`COUNT(DISTINCT (created_at + 28800) / 86400)`（东八区自然日，整数分桶；
 * 东八区自 1991 年后无夏令时，卡内定稿口径）。
 */
export function buildUserOverviewQuery(
  db: ReadOnlyDatabase,
  userId: number,
  range: QueryRange,
) {
  return db
    .selectFrom("quota_data")
    .select([
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
      sql<number>`COUNT(DISTINCT (created_at + 28800) / 86400)::bigint`.as("active_days"),
    ])
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** 单用户请求数（logs）。 */
export function buildUserRequestCountQuery(
  db: ReadOnlyDatabase,
  userId: number,
  range: QueryRange,
) {
  return db
    .selectFrom("logs")
    .select(sql<number>`COUNT(*)::bigint`.as("request_count"))
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** 聚合行 → 响应体：缺失/空区间补 0，不返回 null。 */
export function toUserOverviewSnapshot(
  row: UserOverviewRow | undefined,
  logRow: UserRequestCountRow | undefined,
): UserOverviewSnapshot {
  return {
    totalQuota: toInteger(row?.total_quota),
    totalTokens: toInteger(row?.total_tokens),
    promptTokens: toInteger(row?.prompt_tokens),
    completionTokens: toInteger(row?.completion_tokens),
    requestCount: toInteger(logRow?.request_count),
    activeDays: toInteger(row?.active_days),
  };
}

/** 执行单用户总览查询（quota_data 聚合 + logs 计数并发）。 */
export async function runUserOverviewQuery(
  userId: number,
  range: QueryRange,
  db: ReadOnlyDatabase = getDb(),
): Promise<UserOverviewSnapshot> {
  const [quotaRow, logRow] = await Promise.all([
    buildUserOverviewQuery(db, userId, range).executeTakeFirst(),
    buildUserRequestCountQuery(db, userId, range).executeTakeFirst(),
  ]);
  return toUserOverviewSnapshot(
    quotaRow as UserOverviewRow | undefined,
    logRow as UserRequestCountRow | undefined,
  );
}

/** 单用户趋势：复用 trend 分桶 SQL 与合并逻辑（带 userId 过滤）。 */
export async function loadUserTrendSeries(
  range: QueryRange,
  granularity: Granularity,
  userId: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<Map<number, TrendBucketData>> {
  const [quotaRows, logRows] = await Promise.all([
    buildTrendQuotaQuery(db, range, granularity, userId).execute(),
    buildTrendRequestQuery(db, range, granularity, userId).execute(),
  ]);
  return mergeTrendRows(quotaRows as TrendQuotaRow[], logRows as TrendLogRow[]);
}

export interface UserModelRow {
  modelName: string;
  totalQuota: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** token_used 中 prompt 占比（0–1，保留 4 位；分母为 0 时记 0）。 */
  promptShare: number;
  /** token_used 中 completion 占比（0–1，保留 4 位；分母为 0 时记 0）。 */
  completionShare: number;
}

export interface UserModelAggregateRow {
  model_name: string;
  total_quota: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** §5.6 单用户模型分布：按 model_name 聚合、消耗降序（model_name 兜底保证稳定）。 */
export function buildUserModelsQuery(
  db: ReadOnlyDatabase,
  userId: number,
  range: QueryRange,
) {
  return db
    .selectFrom("quota_data")
    .select([
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
    ])
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .groupBy("model_name")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc")
    .orderBy("model_name", "asc");
}

function shareOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((part / total).toFixed(4));
}

/** 模型聚合行 → 响应行（附 Token 占比；分母为 0 记 0，不产生 NaN）。 */
export function toUserModels(rows: UserModelAggregateRow[]): UserModelRow[] {
  return rows.map((row) => {
    const totalTokens = toInteger(row.total_tokens);
    const promptTokens = toInteger(row.prompt_tokens);
    const completionTokens = toInteger(row.completion_tokens);
    return {
      modelName: row.model_name,
      totalQuota: toInteger(row.total_quota),
      totalTokens,
      promptTokens,
      completionTokens,
      promptShare: shareOf(promptTokens, totalTokens),
      completionShare: shareOf(completionTokens, totalTokens),
    };
  });
}

export interface UserRecentRow {
  createdAt: number;
  modelName: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UserRecentDbRow {
  created_at: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * 最近使用记录：该用户最近 50 条 logs（`created_at DESC`）。
 * 口径定稿：不按查询区间过滤（「最近使用」是全局最近记录），固定 LIMIT 50。
 */
export function buildUserRecentQuery(
  db: ReadOnlyDatabase,
  userId: number,
  limit: number = USER_RECENT_LIMIT,
) {
  return db
    .selectFrom("logs")
    .select(["created_at", "model_name", "quota", "prompt_tokens", "completion_tokens"])
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .limit(limit);
}

export function toUserRecent(rows: UserRecentDbRow[]): UserRecentRow[] {
  return rows.map((row) => ({
    createdAt: toInteger(row.created_at),
    modelName: row.model_name,
    quota: toInteger(row.quota),
    promptTokens: toInteger(row.prompt_tokens),
    completionTokens: toInteger(row.completion_tokens),
  }));
}

/** 执行单用户模型分布 + 最近记录（并发）。 */
export async function runUserModelsQuery(
  userId: number,
  range: QueryRange,
  db: ReadOnlyDatabase = getDb(),
): Promise<{ models: UserModelRow[]; recent: UserRecentRow[] }> {
  const [modelRows, recentRows] = await Promise.all([
    buildUserModelsQuery(db, userId, range).execute() as Promise<UserModelAggregateRow[]>,
    buildUserRecentQuery(db, userId).execute() as Promise<UserRecentDbRow[]>,
  ]);
  return { models: toUserModels(modelRows), recent: toUserRecent(recentRows) };
}
