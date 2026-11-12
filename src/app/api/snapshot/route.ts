/**
 * POST /api/snapshot —— 服务端看板快照（方案 §8.2）。
 *
 * 守卫：`Authorization: Bearer ${ADMIN_TOKEN}`（未配置 = 404，配置后缺失/错误 = 401）。
 * body：`{ path: "/dashboard" | "/models" | "/users/<id>", query?: { start, end, granularity }, name?: string }`
 * 响应：`{ ok:true, data:{ file, bytes, createdAt } }`
 * 错误：400 invalid_query（参数/body）｜429 snapshot_busy（在途任务达上限）｜503 snapshot_unavailable
 *       （playwright/chromium 未安装）｜500 query_failed（其余异常，不回显内部细节）。
 */
import { connection } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/server/admin-auth";
import { redactCredentials } from "@/server/db";
import { invalidQuery, queryFailed, toQueryIssues } from "@/server/http";
import { QueryValidationError } from "@/server/queries/common";
import {
  SnapshotBusyError,
  SnapshotUnavailableError,
  createSnapshot,
} from "@/server/services/snapshot.service";

const bodySchema = z.object({
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1).max(64).optional(),
});

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request): Promise<Response> {
  await connection();

  const denied = requireAdmin(request);
  if (denied !== null) return denied;

  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) return invalidQuery(toQueryIssues(error));
    return invalidQuery([{ path: "body", message: "请求体必须是 JSON：{ path, query?, name? }" }]);
  }

  try {
    const data = await createSnapshot(payload);
    return Response.json({ ok: true, data }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof QueryValidationError) return invalidQuery(error.issues);

    if (error instanceof SnapshotBusyError) {
      return Response.json(
        { ok: false, error: { code: "snapshot_busy", message: error.message } },
        { status: 429, headers: { ...NO_STORE, "retry-after": "5" } },
      );
    }

    if (error instanceof SnapshotUnavailableError) {
      return Response.json(
        { ok: false, error: { code: "snapshot_unavailable", message: error.message } },
        { status: 503, headers: NO_STORE },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[snapshot] failed", redactCredentials(message));
    return queryFailed();
  }
}
