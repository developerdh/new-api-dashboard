/**
 * 运维端点（方案 §4 契约之外的补充）：数据库连通 + schema 自检。
 *
 * 响应体 `{ ok, version, db: { status, latencyMs, error? }, schema: { ok, missing, error? } }`。
 * 数据库不可达或缺列时 `ok` 为 false 并返回 503——缺列会让统计接口在运行期 500，
 * 提前暴露优于让使用者猜。
 *
 * 缓存：本项目开启 `cacheComponents`（next.config.ts），路由默认动态、未标 `use cache`
 * 即不缓存，故不写 `dynamic` 段配置（与 cacheComponents 互斥）；另加 no-store 响应头。
 */
import { NextResponse } from "next/server";

import { checkDbHealth } from "@/server/db";
import { checkSchema } from "@/server/schema-check";

export async function GET(): Promise<NextResponse> {
  const health = await checkDbHealth();
  // 数据库不可达时不再探测 schema，避免重复失败与无意义的错误信息
  const schema = health.ok ? await checkSchema().catch(() => null) : null;
  const ok = health.ok && schema !== null && schema.ok;

  return NextResponse.json(
    {
      ok,
      version: process.env.APP_VERSION ?? "unknown",
      db: {
        status: health.status,
        latencyMs: health.latencyMs,
        ...(health.error ? { error: health.error } : {}),
      },
      schema:
        schema === null
          ? { ok: false, missing: [], error: health.ok ? "schema_check_failed" : "db_unavailable" }
          : { ok: schema.ok, missing: schema.missing },
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
