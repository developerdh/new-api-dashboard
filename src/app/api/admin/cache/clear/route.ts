/**
 * POST /api/admin/cache/clear —— 手动清空进程内缓存（方案 §6.3(5)）。
 *
 * 守卫：`Authorization: Bearer ${ADMIN_TOKEN}`；未配置 ADMIN_TOKEN 时整端点禁用（404）。
 */
import { requireAdmin } from "@/server/admin-auth";
import { clearCache, getCacheStats } from "@/server/cache";

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied !== null) return denied;

  clearCache();

  return Response.json(
    {
      ok: true,
      clearedAt: new Date().toISOString(),
      cache: getCacheStats(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
