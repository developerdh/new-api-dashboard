/**
 * 监控接口的参数解析（与路由分离，便于单测）。
 *
 * 口径：`start`/`end` 与看板其余接口一致（Unix 秒或 ISO，左闭右开），
 * 而非 `02-design.md` §7.1 早期草案里的 `from`/`to`。
 *
 * 分页：`page`（1 基）+ `limit`（每页条数）。不用 cursor——聚合模式下
 * 「会话最后活动时间」与单条请求时间不同源，cursor 会让跨页的会话重复出现，
 * 而 offset 在「先全量分组、再切片」时是稳定的。
 */
import {
  DASHCAM_DEFAULT_PAGE_SIZE,
  DASHCAM_MAX_PAGE_SIZE,
  DASHCAM_DATE_PATTERN,
  DashcamQueryError,
  FINGERPRINT_PATTERN,
  TRACE_PATTERN,
  dashcamDayRange,
} from "@/server/dashcam/paths";
import { MODEL_NAME_PATTERN, parseTimeInput } from "@/server/queries/common";

export function invalid(path: string, message: string): never {
  throw new DashcamQueryError(message, [{ path, message }]);
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
  /** 列表粒度：request（默认，一行一请求）/ session（一行一会话） */
  group: "request" | "session";
  start: number;
  end: number;
  /** 指定单个自然日（东八区）；给了就覆盖 start/end，忽略客户端传的区间 */
  date?: string;
  model?: string;
  status?: number;
  failedOnly?: boolean;
  stream?: boolean;
  /** 每页条数 */
  limit: number;
  /** 页码，1 基 */
  page: number;
}

/** 日期参数 → 区间；未给 date 时按 start/end 口径校验。 */
function resolveWindow(
  searchParams: URLSearchParams,
): { start: number; end: number; date?: string } {
  const date = (searchParams.get("date") ?? "").trim();
  if (date !== "") {
    if (!DASHCAM_DATE_PATTERN.test(date)) invalid("date", "date 必须是 YYYY-MM-DD");
    // 单日优先：界面选「某一天」后不再要求 start/end，避免两套口径互相打架
    let window: { start: number; end: number };
    try {
      window = dashcamDayRange(date);
    } catch {
      // 形如 2026-11-31：格式对但日历日不存在
      invalid("date", "date 不是合法日期");
    }
    return { ...window, date };
  }
  const start = parseEpoch(searchParams.get("start"), "start");
  const end = parseEpoch(searchParams.get("end"), "end");
  if (start >= end) invalid("end", "end 必须大于 start（区间左闭右开）");
  return { start, end };
}

export function parseSessionsQuery(searchParams: URLSearchParams): SessionsQuery {
  const userId = parsePositiveInt(searchParams.get("userId"), "userId");
  const groupRaw = (searchParams.get("group") ?? "request").trim();
  if (groupRaw !== "request" && groupRaw !== "session") {
    invalid("group", "group 只允许 request/session");
  }
  const window = resolveWindow(searchParams);

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
  let limit = DASHCAM_DEFAULT_PAGE_SIZE;
  if (limitRaw !== null && limitRaw.trim() !== "") {
    if (!/^\d+$/.test(limitRaw.trim())) invalid("limit", "limit 必须是正整数");
    limit = Number(limitRaw.trim());
    if (limit < 1 || limit > DASHCAM_MAX_PAGE_SIZE) {
      invalid("limit", `limit 必须在 1–${DASHCAM_MAX_PAGE_SIZE} 之间`);
    }
  }

  const pageRaw = searchParams.get("page");
  const page = pageRaw === null || pageRaw.trim() === "" ? 1 : parsePositiveInt(pageRaw, "page");
  // 页码上限：单页 20 条、窗口最多 31 天，百万页已远超任何真实数据量，只为挡住明显的手改
  if (page > 1_000_000) invalid("page", "page 过大");

  const stream = parseBoolean(searchParams.get("stream"), "stream");
  const failedOnly = parseBoolean(searchParams.get("failed"), "failed") === true;

  return {
    userId,
    group: groupRaw,
    start: window.start,
    end: window.end,
    ...(window.date === undefined ? {} : { date: window.date }),
    ...(model === undefined ? {} : { model }),
    ...(status === undefined ? {} : { status }),
    ...(failedOnly ? { failedOnly } : {}),
    ...(stream === undefined ? {} : { stream }),
    limit,
    page,
  };
}

export interface DetailQuery {
  userId: number;
  date: string;
  fp?: string;
  /** 上一轮的定位信息：给了就计算线程增量（`prev` 与 `prevDate` 必须成对出现）。 */
  prev?: { traceId: string; date: string };
}

export function parseDetailQuery(searchParams: URLSearchParams): DetailQuery {
  const userId = parsePositiveInt(searchParams.get("userId"), "userId");
  const date = (searchParams.get("date") ?? "").trim();
  if (!DASHCAM_DATE_PATTERN.test(date)) invalid("date", "date 必须是 YYYY-MM-DD");

  const fp = (searchParams.get("fp") ?? "").trim();
  if (fp !== "" && !FINGERPRINT_PATTERN.test(fp)) invalid("fp", "fp 必须是 12 位小写十六进制");

  const prevTrace = (searchParams.get("prev") ?? "").trim();
  const prevDate = (searchParams.get("prevDate") ?? "").trim();
  let prev: DetailQuery["prev"];
  if (prevTrace !== "" || prevDate !== "") {
    if (!TRACE_PATTERN.test(prevTrace)) invalid("prev", "prev 必须是合法 trace id");
    if (!DASHCAM_DATE_PATTERN.test(prevDate)) invalid("prevDate", "prevDate 必须是 YYYY-MM-DD");
    prev = { traceId: prevTrace, date: prevDate };
  }

  return { userId, date, ...(fp === "" ? {} : { fp }), ...(prev === undefined ? {} : { prev }) };
}

export interface ThreadQuery {
  userId: number;
  /** 会话键哈希（16 位小写十六进制） */
  sessionKey: string;
  start: number;
  end: number;
  /** 指定单个自然日（东八区）；给了就覆盖 start/end，与列表接口口径一致 */
  date?: string;
}

export function parseThreadQuery(rawSessionKey: string, searchParams: URLSearchParams): ThreadQuery {
  const userId = parsePositiveInt(searchParams.get("userId"), "userId");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSessionKey);
  } catch {
    invalid("sessionKey", "sessionKey 编码非法");
  }
  const sessionKey = decoded.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(sessionKey)) {
    invalid("sessionKey", "sessionKey 必须是 16 位小写十六进制");
  }
  // 与 /api/dashcam/sessions 共用窗口解析：支持 date，也支持 start/end
  const window = resolveWindow(searchParams);
  return {
    userId,
    sessionKey,
    start: window.start,
    end: window.end,
    ...(window.date === undefined ? {} : { date: window.date }),
  };
}
