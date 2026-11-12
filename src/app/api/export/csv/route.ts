/**
 * GET /api/export/csv —— CSV 导出（方案 §4、§9.2）。
 *
 * 数据集数据只调用既有 service/query（与页面同口径、同缓存 key）；本路由负责：
 * 参数校验 → 按 IP 限流（60s/10 次）→ 流式 CSV 响应。
 */
import { connection } from "next/server";

import { redactCredentials } from "@/server/db";
import { invalidQuery, queryFailed } from "@/server/http";
import { QueryValidationError } from "@/server/queries/common";
import { exportRateLimiter } from "@/lib/rate-limit";
import { buildCsvExport, resolveExportRequest } from "@/server/services/export.service";

/** 客户端 IP：反代场景取 x-forwarded-for 首段；无则 unknown（进程内计数）。 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function GET(request: Request): Promise<Response> {
  await connection();

  const rate = exportRateLimiter.check(`export:${clientIp(request)}`);
  if (!rate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
    return Response.json(
      {
        ok: false,
        error: { code: "rate_limited", message: "导出请求过于频繁，请稍后再试" },
      },
      {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": String(retryAfter) },
      },
    );
  }

  try {
    const exportRequest = resolveExportRequest(new URL(request.url).searchParams);
    const payload = await buildCsvExport(exportRequest);
    return new Response(payload.stream, { headers: payload.headers });
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);
    const message = error instanceof Error ? error.message : String(error);
    console.error("[export/csv] failed", redactCredentials(message));
    return queryFailed();
  }
}
