/**
 * GET /api/users/inactive —— 上期活跃但本期沉默的用户清单。
 *
 * 参数：`start`/`end`（必填，ISO 或 Unix 秒）、`limit`（缺省 100、上限 500）。
 * 响应：`{ ok: true, data: InactiveUsersSnapshot, meta: { range, granularity, cached, source } }`
 *   - `data.prevRange` 为等长紧邻的上期区间；`data.total` 为未截断的沉默用户总数。
 * 错误：参数非法 400 `invalid_query`；查询失败 500 `query_failed`（不回显 SQL/连接串）。
 *
 * 注意：项目开启 `cacheComponents`，动态 GET 必须先 `connection()`，否则构建期执行一次并静态化。
 */
import { connection } from "next/server";

import { redactCredentials } from "@/server/db";
import { invalidQuery, ok, queryFailed } from "@/server/http";
import { QueryValidationError, metaFromParams } from "@/server/queries/common";
import {
  INACTIVE_SOURCE,
  getInactiveUsers,
  resolveInactiveParams,
} from "@/server/services/inactive.service";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const params = resolveInactiveParams(new URL(request.url).searchParams);
    const { data, cached } = await getInactiveUsers(params);
    return ok(data, { ...metaFromParams(params, cached), source: INACTIVE_SOURCE });
  } catch (error) {
    if (error instanceof QueryValidationError) {
      return invalidQuery(error.issues);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[users/inactive] query failed", redactCredentials(message));
    return queryFailed();
  }
}
