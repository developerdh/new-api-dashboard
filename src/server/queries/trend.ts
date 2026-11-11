/**
 * 全局趋势查询（BE-M1-03 / 方案 §3.2、§5.2–§5.4）。
 *
 * SQL 口径：
 * - quota_data 按 `DATE_TRUNC('<granularity>', to_timestamp(created_at) AT TIME ZONE 'Asia/Shanghai')`
 *   分桶，聚合 total_quota/total_tokens/prompt/completion 与桶内 `COUNT(DISTINCT user_id)`；
 * - logs 同粒度 `COUNT(*)` 得请求数，按桶起点与 quota_data 序列合并；
 * - 桶起点统一换算为 Unix 秒（东八区桶边界 → 真实 epoch），避免 timestamp 被驱动按本地时区解析。
 *
 * 空桶：SQL 只返回有数据的桶，补齐由 `toTrendPoints()` 完成（以 `trendBuckets()` 的桶序列为准），
 * 这样「桶序列」只有一套实现（JS 侧），SQL 只负责聚合值。
 *
 * 环比/同比（compare）：
 * - `prev` = 等长前一周期：主序列 n 个桶整体前移 n 个桶（day→n 天、week→n 周、month→n 个自然月）；
 * - `yoy` = 前移 12 个自然月；
 * - 对齐按桶序号进行，长度不足补 null（由 `alignCompareSeries()` 完成）。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import {
  addShanghaiDays,
  addShanghaiMonths,
  bucketStart,
  shanghaiDate,
  type Granularity,
  type QueryRange,
} from "@/server/queries/common";

/** 单次趋势查询的桶数上限（卡内风险项：防大范围响应体膨胀）。 */
export const MAX_TREND_BUCKETS = 1_000;

export type CompareMode = "none" | "prev" | "yoy";

export const COMPARE_MODES: readonly CompareMode[] = ["none", "prev", "yoy"];

/** 趋势点（data.points[i]）。 */
export interface TrendPoint {
  /** 桶起点（Unix 秒，Asia/Shanghai 桶边界）。 */
  bucketStart: number;
  /** 展示标签：day/week → `YYYY-MM-DD`，month → `YYYY-MM`。 */
  label: string;
  totalQuota: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  activeUsers: number;
}

export interface TrendSeries {
  points: TrendPoint[];
  /** compare != none 时存在；与 points 等长，缺数据的位置为 null。 */
  compareSeries?: Array<TrendPoint | null>;
}

/** 单个桶的聚合值（不含 label，label 由粒度决定）。 */
export interface TrendBucketData {
  totalQuota: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  activeUsers: number;
}

export interface TrendQuotaRow {
  bucket_start: number;
  total_quota: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  active_users: number;
}

export interface TrendLogRow {
  bucket_start: number;
  request_count: number;
}

/** 按粒度平移 k 个桶（day=k 天、week=k 周、month=k 个自然月）。 */
export function shiftBucket(bucket: number, granularity: Granularity, k: number): number {
  switch (granularity) {
    case "day":
      return addShanghaiDays(bucket, k);
    case "week":
      return addShanghaiDays(bucket, k * 7);
    case "month":
      return addShanghaiMonths(bucket, k);
  }
}

/**
 * 枚举 `[start, end)` 覆盖的桶起点：首个桶对齐到 start 所在桶，末桶为包含 `end - 1` 的桶。
 * 超过 `MAX_TREND_BUCKETS` 时截断（多取 1 个用于触发上限校验，不会无限循环）。
 */
export function trendBuckets(start: number, end: number, granularity: Granularity): number[] {
  const buckets: number[] = [];
  if (start >= end) return buckets;

  let current = bucketStart(start, granularity);
  while (current < end) {
    buckets.push(current);
    current = shiftBucket(current, granularity, 1);
    if (buckets.length > MAX_TREND_BUCKETS) break;
  }
  return buckets;
}

/** 桶标签：日/周用自然日，月用 `YYYY-MM`。 */
export function bucketLabel(bucket: number, granularity: Granularity): string {
  const date = shanghaiDate(bucket);
  return granularity === "month" ? date.slice(0, 7) : date;
}

/** 桶起点表达式：东八区桶边界 → 真实 Unix 秒（int8 → number）。 */
export function trendBucketExpression(granularity: Granularity) {
  return sql<number>`(EXTRACT(EPOCH FROM (DATE_TRUNC(${sql.lit(granularity)}, to_timestamp(created_at) AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')))::bigint`;
}

/** quota_data 分桶聚合查询（§5.2–§5.4 + 桶内活跃用户）。 */
/** quota_data 分桶聚合查询（§5.2–§5.4 + 桶内活跃用户）；`userId` 给定时只统计该用户。 */
export function buildTrendQuotaQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  granularity: Granularity,
  userId?: number,
) {
  const base = db
    .selectFrom("quota_data")
    .select([
      trendBucketExpression(granularity).as("bucket_start"),
      sql<number>`COALESCE(SUM(quota), 0)::bigint`.as("total_quota"),
      sql<number>`COALESCE(SUM(token_used), 0)::bigint`.as("total_tokens"),
      sql<number>`COALESCE(SUM(prompt_tokens), 0)::bigint`.as("prompt_tokens"),
      sql<number>`COALESCE(SUM(completion_tokens), 0)::bigint`.as("completion_tokens"),
      sql<number>`COUNT(DISTINCT user_id)::bigint`.as("active_users"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);

  const filtered = userId === undefined ? base : base.where("user_id", "=", userId);
  return filtered.groupBy(trendBucketExpression(granularity));
}

/** logs 分桶请求数查询（与 quota_data 同粒度同桶边界）；`userId` 给定时只统计该用户。 */
export function buildTrendRequestQuery(
  db: ReadOnlyDatabase,
  range: QueryRange,
  granularity: Granularity,
  userId?: number,
) {
  const base = db
    .selectFrom("logs")
    .select([
      trendBucketExpression(granularity).as("bucket_start"),
      sql<number>`COUNT(*)::bigint`.as("request_count"),
    ])
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end);

  const filtered = userId === undefined ? base : base.where("user_id", "=", userId);
  return filtered.groupBy(trendBucketExpression(granularity));
}

function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/** 合并 quota_data 聚合与 logs 计数（按桶起点；logs 缺失记 0）。 */
export function mergeTrendRows(
  quotaRows: TrendQuotaRow[],
  logRows: TrendLogRow[],
): Map<number, TrendBucketData> {
  const merged = new Map<number, TrendBucketData>();

  for (const row of quotaRows) {
    const bucket = toInteger(row.bucket_start);
    merged.set(bucket, {
      totalQuota: toInteger(row.total_quota),
      totalTokens: toInteger(row.total_tokens),
      promptTokens: toInteger(row.prompt_tokens),
      completionTokens: toInteger(row.completion_tokens),
      requestCount: 0,
      activeUsers: toInteger(row.active_users),
    });
  }

  for (const row of logRows) {
    const bucket = toInteger(row.bucket_start);
    const existing = merged.get(bucket);
    if (existing === undefined) {
      merged.set(bucket, {
        totalQuota: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requestCount: toInteger(row.request_count),
        activeUsers: 0,
      });
    } else {
      existing.requestCount = toInteger(row.request_count);
    }
  }

  return merged;
}

/** 桶序列 + 聚合值 → 响应点（空桶补 0，顺序以 buckets 为准）。 */
export function toTrendPoints(
  buckets: number[],
  data: Map<number, TrendBucketData>,
  granularity: Granularity,
): TrendPoint[] {
  return buckets.map((bucket) => {
    const row = data.get(bucket);
    return {
      bucketStart: bucket,
      label: bucketLabel(bucket, granularity),
      totalQuota: row?.totalQuota ?? 0,
      totalTokens: row?.totalTokens ?? 0,
      promptTokens: row?.promptTokens ?? 0,
      completionTokens: row?.completionTokens ?? 0,
      requestCount: row?.requestCount ?? 0,
      activeUsers: row?.activeUsers ?? 0,
    };
  });
}

/** 同比起点：日/月按日历前移 12 个月；周按前移 52 周（保持周一并避免闰年错位）。 */
function shiftYearBucket(bucket: number, granularity: Granularity): number {
  return granularity === "week"
    ? shiftBucket(bucket, granularity, -52)
    : addShanghaiMonths(bucket, -12);
}

/**
 * 环比/同比对照区间：
 * - prev：[首桶 - n, 末桶 - n + 1)（n = 主序列桶数，等长前移，三个粒度均保持桶数）；
 * - yoy：[首桶同比, 末桶同比 + 1 桶)（日/月=前移 12 个月，周=前移 52 周）。
 */
export function compareBucketRange(
  buckets: number[],
  granularity: Granularity,
  mode: Exclude<CompareMode, "none">,
): QueryRange {
  if (buckets.length === 0) return { start: 0, end: 0 };

  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const count = buckets.length;

  if (mode === "prev") {
    return {
      start: shiftBucket(first, granularity, -count),
      end: shiftBucket(last, granularity, -count + 1),
    };
  }

  const compareLast = shiftYearBucket(last, granularity);
  return {
    start: shiftYearBucket(first, granularity),
    end: shiftBucket(compareLast, granularity, 1),
  };
}

/** 按桶序号对齐：不足补 null（不跨桶时间对齐，月末差异属预期）。 */
export function alignCompareSeries(
  points: TrendPoint[],
  comparePoints: TrendPoint[],
): Array<TrendPoint | null> {
  return points.map((_, index) => comparePoints[index] ?? null);
}

/** 执行主/对照两条序列的查询（对照为 null 时只查主序列）。 */
export async function loadTrendSeries(
  range: QueryRange,
  granularity: Granularity,
  db: ReadOnlyDatabase = getDb(),
): Promise<Map<number, TrendBucketData>> {
  const [quotaRows, logRows] = await Promise.all([
    buildTrendQuotaQuery(db, range, granularity).execute(),
    buildTrendRequestQuery(db, range, granularity).execute(),
  ]);
  return mergeTrendRows(quotaRows as TrendQuotaRow[], logRows as TrendLogRow[]);
}
