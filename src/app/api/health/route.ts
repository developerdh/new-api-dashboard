/**
 * 运维补充端点（方案 §4 契约之外的补充）：数据库连通探活。
 * 成功 200，失败 503；响应体固定 `{ ok, db: { status, latencyMs, error? } }`。
 *
 * 缓存：本项目开启 `cacheComponents`（next.config.ts），路由默认动态、未标 `use cache`
 * 即不缓存，故不写 `dynamic` 段配置（与 cacheComponents 互斥）；另加 no-store 响应头。
 */
import { NextResponse } from "next/server";

import { checkDbHealth } from "@/server/db";

export async function GET(): Promise<NextResponse> {
  const health = await checkDbHealth();

  return NextResponse.json(
    {
      ok: health.ok,
      db: {
        status: health.status,
        latencyMs: health.latencyMs,
        ...(health.error ? { error: health.error } : {}),
      },
    },
    {
      status: health.ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
