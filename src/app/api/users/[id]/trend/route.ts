/**
 * GET /api/users/[id]/trend —— 单用户趋势（方案 §3.3、§5.5）。
 *
 * 参数：`start`/`end`（必填）、`granularity=day|week|month`（缺省 day）。
 * 响应：`{ ok, data: { points: TrendPoint[] }, meta: { range, granularity, cached, source } }`
 * 说明：复用 `src/server/queries/trend.ts` 的桶序列/合并逻辑，仅加 userId 过滤；
 * 桶数上限（1000）为服务端纵深防御——公共参数已被 366 天共享区间上限约束，经路由不可触达。
 */
import { connection } from "next/server";

import { cacheKey } from "@/server/cache";
import { ok } from "@/server/http";
import {
  cachedQuery,
  handleQueryError,
  metaFromParams,
  normalizeQueryParams,
  QueryValidationError,
  SCOPE_TTL_MS,
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
    return handleQueryError("users/:id/trend", error);
  }
}
