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
import { ok } from "@/server/http";
import {
  cachedQuery,
  handleQueryError,
  metaFromParams,
  normalizeQueryParams,
  QueryValidationError,
  SCOPE_TTL_MS,
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

    // limit 决定 Top 用户集合，必须进 key（与 models/ranking、stats.service 口径一致）
    const key = `${cacheKey("modelDist", { start: params.start, end: params.end })}:cross:limit=${params.limit}`;
    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.modelDist, () =>
      runModelCrossQuery({ start: params.start, end: params.end }, params.limit),
    );

    return ok(data, {
      ...metaFromParams({ ...params, granularity: undefined }, cached),
      source: MODEL_SOURCE,
    });
  } catch (error) {
    return handleQueryError("models/cross", error);
  }
}
