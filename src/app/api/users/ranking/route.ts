/**
 * GET /api/users/ranking —— 用户消耗排行（方案 §3.3、§4、§5.7）。
 *
 * 参数：`start`/`end`（必填，ISO 或 Unix 秒）、`limit`（缺省 20、上限 100）。
 * 响应：`{ ok: true, data: { rows: UserRankingRow[] }, meta: { range, granularity, cached, source } }`
 * 错误：参数非法 400 `invalid_query`；查询失败 500 `query_failed`（不回显 SQL/连接串）。
 *
 * 注意：项目开启 `cacheComponents`，动态 GET 必须先 `connection()`，否则构建期执行一次并静态化。
 */
import { connection } from "next/server";

import { ok } from "@/server/http";
import { handleQueryError, metaFromParams } from "@/server/queries/common";
import {
  RANKING_SOURCE,
  getUserRanking,
  resolveRankingParams,
} from "@/server/services/stats.service";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const params = resolveRankingParams(new URL(request.url).searchParams);
    const { data, cached } = await getUserRanking(params);
    return ok(data, { ...metaFromParams(params, cached), source: RANKING_SOURCE });
  } catch (error) {
    return handleQueryError("users/ranking", error);
  }
}
