/**
 * 模型统计（BE-M1-06 / 方案 §3.4、§5.6 反向聚合）。
 *
 * - ranking：quota_data 按 model_name 聚合消耗/Token；logs 同名聚合请求数；单次平均成本在 JS 合并计算
 *   （`SUM(quota) / COUNT(logs)`，请求数为 0 时记 0，避免除零）。
 * - trend：`granularity` 桶 × model_name 序列；`models` 过滤参数（逗号分隔、≤10 个）防全量爆炸，
 *   未给时取区间内消耗 Top 10 模型。
 * - cross：Top 用户 × Top 10 模型消耗矩阵（稀疏 cells），其余模型按用户合并为 `others`
 *   （= 用户区间总消耗 − Top 模型消耗之和）。cross 为 §4 清单外增补端点，回流决议见任务卡。
 *
 * 数值类型：`SUM(...)::bigint` / `COUNT(*)::bigint`，由 `db.ts` 的 int8 解析器转 number（notes §5.3）。
 */
import { createHash } from "node:crypto";

import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import {
  MODEL_NAME_PATTERN,
  QueryValidationError,
  type Granularity,
  type QueryRange,
} from "@/server/queries/common";
import {
  bucketLabel,
  trendBucketExpression,
  trendBuckets,
} from "@/server/queries/trend";
import { runUserRankingQuery } from "@/server/queries/user";

/** 排行 limit：缺省 20、上限 100（与用户排行同级）。 */
export const MODEL_RANKING_DEFAULT_LIMIT = 20;
export const MODEL_RANKING_MAX_LIMIT = 100;

/** models 过滤参数上限；未指定时默认 Top N 模型。 */
export const MODEL_FILTER_MAX = 10;
export const MODEL_TREND_DEFAULT_MODELS = 10;
export const MODEL_CROSS_TOP_MODELS = 10;

/** 数据来源标注：quota_data 聚合 + logs 请求数。 */
export const MODEL_SOURCE = "quota_data+logs" as const;

function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/* ------------------------------------------------------------------ */
/* ranking                                                             */
/* ------------------------------------------------------------------ */

export interface ModelRankingRow {
  modelName: string;
  totalQuota: number;
  totalTokens: number;
  requestCount: number;
  /** 单次请求平均成本（quota/请求数，保留 4 位；请求数 0 时记 0）。 */
  avgCost: number;
}

export interface ModelRankingTotalsRow {
  model_name: string;
  total_quota: number;
  total_tokens: number;
}

export interface ModelRequestRow {
  model_name: string;
  request_count: number;
}

/** §3.4 模型排行主聚合：按 model_name 汇总消耗/Token，消耗降序 + model_name 兜底。 */
export function buildModelRankingTotalsQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  limit: number,
) {
  return db
    .selectFrom("quota_data")
    .select([
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .groupBy("model_name")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc")
    .orderBy("model_name", "asc")
    .limit(limit);
}

/** 入选模型的请求数（logs，IN 列表参数化）。 */
export function buildModelRankingRequestsQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  modelNames: string[],
) {
  return db
    .selectFrom("logs")
    .select(["model_name", sql<number>`COUNT(*)::bigint`.as("request_count")])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("model_name", "in", modelNames)
    .groupBy("model_name");
}

/** 合并消耗与请求数，计算平均成本（JS，避免 PG numeric→string 与除零）。 */
export function assembleModelRanking(
  totals: ModelRankingTotalsRow[],
  requests: ModelRequestRow[],
  limit: number,
): ModelRankingRow[] {
  const requestsByModel = new Map<string, number>();
  for (const row of requests) {
    requestsByModel.set(row.model_name, toInteger(row.request_count));
  }

  return totals.slice(0, limit).map((row) => {
    const totalQuota = toInteger(row.total_quota);
    const requestCount = requestsByModel.get(row.model_name) ?? 0;
    const avgCost =
      requestCount > 0 ? Number((totalQuota / requestCount).toFixed(4)) : 0;

    return {
      modelName: row.model_name,
      totalQuota,
      totalTokens: toInteger(row.total_tokens),
      requestCount,
      avgCost,
    };
  });
}

/** 执行模型排行：先取 Top N 模型，再查这些模型的请求数；Top N 为空时不再查。 */
export async function runModelRankingQuery(
  range: QueryRange,
  limit: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<ModelRankingRow[]> {
  const totals = (await buildModelRankingTotalsQuery(db, range, limit).execute()) as
    ModelRankingTotalsRow[];
  if (totals.length === 0) return [];

  const modelNames = totals.map((row) => row.model_name);
  const requests = (await buildModelRankingRequestsQuery(db, range, modelNames).execute()) as
    ModelRequestRow[];

  return assembleModelRanking(totals, requests, limit);
}

/* ------------------------------------------------------------------ */
/* models 过滤参数                                                     */
/* ------------------------------------------------------------------ */

/**
 * `models` 查询参数解析：逗号分隔、trim、去重；≤10 个；字符集沿用 `MODEL_NAME_PATTERN`。
 * 空串/未提供 → undefined（表示默认 Top N）。非法抛 400 语义（issues.path=models）。
 */
export function parseModelFilter(raw: string | null | undefined): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) return undefined;

  if (names.length > MODEL_FILTER_MAX) {
    throw new QueryValidationError([
      { path: "models", message: `models 最多 ${MODEL_FILTER_MAX} 个` },
    ]);
  }

  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!MODEL_NAME_PATTERN.test(name) || name === "all") {
      throw new QueryValidationError([
        { path: "models", message: `models 含非法模型名：${name.slice(0, 32)}` },
      ]);
    }
  }
  return unique;
}

/** 趋势缓存 key 的模型维度段：默认 Top N → `top10`；指定列表 → 排序后取短哈希（长度可控）。 */
export function modelTrendKeyPart(models: string[] | undefined): string {
  if (models === undefined || models.length === 0) return "top10";
  const digest = createHash("sha256")
    .update([...models].sort().join(","), "utf8")
    .digest("hex");
  return `set-${digest.slice(0, 16)}`;
}

/* ------------------------------------------------------------------ */
/* trend                                                               */
/* ------------------------------------------------------------------ */

export interface ModelTrendPoint {
  bucketStart: number;
  label: string;
  totalQuota: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

export interface ModelTrendSeries {
  modelName: string;
  points: ModelTrendPoint[];
}

export interface ModelTrendResult {
  series: ModelTrendSeries[];
}

export interface ModelTrendQuotaRow {
  bucket_start: number;
  model_name: string;
  total_quota: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelTrendLogRow {
  bucket_start: number;
  model_name: string;
  request_count: number;
}

/** 区间 Top N 模型（按消耗降序；trend 未指定 models 时的默认维度）。 */
export function buildTopModelsQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  limit: number = MODEL_TREND_DEFAULT_MODELS,
) {
  return db
    .selectFrom("quota_data")
    .select([
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .groupBy("model_name")
    .orderBy(sql`COALESCE(SUM(quota), 0)`, "desc")
    .orderBy("model_name", "asc")
    .limit(limit);
}

/** 模型 × 桶的消耗/Token 聚合。 */
export function buildModelTrendQuotaQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  granularity: Granularity,
  modelNames: string[],
) {
  return db
    .selectFrom("quota_data")
    .select([
      trendBucketExpression(granularity).as("bucket_start"),
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("model_name", "in", modelNames)
    .groupBy(trendBucketExpression(granularity))
    .groupBy("model_name");
}

/** 模型 × 桶的请求数（logs）。 */
export function buildModelTrendRequestQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  granularity: Granularity,
  modelNames: string[],
) {
  return db
    .selectFrom("logs")
    .select([
      trendBucketExpression(granularity).as("bucket_start"),
      "model_name",
      sql<number>`COUNT(*)::bigint`.as("request_count"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("model_name", "in", modelNames)
    .groupBy(trendBucketExpression(granularity))
    .groupBy("model_name");
}

/** 组装模型序列：每个模型一条等长序列，空桶补 0；顺序以 models 为准。 */
export function assembleModelTrend(
  models: string[],
  buckets: number[],
  granularity: Granularity,
  quotaRows: ModelTrendQuotaRow[],
  logRows: ModelTrendLogRow[],
): ModelTrendResult {
  const quotaByKey = new Map<string, ModelTrendQuotaRow>();
  for (const row of quotaRows) {
    quotaByKey.set(`${toInteger(row.bucket_start)}|${row.model_name}`, row);
  }
  const requestsByKey = new Map<string, number>();
  for (const row of logRows) {
    requestsByKey.set(`${toInteger(row.bucket_start)}|${row.model_name}`, toInteger(row.request_count));
  }

  const series = models.map((modelName) => ({
    modelName,
    points: buckets.map((bucket) => {
      const key = `${bucket}|${modelName}`;
      const quota = quotaByKey.get(key);
      return {
        bucketStart: bucket,
        label: bucketLabel(bucket, granularity),
        totalQuota: toInteger(quota?.total_quota),
        totalTokens: toInteger(quota?.total_tokens),
        promptTokens: toInteger(quota?.prompt_tokens),
        completionTokens: toInteger(quota?.completion_tokens),
        requestCount: requestsByKey.get(key) ?? 0,
      };
    }),
  }));

  return { series };
}

/** 执行模型趋势：未指定 models 时先取区间 Top 10；无模型返回空 series。 */
export async function runModelTrendQuery(
  range: QueryRange,
  granularity: Granularity,
  models: string[] | undefined,
  db: ReadOnlyDatabase = getDb(),
): Promise<ModelTrendResult> {
  const modelNames =
    models === undefined || models.length === 0
      ? (
          (await buildTopModelsQuery(db, range, MODEL_TREND_DEFAULT_MODELS).execute()) as Array<{
            model_name: string;
          }>
        ).map((row) => row.model_name)
      : models;

  if (modelNames.length === 0) return { series: [] };

  const buckets = trendBuckets(range.start, range.end, granularity);
  const [quotaRows, logRows] = await Promise.all([
    buildModelTrendQuotaQuery(db, range, granularity, modelNames).execute() as Promise<
      ModelTrendQuotaRow[]
    >,
    buildModelTrendRequestQuery(db, range, granularity, modelNames).execute() as Promise<
      ModelTrendLogRow[]
    >,
  ]);

  return assembleModelTrend(modelNames, buckets, granularity, quotaRows, logRows);
}

/* ------------------------------------------------------------------ */
/* cross                                                               */
/* ------------------------------------------------------------------ */

export interface ModelCrossUser {
  userId: number;
  username: string;
}

export interface ModelCrossCell {
  userId: number;
  modelName: string;
  totalQuota: number;
}

export interface ModelCrossResult {
  users: ModelCrossUser[];
  /** Top 模型（列）。 */
  models: string[];
  /** 稀疏矩阵：只包含有消耗的 (user, model) 单元。 */
  cells: ModelCrossCell[];
  /** 其余模型按用户合并（= 用户总消耗 − Top 模型消耗之和）。 */
  others: Array<{ userId: number; totalQuota: number }>;
}

export interface ModelCrossRow {
  user_id: number;
  model_name: string;
  total_quota: number;
}

/** Top 用户 × Top 模型消耗矩阵（稀疏）。 */
export function buildModelCrossMatrixQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  userIds: number[],
  modelNames: string[],
) {
  return db
    .selectFrom("quota_data")
    .select([
      "user_id",
      "model_name",
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "in", userIds)
    .where("model_name", "in", modelNames)
    .groupBy(["user_id", "model_name"]);
}

/** 组装交叉结果：cells 稀疏；others 用用户总消耗减 Top 模型消耗（不为负）。 */
export function assembleModelCross(
  users: Array<{ userId: number; username: string; totalQuota: number }>,
  models: string[],
  rows: ModelCrossRow[],
): ModelCrossResult {
  const cells: ModelCrossCell[] = rows.map((row) => ({
    userId: toInteger(row.user_id),
    modelName: row.model_name,
    totalQuota: toInteger(row.total_quota),
  }));

  const topByUser = new Map<number, number>();
  for (const cell of cells) {
    topByUser.set(cell.userId, (topByUser.get(cell.userId) ?? 0) + cell.totalQuota);
  }

  const others = users.map((user) => ({
    userId: user.userId,
    totalQuota: Math.max(0, user.totalQuota - (topByUser.get(user.userId) ?? 0)),
  }));

  return {
    users: users.map((user) => ({ userId: user.userId, username: user.username })),
    models,
    cells,
    others,
  };
}

/** 执行交叉分析：Top 用户（复用排行查询）→ Top 模型 → 矩阵；空数据返回空结构。 */
export async function runModelCrossQuery(
  range: QueryRange,
  userLimit: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<ModelCrossResult> {
  const ranking = await runUserRankingQuery(range, userLimit, db);
  if (ranking.length === 0) return { users: [], models: [], cells: [], others: [] };

  const topModels = (
    (await buildTopModelsQuery(db, range, MODEL_CROSS_TOP_MODELS).execute()) as Array<{
      model_name: string;
    }>
  ).map((row) => row.model_name);

  const users = ranking.map((row) => ({
    userId: row.userId,
    username: row.username,
    totalQuota: row.totalQuota,
  }));

  if (topModels.length === 0) return assembleModelCross(users, [], []);

  const rows = (await buildModelCrossMatrixQuery(
    db,
    range,
    users.map((user) => user.userId),
    topModels,
  ).execute()) as ModelCrossRow[];

  return assembleModelCross(users, topModels, rows);
}
