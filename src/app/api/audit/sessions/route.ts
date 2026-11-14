/**
 * GET /api/audit/sessions —— 某用户的会话列表（只读审计文件）。
 *
 * 身份链路：`userId` → `tokens.key` 重算指纹集合 → 过滤索引行的 `u`（严格相等）。
 * 不做时间窗/模型名的模糊匹配：宁可漏，不可错（见 `docs/audit-proxy/05-dashboard-plan.md` §0）。
 *
 * 分页：`page`（1 基）+ `limit`（每页条数）；`date=YYYY-MM-DD` 时收窄到单个自然日。
 * 聚合模式（`group=session`）先全量分组再切片，所以能给出准确的 `total`；
 * 请求模式为省成本不做全量扫描，`total` 返回 null。
 *
 * 响应：`{ ok, data: { available, grouped, sessions, conversations?, page, pageSize, total,
 *        totalPages, scannedDates, fingerprintCount, lookupError?, unmatched?, date? },
 *        meta: { range, granularity: null, cached: false, source } }`
 *
 * `AUDIT_DIR` 未配置或不可读时返回 200 + `available:false`：这是可选能力，
 * 不该让整页显示成错误态（与统计接口的失败语义区分开）。
 */
import { connection } from "next/server";

import { toAuditErrorResponse } from "@/server/audit/errors";
import { scanConversations, scanSessions } from "@/server/audit/index";
import { auditDir, auditMaxWindowDays, isAuditAvailable } from "@/server/audit/paths";
import { parseSessionsQuery } from "@/server/audit/query";
import { attachUsage, hydrateSessionUsages } from "@/server/audit/usage";
import type { AuditSessionList } from "@/server/audit/types";
import { ok } from "@/server/http";
import { fingerprintsOfUser, loadTokenFingerprints } from "@/server/queries/audit-tokens";

/** 空结果（目录不可用 / 无指纹）也要带上分页字段，界面才不用判空。 */
function emptyPage(base: {
  available: boolean;
  grouped: boolean;
  pageSize: number;
  date?: string;
}): AuditSessionList {
  return {
    available: base.available,
    grouped: base.grouped,
    sessions: [],
    page: 1,
    pageSize: base.pageSize,
    total: 0,
    totalPages: 0,
    scannedDates: [],
    fingerprintCount: 0,
    ...(base.date === undefined ? {} : { date: base.date }),
  };
}

export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const url = new URL(request.url);
    const query = parseSessionsQuery(url.searchParams);
    const grouped = query.group === "session";
    const datePart = query.date === undefined ? {} : { date: query.date };
    const meta = {
      range: { start: query.start, end: query.end },
      granularity: null,
      cached: false,
      source: "audit-files",
    } as const;

    const dir = auditDir();
    if (dir === null || !(await isAuditAvailable(dir))) {
      return ok(
        emptyPage({ available: false, grouped, pageSize: query.limit, ...datePart }),
        meta,
      );
    }

    const tokens = await loadTokenFingerprints();
    const fingerprints = fingerprintsOfUser(tokens, query.userId);

    if (!tokens.ok || fingerprints.size === 0) {
      return ok(
        {
          ...emptyPage({ available: true, grouped, pageSize: query.limit, ...datePart }),
          fingerprintCount: fingerprints.size,
          ...(tokens.ok ? {} : { lookupError: tokens.error }),
        },
        meta,
      );
    }

    const scanInput = {
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
      offset: (query.page - 1) * query.limit,
    };

    if (grouped) {
      const result = await scanConversations(scanInput);
      // 聚合行不带 token：会话累计需读全部正文（成本随轮次线性走），
      // 「最近一轮」的口径又容易误导；token 在线程/详情按需展示。
      const data: AuditSessionList = {
        available: true,
        grouped: true,
        sessions: [],
        conversations: result.conversations,
        page: query.page,
        pageSize: query.limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
        ...(result.partial ? { partial: true } : {}),
        scannedDates: result.scannedDates,
        fingerprintCount: fingerprints.size,
        ...(result.unmatched > 0 ? { unmatched: result.unmatched } : {}),
        ...datePart,
      };
      return ok(data, meta);
    }

    const scan = await scanSessions(scanInput);
    // 当前页可见行才水合 token（预算 AUDIT_USAGE_HYDRATE_MAX，正文解析有 30s 缓存）
    const usages = await hydrateSessionUsages(dir, scan.rows);
    const data: AuditSessionList = {
      available: true,
      grouped: false,
      sessions: scan.rows.map((row) => attachUsage(row, usages)),
      page: query.page,
      pageSize: query.limit,
      total: null,
      totalPages: null,
      scannedDates: scan.scannedDates,
      fingerprintCount: fingerprints.size,
      ...(scan.unmatched > 0 ? { unmatched: scan.unmatched } : {}),
      ...datePart,
    };
    return ok(data, meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[audit/sessions] failed", message);
    return toAuditErrorResponse(error);
  }
}
