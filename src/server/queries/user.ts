/**
 * 用户查询（排行 / 单用户统计；方案 §3.3、§5.5–§5.7）。
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
  EXCLUDE_STAT_USERS_SQL,
  LOG_TYPE_CONSUME,
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
import { loadUserIdentities, loadUserIdentity } from "@/server/queries/user-directory";

/** limit 缺省 20、上限 100（§4 收紧口径，卡内定稿）。 */
export const RANKING_DEFAULT_LIMIT = 20;
export const RANKING_MAX_LIMIT = 100;

/** 响应行。`displayName` 为 users.display_name（昵称），查询未补齐时缺省、展示层回落账号。）*/
export interface UserRankingRow {
  userId: number;
  username: string;
  displayName?: string;
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
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      "user_id",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "is not", null)
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
    .where(EXCLUDE_STAT_USERS_SQL)
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
    .where(EXCLUDE_STAT_USERS_SQL)
    .select(["user_id", sql<number>`COUNT(*)::bigint`.as("request_count")])
    .where("type", "=", LOG_TYPE_CONSUME)
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
    if (!nameByUser.has(userId)) nameByUser.set(userId, row.username ?? "");
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

/**
 * 执行排行查询：先取 Top N 用户，再并发取名称、请求数与 users 昵称；Top N 为空时不再发后续查询。
 * 昵称来自 users.display_name（权威当前值），与 quota_data 里可能过期的 username 分开返回。
 */
export async function runUserRankingQuery(
  range: QueryRange,
  limit: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<UserRankingRow[]> {
  const totals = (await buildRankingTotalsQuery(db, range, limit).execute()) as RankingTotalsRow[];
  if (totals.length === 0) return [];

  const userIds = totals.map((row) => toInteger(row.user_id));
  const [names, requests, identities] = await Promise.all([
    buildRankingNamesQuery(db, range, userIds).execute() as Promise<RankingNameRow[]>,
    buildRankingRequestsQuery(db, range, userIds).execute() as Promise<RankingRequestRow[]>,
    loadUserIdentities(userIds, db),
  ]);

  return assembleUserRanking(totals, names, requests, limit).map((row) => ({
    ...row,
    displayName: identities.get(row.userId)?.displayName ?? "",
  }));
}

/* ------------------------------------------------------------------ */
/* 单用户统计                                              */
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
  /**
   * 用户身份（users 表当前值），由 `runUserOverviewQuery` 补齐，供详情页标题展示昵称。
   * 用户不存在时为空串而非省略 —— 保持响应形状一致，不泄露用户存在性。
   * 可选声明仅为兼容不含身份的纯统计快照（如 `toUserOverviewSnapshot` 单测夹具）。
   */
  username?: string;
  displayName?: string;
}

export interface UserOverviewRow {
  total_quota: number;
  total_tokens: number;
  active_days: number;
}

export interface UserRequestCountRow {
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
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
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COUNT(DISTINCT (created_at + 28800) / 86400)::bigint`.as("active_days"),
    ])
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);
}

/** 单用户请求数 + Token 拆分（logs 消费流水）。 */
export function buildUserRequestCountQuery(
  db: ReadOnlyDatabase,
  userId: number,
  range: QueryRange,
) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      sql<number>`COUNT(*)::bigint`.as("request_count"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
    ])
    .where("type", "=", LOG_TYPE_CONSUME)
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
    totalTokens: Math.max(
      toInteger(row?.total_tokens),
      toInteger(logRow?.prompt_tokens) + toInteger(logRow?.completion_tokens),
    ),
    promptTokens: toInteger(logRow?.prompt_tokens),
    completionTokens: toInteger(logRow?.completion_tokens),
    requestCount: toInteger(logRow?.request_count),
    activeDays: toInteger(row?.active_days),
  };
}

/** 执行单用户总览查询（quota_data 聚合 + logs 计数 + users 身份，并发）。 */
export async function runUserOverviewQuery(
  userId: number,
  range: QueryRange,
  db: ReadOnlyDatabase = getDb(),
): Promise<UserOverviewSnapshot> {
  const [quotaRow, logRow, identity] = await Promise.all([
    buildUserOverviewQuery(db, userId, range).executeTakeFirst(),
    buildUserRequestCountQuery(db, userId, range).executeTakeFirst(),
    loadUserIdentity(userId, db),
  ]);
  return {
    ...toUserOverviewSnapshot(
      quotaRow as UserOverviewRow | undefined,
      logRow as UserRequestCountRow | undefined,
    ),
    username: identity?.username ?? "",
    displayName: identity?.displayName ?? "",
  };
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

/** quota_data 侧模型聚合（额度 / token_used）。 */
export interface UserModelQuotaRow {
  model_name: string;
  total_quota: number;
  total_tokens: number;
}

/** logs 消费侧模型 Token 拆分。 */
export interface UserModelTokenRow {
  model_name: string;
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
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
    ])
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("model_name", "is not", null)
    .groupBy("model_name")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc")
    .orderBy("model_name", "asc");
}

/** logs 消费侧按 model 聚合 Token 拆分（§5.6 的 prompt/completion，quota_data 无此列）。 */
export function buildUserModelTokensQuery(
  db: ReadOnlyDatabase,
  userId: number,
  range: QueryRange,
) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      "model_name",
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
    ])
    .where("type", "=", LOG_TYPE_CONSUME)
    .where("user_id", "=", userId)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("model_name", "is not", null)
    .groupBy("model_name");
}

/** 合并 quota 聚合与 logs Token 拆分（按 model_name；缺失补 0）。 */
export function mergeUserModelTokens(
  quotaRows: UserModelQuotaRow[],
  tokenRows: UserModelTokenRow[],
): UserModelAggregateRow[] {
  const tokensByModel = new Map<string, UserModelTokenRow>();
  for (const row of tokenRows) tokensByModel.set(row.model_name, row);

  return quotaRows.map((row) => {
    const tokens = tokensByModel.get(row.model_name);
    const promptTokens = tokens?.prompt_tokens ?? 0;
    const completionTokens = tokens?.completion_tokens ?? 0;
    return {
      model_name: row.model_name,
      total_quota: row.total_quota,
      // 与总览一致：quota_data.token_used 有 ≤5 分钟延迟，取与拆分和的较大值
      total_tokens: Math.max(row.total_tokens, promptTokens + completionTokens),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    };
  });
}

function shareOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((part / total).toFixed(4));
}

/**
 * 模型聚合行 → 响应行（附 Token 占比）。
 * 占比分母为 logs 的 prompt+completion（拆分口径一致）；totalTokens 仍取 quota_data.token_used，
 * 两者可能有最多 5 分钟延迟差（已在 docs/db-schema-notes.md §4 记录）。
 */
export function toUserModels(rows: UserModelAggregateRow[]): UserModelRow[] {
  return rows.map((row) => {
    const totalTokens = toInteger(row.total_tokens);
    const promptTokens = toInteger(row.prompt_tokens);
    const completionTokens = toInteger(row.completion_tokens);
    const splitTotal = promptTokens + completionTokens;
    return {
      modelName: row.model_name,
      totalQuota: toInteger(row.total_quota),
      totalTokens,
      promptTokens,
      completionTokens,
      promptShare: shareOf(promptTokens, splitTotal),
      completionShare: shareOf(completionTokens, splitTotal),
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
 * 最近使用记录：该用户最近 50 条**消费** logs（`created_at DESC`）。
 * 口径定稿：不按查询区间过滤（「最近使用」是全局最近记录），固定 LIMIT 50。
 */
export function buildUserRecentQuery(
  db: ReadOnlyDatabase,
  userId: number,
  limit: number = USER_RECENT_LIMIT,
) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select(["created_at", "model_name", "quota", "prompt_tokens", "completion_tokens"])
    .where("type", "=", LOG_TYPE_CONSUME)
    .where("user_id", "=", userId)
    .where("model_name", "is not", null)
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

/** 执行单用户模型分布 + 最近记录（并发；Token 拆分来自 logs）。 */
export async function runUserModelsQuery(
  userId: number,
  range: QueryRange,
  db: ReadOnlyDatabase = getDb(),
): Promise<{ models: UserModelRow[]; recent: UserRecentRow[] }> {
  const [quotaRows, tokenRows, recentRows] = await Promise.all([
    buildUserModelsQuery(db, userId, range).execute() as Promise<UserModelQuotaRow[]>,
    buildUserModelTokensQuery(db, userId, range).execute() as Promise<UserModelTokenRow[]>,
    buildUserRecentQuery(db, userId).execute() as Promise<UserRecentDbRow[]>,
  ]);
  return {
    models: toUserModels(mergeUserModelTokens(quotaRows, tokenRows)),
    recent: toUserRecent(recentRows),
  };
}
