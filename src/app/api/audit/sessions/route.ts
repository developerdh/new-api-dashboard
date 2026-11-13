/**
 * GET /api/audit/sessions —— 某用户的会话列表（只读审计文件）。
 *
 * 身份链路：`userId` → `tokens.key` 重算指纹集合 → 过滤索引行的 `u`（严格相等）。
 * 不做时间窗/模型名的模糊匹配：宁可漏，不可错（见 `docs/audit-proxy/05-dashboard-plan.md` §0）。
 *
 * 响应：`{ ok, data: { available, sessions, nextCursor, scannedDates, fingerprintCount, lookupError?, unmatched? },
 *        meta: { range, granularity: null, cached: false, source } }`
 *
 * `AUDIT_DIR` 未配置或不可读时返回 200 + `available:false`：这是可选能力，
 * 不该让整页显示成错误态（与统计接口的失败语义区分开）。
 */
import { connection } from "next/server";

import { toAuditErrorResponse } from "@/server/audit/errors";
import { decodeCursor, scanSessions } from "@/server/audit/index";
import { auditDir, auditMaxWindowDays, isAuditAvailable } from "@/server/audit/paths";
import { parseSessionsQuery } from "@/server/audit/query";
import type { AuditSessionList } from "@/server/audit/types";
import { ok } from "@/server/http";
import { fingerprintsOfUser, loadTokenFingerprints } from "@/server/queries/audit-tokens";

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const url = new URL(request.url);
    const query = parseSessionsQuery(url.searchParams);
    const meta = {
      range: { start: query.start, end: query.end },
      granularity: null,
      cached: false,
      source: "audit-files",
    } as const;

    const dir = auditDir();
    if (dir === null || !(await isAuditAvailable(dir))) {
      const data: AuditSessionList = {
        available: false,
        sessions: [],
        nextCursor: null,
        scannedDates: [],
        fingerprintCount: 0,
      };
      return ok(data, meta);
    }

    const tokens = await loadTokenFingerprints();
    const fingerprints = fingerprintsOfUser(tokens, query.userId);

    if (!tokens.ok || fingerprints.size === 0) {
      const data: AuditSessionList = {
        available: true,
        sessions: [],
        nextCursor: null,
        scannedDates: [],
        fingerprintCount: fingerprints.size,
        ...(tokens.ok ? {} : { lookupError: tokens.error }),
      };
      return ok(data, meta);
    }

    const scan = await scanSessions({
      dir,
      start: query.start,
      end: query.end,
      maxDays: auditMaxWindowDays(),
      fingerprints,
      knownFingerprints: new Set(tokens.byFp.keys()),
      ...(query.model === undefined ? {} : { model: query.model }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.failedOnly === undefined ? {} : { failedOnly: query.failedOnly }),
      ...(query.stream === undefined ? {} : { stream: query.stream }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor) }),
    });

    const data: AuditSessionList = {
      available: true,
      sessions: scan.rows,
      nextCursor: scan.nextCursor,
      scannedDates: scan.scannedDates,
      fingerprintCount: fingerprints.size,
      ...(scan.unmatched > 0 ? { unmatched: scan.unmatched } : {}),
    };
    return ok(data, meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[audit/sessions] failed", message);
    return toAuditErrorResponse(error);
  }
}
