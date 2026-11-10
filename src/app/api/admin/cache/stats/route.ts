/**
 * GET /api/admin/cache/stats —— 查看进程内缓存占用（方案 §6.3(4)）。
 *
 * 守卫：`Authorization: Bearer ${ADMIN_TOKEN}`；未配置 ADMIN_TOKEN 时整端点禁用（404）。
 *
 * 注意：项目开启 `cacheComponents`，Route Handler 默认可能被预渲染（构建期执行一次），
 * 会把「构建时无 ADMIN_TOKEN → 404」固化成静态响应；因此必须先 `connection()` 显式转为
 * 请求期动态渲染。不能用 `export const dynamic`（与 cacheComponents 不兼容）。
 */
import { connection } from "next/server";

import { requireAdmin } from "@/server/admin-auth";
import { CACHE_METRICS_INTERVAL_MS, CACHE_TTL_MS, getCacheStats } from "@/server/cache";

export async function GET(request: Request): Promise<Response> {
  await connection();

  const denied = requireAdmin(request);
  if (denied !== null) return denied;

  return Response.json(
    {
      ok: true,
      cache: getCacheStats(),
      metricsIntervalMs: CACHE_METRICS_INTERVAL_MS,
      ttlMs: CACHE_TTL_MS,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
