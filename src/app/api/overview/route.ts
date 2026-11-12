/**
 * GET /api/overview —— 全局总览（方案 §3.1、§4、§5.1）。
 *
 * 响应：`{ ok: true, data: OverviewSnapshot, meta: { range, granularity, cached, source } }`
 * 错误：参数非法 400 `invalid_query`；查询失败 500 `query_failed`（不回显 SQL/连接串）。
 *
 * 注意：项目开启 `cacheComponents`，动态 GET 必须先 `connection()`，否则构建期执行一次并静态化。
 */
import { connection } from "next/server";

import { redactCredentials } from "@/server/db";
import { invalidQuery, ok, queryFailed } from "@/server/http";
import { QueryValidationError, metaFromParams } from "@/server/queries/common";
import {
  OVERVIEW_SOURCE,
  getOverview,
  resolveOverviewParams,
} from "@/server/services/stats.service";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const params = resolveOverviewParams(new URL(request.url).searchParams);
    const { data, cached } = await getOverview(params);
    return ok(data, { ...metaFromParams(params, cached), source: OVERVIEW_SOURCE });
  } catch (error) {
    if (error instanceof QueryValidationError) {
      return invalidQuery(error.issues);
    }
    // 只记录脱敏后的消息，完整错误（含 SQL/连接串）不进入响应体
    const message = error instanceof Error ? error.message : String(error);
    console.error("[overview] query failed", redactCredentials(message));
    return queryFailed();
  }
}
