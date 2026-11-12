/**
 * 统计服务（overview / trend / ranking；方案 §3、§4、§5、§6.3(3)）。
 *
 * 职责：参数缺省与校验 + 缓存编排。SQL 与桶序列构造在 `src/server/queries/*`。
 * - overview：`start`/`end` 都缺省 → 今日（Asia/Shanghai）；TTL 60s。
 * - trend：`granularity` 缺省 day、`compare` 缺省 none；TTL 动态（含当前桶 60s / 完全历史 1h）。
 * - ranking：`limit` 缺省 20、上限 100；key 含 limit；TTL 120s。
 */
import { cacheKey } from "@/server/cache";
import {
  DEFAULT_LIMIT,
  QueryValidationError,
  SCOPE_TTL_MS,
  addShanghaiDays,
  bucketStart,
  cachedQuery,
  normalizeQueryParams,
  shanghaiDayStart,
  type Granularity,
  type QueryParams,
} from "@/server/queries/common";
import { runOverviewQuery, type OverviewSnapshot } from "@/server/queries/overview";
import {
  RANKING_MAX_LIMIT,
  runUserRankingQuery,
  type UserRankingRow,
} from "@/server/queries/user";
import {
  COMPARE_MODES,
  MAX_TREND_BUCKETS,
  alignCompareSeries,
  compareBucketRange,
  loadTrendSeries,
  toTrendPoints,
  trendBuckets,
  type CompareMode,
  type TrendSeries,
} from "@/server/queries/trend";

export const OVERVIEW_SCOPE = "overview" as const;

/** 数据来源标注：quota_data（有 5 分钟延迟）+ logs（精确请求数）。 */
export const OVERVIEW_SOURCE = "quota_data+logs" as const;

/**
 * 解析 overview 参数：
 * - `start`、`end` 都不传 → 今日 00:00:00 至次日 00:00:00（Asia/Shanghai，左闭右开）；
 * - 只传一个 → 交由 `normalizeQueryParams` 报缺参（避免「半默认」区间歧义）；
 * - 传了非法值 → `QueryValidationError`。
 */
export function resolveOverviewParams(
  searchParams: URLSearchParams,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): QueryParams {
  if (!searchParams.has("start") && !searchParams.has("end")) {
    const start = shanghaiDayStart(nowSeconds);
    return { start, end: addShanghaiDays(start, 1), limit: DEFAULT_LIMIT };
  }
  return normalizeQueryParams(searchParams);
}

/** 总览缓存 key：只用区间，粒度/用户/模型参数不参与（总览无这些维度）。 */
export function overviewCacheKey(params: QueryParams): string {
  return cacheKey(OVERVIEW_SCOPE, { start: params.start, end: params.end });
}

/** 取总览：缓存命中直返；未命中执行 §5.1 查询并写缓存（TTL 60s）。 */
export async function getOverview(
  params: QueryParams,
): Promise<{ data: OverviewSnapshot; cached: boolean }> {
  return cachedQuery(overviewCacheKey(params), SCOPE_TTL_MS.overview, () =>
    runOverviewQuery({ start: params.start, end: params.end }),
  );
}

/* ------------------------------------------------------------------ */
/* trend                                                   */
/* ------------------------------------------------------------------ */

/** 趋势数据来源同总览：quota_data 聚合 + logs 请求数。 */
export const TREND_SOURCE = OVERVIEW_SOURCE;

/**
 * 趋势使用的缓存命名空间：全局维度复用 `overview` 前缀，靠 granularity 段与总览 key（`all`）区分。
 * TTL 不进 scope 表（§6.3(3) 六档固定），由 `trendTtlMs()` 按区间动态给出。
 */
export const TREND_CACHE_SCOPE = "overview" as const;

export interface TrendQueryParams extends QueryParams {
  granularity: Granularity;
}

export interface ResolvedTrendQuery {
  params: TrendQueryParams;
  compare: CompareMode;
}

/** 解析趋势参数：granularity 缺省 day；compare 白名单 none/prev/yoy，非法报 400。 */
export function resolveTrendParams(searchParams: URLSearchParams): ResolvedTrendQuery {
  const params = normalizeQueryParams(searchParams);
  const rawCompare = searchParams.get("compare") ?? "none";

  if (!COMPARE_MODES.includes(rawCompare as CompareMode)) {
    throw new QueryValidationError([
      { path: "compare", message: `compare 只允许 ${COMPARE_MODES.join("/")}` },
    ]);
  }

  return {
    params: { ...params, granularity: params.granularity ?? "day" },
    compare: rawCompare as CompareMode,
  };
}

/** 枚举桶并做上限校验（>1000 桶 → 400 `invalid_query`）。 */
export function trendBucketList(params: TrendQueryParams): number[] {
  const buckets = trendBuckets(params.start, params.end, params.granularity);
  if (buckets.length > MAX_TREND_BUCKETS) {
    throw new QueryValidationError([
      {
        path: "range",
        message: `桶数超过上限 ${MAX_TREND_BUCKETS}，请缩小范围或改用更粗粒度`,
      },
    ]);
  }
  return buckets;
}

/**
 * 动态 TTL：区间覆盖当前时间所在桶 → 60s（数据仍在变化）；完全落在历史桶 → 3600s。
 * `end` 为左闭右开区间的右端，`end > 当前桶起点` 即表示覆盖了当前桶。
 */
export function trendTtlMs(
  end: number,
  granularity: Granularity,
  nowSeconds: number,
): number {
  const currentBucket = bucketStart(nowSeconds, granularity);
  return end > currentBucket ? SCOPE_TTL_MS.overview : SCOPE_TTL_MS.historyMonth;
}

/** 趋势缓存 key：区间 + 粒度 + compare（compare 改变响应体，必须进 key）。 */
export function trendCacheKey(params: TrendQueryParams, compare: CompareMode): string {
  const base = cacheKey(TREND_CACHE_SCOPE, {
    start: params.start,
    end: params.end,
    granularity: params.granularity,
  });
  return `${base}:cmp=${compare}`;
}

/** 取趋势：主序列 + 可选 compareSeries（prev/yoy），按桶序号对齐、缺数据补 null。 */
export async function getTrend(
  resolved: ResolvedTrendQuery,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ data: TrendSeries; cached: boolean }> {
  const { params, compare } = resolved;
  const buckets = trendBucketList(params);
  const ttl = trendTtlMs(params.end, params.granularity, nowSeconds);

  return cachedQuery(trendCacheKey(params, compare), ttl, async () => {
    const mainData = await loadTrendSeries(
      { start: params.start, end: params.end },
      params.granularity,
    );
    const points = toTrendPoints(buckets, mainData, params.granularity);

    if (compare === "none") {
      return { points };
    }

    const range = compareBucketRange(buckets, params.granularity, compare);
    const compareData = await loadTrendSeries(range, params.granularity);
    const compareBuckets = trendBuckets(range.start, range.end, params.granularity);
    const comparePoints = toTrendPoints(compareBuckets, compareData, params.granularity);

    return { points, compareSeries: alignCompareSeries(points, comparePoints) };
  });
}

/* ------------------------------------------------------------------ */
/* ranking                                                  */
/* ------------------------------------------------------------------ */

/** 排行数据来源同总览：quota_data 聚合 + logs 请求数。 */
export const RANKING_SOURCE = OVERVIEW_SOURCE;

/** 排行使用独立缓存命名空间（§6.3(3) usersRanking 120s）。 */
export const RANKING_SCOPE = "usersRanking" as const;

/** 排行参数：`start`/`end` 必填；`limit` 缺省 20、上限 100（§4 收紧口径）。 */
export function resolveRankingParams(searchParams: URLSearchParams): QueryParams {
  const params = normalizeQueryParams(searchParams);
  if (params.limit > RANKING_MAX_LIMIT) {
    throw new QueryValidationError([
      { path: "limit", message: `排行 limit 上限 ${RANKING_MAX_LIMIT}` },
    ]);
  }
  return params;
}

/** 排行缓存 key：区间 + limit（limit 改变结果集，必须进 key）。 */
export function rankingCacheKey(params: QueryParams): string {
  const base = cacheKey(RANKING_SCOPE, { start: params.start, end: params.end });
  return `${base}:limit=${params.limit}`;
}

/** 取用户排行：缓存命中直返；未命中执行 §5.7 聚合 + 名称/请求数补齐（TTL 120s）。 */
export async function getUserRanking(
  params: QueryParams,
): Promise<{ data: { rows: UserRankingRow[] }; cached: boolean }> {
  const { data, cached } = await cachedQuery(
    rankingCacheKey(params),
    SCOPE_TTL_MS.usersRanking,
    () => runUserRankingQuery({ start: params.start, end: params.end }, params.limit),
  );
  return { data: { rows: data }, cached };
}
