/**
 * GET /api/users/[id]/models —— 单用户模型分布 + 最近使用记录（方案 §3.3、§5.6）。
 *
 * 响应：`{ ok, data: { models: UserModelRow[], recent: UserRecentRow[] },
 *        meta: { range, granularity: null, cached, source } }`
 * 说明：
 * - models 按 §5.6 对 quota_data 分组（消耗降序、model_name 兜底），行内附 prompt/completion 占比；
 * - recent 为该用户最近 50 条 logs（`created_at DESC`），**不按查询区间过滤**（口径定稿）；
 * - 用户不存在/区间无记录 → `models: []`、`recent` 照常返回。
 */
import { connection } from "next/server";

import { cacheKey } from "@/server/cache";
import { ok } from "@/server/http";
import {
  cachedQuery,
  handleQueryError,
  metaFromParams,
  normalizeQueryParams,
  SCOPE_TTL_MS,
} from "@/server/queries/common";
import {
  USER_DETAIL_SOURCE,
  parseUserId,
  runUserModelsQuery,
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

    const key = cacheKey("modelDist", {
      start: params.start,
      end: params.end,
      userId,
    });
    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.modelDist, () =>
      runUserModelsQuery(userId, { start: params.start, end: params.end }),
    );

    return ok(data, {
      ...metaFromParams({ ...params, granularity: undefined }, cached),
      source: USER_DETAIL_SOURCE,
    });
  } catch (error) {
    return handleQueryError("users/:id/models", error);
  }
}
