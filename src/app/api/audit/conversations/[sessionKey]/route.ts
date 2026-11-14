/**
 * GET /api/audit/conversations/[sessionKey] —— 一个会话键下的全部轮次（只读索引）。
 *
 * 为什么单独一个接口：会话列表只需要「有几轮、最后一句什么时候」，而线程视图
 * 需要把轮次按时间排开。两者都只读索引，但排序方向和截断策略不同，
 * 混在一个接口里会让分页语义变复杂。
 *
 * 安全链：
 * 1. `sessionKey` 16 位小写十六进制（采集侧 `sha256(key)[:16]`）；
 * 2. 会话键是**客户端自带**的（`prompt_cache_key` / Claude `metadata.user_id`），
 *    知道键就能指定分组，因此必须叠加「指纹 ⊆ 该用户的 key 指纹集合」这一层，
 *    否则越权可读；
 * 3. 时间窗限制在 `AUDIT_MAX_WINDOW_DAYS` 天内，避免一次扫全部索引。
 *
 * 本接口不打开任何 blob：首屏成本与列表同阶。轮次正文由
 * `/api/audit/sessions/[traceId]?prev=…` 按需读取。
 */
import { connection } from "next/server";

import { toAuditErrorResponse } from "@/server/audit/errors";
import { scanThread } from "@/server/audit/index";
import { auditDir, auditMaxWindowDays, isAuditAvailable } from "@/server/audit/paths";
import { parseThreadQuery } from "@/server/audit/query";
import { AuditBlobMissingError } from "@/server/audit/reader";
import { hydrateSessionUsages } from "@/server/audit/usage";
import type { AuditThread } from "@/server/audit/types";
import { ok } from "@/server/http";
import { fingerprintsOfUser, loadTokenFingerprints } from "@/server/queries/audit-tokens";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionKey: string }> },
): Promise<Response> {
  await connection();

  try {
    const { sessionKey: raw } = await context.params;
    const query = parseThreadQuery(raw, new URL(request.url).searchParams);
    const meta = {
      range: { start: query.start, end: query.end },
      granularity: null,
      cached: false,
      source: "audit-files",
    } as const;

    const dir = auditDir();
    if (dir === null || !(await isAuditAvailable(dir))) {
      return toAuditErrorResponse(new AuditBlobMissingError());
    }

    const tokens = await loadTokenFingerprints();
    const fingerprints = fingerprintsOfUser(tokens, query.userId);
    if (!tokens.ok || fingerprints.size === 0) {
      return toAuditErrorResponse(new AuditBlobMissingError());
    }

    const thread = await scanThread({
      dir,
      sessionKey: query.sessionKey,
      fingerprints,
      start: query.start,
      end: query.end,
      maxDays: auditMaxWindowDays(),
    });

    // 轮次 token 水合：只读最近 N 轮的响应正文（超长会话的更早轮次不带 usage，界面显示 —）
    // 倒序传入让预算优先覆盖「最新的」轮次
    const usages = await hydrateSessionUsages(
      dir,
      [...thread.turns].reverse().map((turn) => ({
        date: turn.date,
        fp: turn.fingerprint,
        traceId: turn.traceId,
        path: turn.path,
        responseTruncated: turn.responseTruncated,
        gzip: turn.gzip,
      })),
    );
    const data: AuditThread = {
      sessionKey: query.sessionKey,
      fingerprints: thread.fingerprints,
      turns: thread.turns.map((turn) => {
        const usage = usages.get(`${turn.date}:${turn.fingerprint}:${turn.traceId}`);
        return usage === undefined ? turn : { ...turn, usage };
      }),
      total: thread.total,
      truncated: thread.truncated,
      scannedDates: thread.scannedDates,
    };
    return ok(data, meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[audit/conversations] failed", message);
    return toAuditErrorResponse(error);
  }
}
