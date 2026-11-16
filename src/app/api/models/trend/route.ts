/**
 * GET /api/models/trend —— 模型趋势（方案 §3.4）。
 *
 * 参数：`start`/`end`（必填）、`granularity=day|week|month`（缺省 day）、
 *       `models`（逗号分隔、≤10 个；缺省取区间消耗 Top 10）。
 * 响应：`{ ok, data: { series: ModelTrendSeries[] }, meta: { range, granularity, cached, source } }`
 * 说明：每模型一条等长桶序列，空桶补 0；桶数上限同全局趋势（1000 → 400）。
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
import { MAX_TREND_BUCKETS, trendBuckets } from "@/server/queries/trend";
import {
  MODEL_SOURCE,
  modelTrendKeyPart,
  parseModelFilter,
  runModelTrendQuery,
} from "@/server/queries/model";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const searchParams = new URL(request.url).searchParams;
    const params = normalizeQueryParams(searchParams);
    const granularity = params.granularity ?? "day";
    const models = parseModelFilter(searchParams.get("models"));

    const buckets = trendBuckets(params.start, params.end, granularity);
    if (buckets.length > MAX_TREND_BUCKETS) {
      throw new QueryValidationError([
        {
          path: "range",
          message: `桶数超过上限 ${MAX_TREND_BUCKETS}，请缩小范围或改用更粗粒度`,
        },
      ]);
    }

    const key = `${cacheKey("modelDist", {
      start: params.start,
      end: params.end,
      granularity,
    })}:models=${modelTrendKeyPart(models)}`;

    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.modelDist, () =>
      runModelTrendQuery({ start: params.start, end: params.end }, granularity, models),
    );

    return ok(data, {
      ...metaFromParams({ ...params, granularity }, cached),
      source: MODEL_SOURCE,
    });
  } catch (error) {
    return handleQueryError("models/trend", error);
  }
}
