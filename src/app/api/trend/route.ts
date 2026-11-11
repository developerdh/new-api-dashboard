/**
 * GET /api/trend —— 全局趋势（BE-M1-03 / 方案 §3.2、§4、§5.2–§5.4）。
 *
 * 参数：`start`/`end`（必填，ISO 或 Unix 秒）、`granularity=day|week|month`（缺省 day）、
 *       `compare=none|prev|yoy`（缺省 none）。
 * 响应：`{ ok: true, data: { points, compareSeries? }, meta: { range, granularity, cached, source } }`
 * 错误：参数非法 400 `invalid_query`；查询失败 500 `query_failed`（不回显 SQL/连接串）。
 *
 * 注意：项目开启 `cacheComponents`，动态 GET 必须先 `connection()`，否则构建期执行一次并静态化。
 */
import { connection } from "next/server";

import { redactCredentials } from "@/server/db";
import { invalidQuery, ok, queryFailed } from "@/server/http";
import { QueryValidationError, metaFromParams } from "@/server/queries/common";
import { TREND_SOURCE, getTrend, resolveTrendParams } from "@/server/services/stats.service";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const resolved = resolveTrendParams(new URL(request.url).searchParams);
    const { data, cached } = await getTrend(resolved);
    return ok(data, { ...metaFromParams(resolved.params, cached), source: TREND_SOURCE });
  } catch (error) {
    if (error instanceof QueryValidationError) {
      return invalidQuery(error.issues);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trend] query failed", redactCredentials(message));
    return queryFailed();
  }
}
