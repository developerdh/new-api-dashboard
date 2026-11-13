/**
 * 审计接口的参数解析（与路由分离，便于单测）。
 *
 * 口径：`start`/`end` 与看板其余接口一致（Unix 秒或 ISO，左闭右开），
 * 而非 `02-design.md` §7.1 早期草案里的 `from`/`to`。
 */
import {
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_DATE_PATTERN,
  AuditQueryError,
  FINGERPRINT_PATTERN,
} from "@/server/audit/paths";
import { decodeCursor } from "@/server/audit/index";
import { MODEL_NAME_PATTERN, parseTimeInput } from "@/server/queries/common";

export function invalid(path: string, message: string): never {
  throw new AuditQueryError(message, [{ path, message }]);
}

export function parsePositiveInt(raw: string | null, field: string): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) invalid(field, `${field} 必须是正整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) invalid(field, `${field} 必须是正整数`);
  return value;
}

export function parseEpoch(raw: string | null, field: "start" | "end"): number {
  if (raw === null || raw.trim() === "") invalid(field, `${field} 必填（Unix 秒或 ISO 时间）`);
  const seconds = parseTimeInput(raw);
  if (seconds === null) invalid(field, `${field} 不是合法时间`);
  if (seconds < 0) invalid(field, `${field} 不能为负`);
  return seconds;
}

export function parseBoolean(raw: string | null, field: string): boolean | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  invalid(field, `${field} 只允许 true/false`);
}

export interface SessionsQuery {
  userId: number;
  start: number;
  end: number;
  model?: string;
  status?: number;
  failedOnly?: boolean;
  stream?: boolean;
  limit: number;
  cursor?: string;
}

export function parseSessionsQuery(searchParams: URLSearchParams): SessionsQuery {
  const userId = parsePositiveInt(searchParams.get("userId"), "userId");
  const start = parseEpoch(searchParams.get("start"), "start");
  const end = parseEpoch(searchParams.get("end"), "end");
  if (start >= end) invalid("end", "end 必须大于 start（区间左闭右开）");

  const model = searchParams.get("model") ?? undefined;
  if (model !== undefined && !MODEL_NAME_PATTERN.test(model)) {
    invalid("model", "model 只允许字母/数字/._-/@ 且长度 ≤128");
  }

  const statusRaw = searchParams.get("status");
  let status: number | undefined;
  if (statusRaw !== null && statusRaw.trim() !== "") {
    if (!/^\d{3}$/.test(statusRaw.trim())) invalid("status", "status 必须是三位状态码");
    status = Number(statusRaw.trim());
    if (status < 100 || status > 599) invalid("status", "status 必须在 100–599 之间");
  }

  const limitRaw = searchParams.get("limit");
  let limit = AUDIT_DEFAULT_PAGE_SIZE;
  if (limitRaw !== null && limitRaw.trim() !== "") {
    if (!/^\d+$/.test(limitRaw.trim())) invalid("limit", "limit 必须是正整数");
    limit = Number(limitRaw.trim());
    if (limit < 1 || limit > AUDIT_MAX_PAGE_SIZE) {
      invalid("limit", `limit 必须在 1–${AUDIT_MAX_PAGE_SIZE} 之间`);
    }
  }

  const cursor = searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined) decodeCursor(cursor);

  const stream = parseBoolean(searchParams.get("stream"), "stream");
  const failedOnly = parseBoolean(searchParams.get("failed"), "failed") === true;

  return {
    userId,
    start,
    end,
    ...(model === undefined ? {} : { model }),
    ...(status === undefined ? {} : { status }),
    ...(failedOnly ? { failedOnly } : {}),
    ...(stream === undefined ? {} : { stream }),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export interface DetailQuery {
  userId: number;
  date: string;
  fp?: string;
}

export function parseDetailQuery(searchParams: URLSearchParams): DetailQuery {
  const userId = parsePositiveInt(searchParams.get("userId"), "userId");
  const date = (searchParams.get("date") ?? "").trim();
  if (!AUDIT_DATE_PATTERN.test(date)) invalid("date", "date 必须是 YYYY-MM-DD");

  const fp = (searchParams.get("fp") ?? "").trim();
  if (fp !== "" && !FINGERPRINT_PATTERN.test(fp)) invalid("fp", "fp 必须是 12 位小写十六进制");

  return { userId, date, ...(fp === "" ? {} : { fp }) };
}
