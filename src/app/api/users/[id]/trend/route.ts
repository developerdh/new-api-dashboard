/**
 * GET /api/users/[id]/trend —— 单用户趋势（BE-M1-05 / 方案 §3.3、§5.5）。
 *
 * 参数：`start`/`end`（必填）、`granularity=day|week|month`（缺省 day）。
 * 响应：`{ ok, data: { points: TrendPoint[] }, meta: { range, granularity, cached, source } }`
 * 说明：复用 BE-M1-03 的桶序列/合并逻辑，仅加 userId 过滤；桶数上限同全局趋势（1000 → 400）。
 */
import { connection } from "next/server";

import { cacheKey } from "@/server/cache";
import { redactCredentials } from "@/server/db";
import { invalidQuery, ok, queryFailed } from "@/server/http";
import {
  QueryValidationError,
  SCOPE_TTL_MS,
  cachedQuery,
  metaFromParams,
  normalizeQueryParams,
} from "@/server/queries/common";
import { MAX_TREND_BUCKETS, toTrendPoints, trendBuckets } from "@/server/queries/trend";
import {
  USER_DETAIL_SOURCE,
  loadUserTrendSeries,
  parseUserId,
} from "@/server/queries/user";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const { id } = await context.params;
    const userId = parseUserId(id);
    const params = normalizeQueryParams(new URL(request.url).searchParams);
    const granularity = params.granularity ?? "day";

    const buckets = trendBuckets(params.start, params.end, granularity);
    if (buckets.length > MAX_TREND_BUCKETS) {
      throw new QueryValidationError([
        {
          path: "range",
          message: `桶数超过上限 ${MAX_TREND_BUCKETS}，请缩小范围或改用更粗粒度`,
        },
      ]);
    }

    const key = cacheKey("userTrend", {
      start: params.start,
      end: params.end,
      granularity,
      userId,
    });
    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.userTrend, async () => {
      const series = await loadUserTrendSeries(
        { start: params.start, end: params.end },
        granularity,
        userId,
      );
      return { points: toTrendPoints(buckets, series, granularity) };
    });

    return ok(data, {
      ...metaFromParams({ ...params, granularity }, cached),
      source: USER_DETAIL_SOURCE,
    });
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[users/:id/trend] query failed", redactCredentials(message));
    return queryFailed();
  }
}
