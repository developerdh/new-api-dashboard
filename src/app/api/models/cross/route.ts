/**
 * GET /api/models/cross —— 用户 × 模型交叉分布。
 *
 * 说明：本端点未列入 `docs/方案.md` §4 接口清单，属 §3.4 交叉分布的实现增补。
 *
 * 参数：`start`/`end`（必填）、`limit`（Top 用户数，缺省 20、上限 100）。
 * 响应：`{ ok, data: { users, models, cells, others }, meta: { range, granularity: null, cached, source } }`
 * 说明：cells 为稀疏矩阵（仅含有消耗的单元）；others = 用户总消耗 − Top 模型消耗之和（≥0）。
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
  runModelCrossQuery,
} from "@/server/queries/model";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const params = normalizeQueryParams(new URL(request.url).searchParams);
    if (params.limit > MODEL_RANKING_MAX_LIMIT) {
      throw new QueryValidationError([
        { path: "limit", message: `交叉分析 limit 上限 ${MODEL_RANKING_MAX_LIMIT}` },
      ]);
    }

    const key = `${cacheKey("modelDist", { start: params.start, end: params.end })}:cross`;
    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.modelDist, () =>
      runModelCrossQuery({ start: params.start, end: params.end }, params.limit),
    );

    return ok(data, {
      ...metaFromParams({ ...params, granularity: undefined }, cached),
      source: MODEL_SOURCE,
    });
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[models/cross] query failed", redactCredentials(message));
    return queryFailed();
  }
}
