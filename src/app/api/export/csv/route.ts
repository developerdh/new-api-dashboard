/**
 * GET /api/export/csv —— CSV 导出（方案 §4、§9.2）。
 *
 * 数据集数据只调用既有 service/query（与页面同口径、同缓存 key）；本路由负责：
 * 参数校验 → 按 IP 限流（60s/10 次）→ 流式 CSV 响应。
 */
import { connection } from "next/server";

import { clientIp } from "@/server/request-origin";
import { handleQueryError } from "@/server/queries/common";
import { exportRateLimiter } from "@/lib/rate-limit";
import { buildCsvExport, resolveExportRequest } from "@/server/services/export.service";

export async function GET(request: Request): Promise<Response> {
  await connection();

  const rate = exportRateLimiter.check(`export:${clientIp(request)}`);
  if (!rate.allowed) {
    // resetAt 与限流器同时间线（performance.now 单调时钟），不做时钟回拨换算
    const retryAfter = Math.max(1, Math.ceil((rate.resetAt - performance.now()) / 1000));
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
    return handleQueryError("export/csv", error);
  }
}
