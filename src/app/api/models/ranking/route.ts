/**
 * GET /api/models/ranking —— 模型消耗排行（BE-M1-06 / 方案 §3.4、§4）。
 *
 * 参数：`start`/`end`（必填）、`limit`（缺省 20、上限 100）。
 * 响应：`{ ok, data: { rows: ModelRankingRow[] }, meta: { range, granularity: null, cached, source } }`
 * 说明：请求数来自 logs 二次查询；平均成本 = SUM(quota)/请求数（JS 计算，请求数 0 记 0）。
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
import {
  MODEL_RANKING_MAX_LIMIT,
  MODEL_SOURCE,
  runModelRankingQuery,
} from "@/server/queries/model";

/**
 * 缓存：与用户排行同级（120s），但键前缀沿用 `modelDist` 命名空间（区分用户排行 key）。
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const params = normalizeQueryParams(new URL(request.url).searchParams);
    if (params.limit > MODEL_RANKING_MAX_LIMIT) {
      throw new QueryValidationError([
        { path: "limit", message: `模型排行 limit 上限 ${MODEL_RANKING_MAX_LIMIT}` },
      ]);
    }

    const key = `${cacheKey("modelDist", { start: params.start, end: params.end })}:limit=${params.limit}`;
    const { data, cached } = await cachedQuery(
      key,
      SCOPE_TTL_MS.usersRanking,
      () => runModelRankingQuery({ start: params.start, end: params.end }, params.limit),
    );

    return ok(
      { rows: data },
      { ...metaFromParams({ ...params, granularity: undefined }, cached), source: MODEL_SOURCE },
    );
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[models/ranking] query failed", redactCredentials(message));
    return queryFailed();
  }
}
