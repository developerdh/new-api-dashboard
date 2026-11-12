/**
 * GET /api/users/[id]/overview —— 单用户总览（方案 §3.3、§5.5）。
 *
 * 响应：`{ ok, data: { totalQuota, totalTokens, promptTokens, completionTokens, requestCount, activeDays },
 *        meta: { range, granularity: null, cached, source } }`
 * 错误：id/参数非法 400 `invalid_query`；查询失败 500 `query_failed`（不回显 SQL/连接串）。
 * 用户不存在不返回 404——区间内无记录时返回全 0（避免探测用户存在性）。
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
  USER_DETAIL_SOURCE,
  parseUserId,
  runUserOverviewQuery,
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

    const key = cacheKey("userTrend", {
      start: params.start,
      end: params.end,
      userId,
    });
    const { data, cached } = await cachedQuery(key, SCOPE_TTL_MS.userTrend, () =>
      runUserOverviewQuery(userId, { start: params.start, end: params.end }),
    );

    return ok(data, {
      ...metaFromParams({ ...params, granularity: undefined }, cached),
      source: USER_DETAIL_SOURCE,
    });
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[users/:id/overview] query failed", redactCredentials(message));
    return queryFailed();
  }
}
