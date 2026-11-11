/**
 * 查询公共基座（BE-M1-01）：统一参数校验、Unix 秒 + Asia/Shanghai 时间语义、缓存接入。
 *
 * M1 其余统计卡（BE-M1-02~06）统一走这里，不允许各自解析参数：
 * ```ts
 * const params = normalizeQueryParams(request.nextUrl.searchParams);
 * const { data, cached } = await cachedQuery(queryCacheKey("overview", params), SCOPE_TTL_MS.overview, load);
 * return ok(data, metaFromParams(params, cached));
 * ```
 *
 * 时间口径（方案 §4/§5）：
 * - 参数 `start`/`end` 接受 ISO 字符串或 Unix 秒，统一归一为**整数 Unix 秒**，区间左闭右开 `[start, end)`；
 * - ISO 字符串**无时区**时按 Asia/Shanghai 解释（`2026-11-10` → 东八区当日 00:00），避免跟随运行环境时区；
 * - 日/周/月边界一律按 Asia/Shanghai 计算；周起点与 PG `DATE_TRUNC('week', …)` 一致 = **周一**；
 * - JS 只用于区间换算，趋势桶起点以 SQL（方案 §5 的 `DATE_TRUNC(... AT TIME ZONE 'Asia/Shanghai')`）为准。
 */
import { z } from "zod";

import { CACHE_TTL_MS, cacheKey, getCache, getOrCache, type CacheScope } from "@/server/cache";
import { toQueryIssues, type ApiGranularity, type ApiMeta, type QueryIssue } from "@/server/http";

/** 粒度白名单（顺序固定，供 Zod enum 与 UI 复用）。 */
export const GRANULARITIES = ["day", "week", "month"] as const;

/** 与 `ApiGranularity` 同一联合类型（API 契约层定义，此处别名便于查询层引用）。 */
export type Granularity = ApiGranularity;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;

/** 允许 2100-01-01 之前的 Unix 秒（与 `cache.ts` 的 key 校验口径一致）。 */
export const MAX_EPOCH_SECONDS = 4_102_444_800;

/** modelName 白名单：与 `cache.ts` 的 key 校验同规则（改一处必须同步另一处 + 单测）。 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._@/-]{1,128}$/;

/** 归一化后的查询参数（start/end 均为整数 Unix 秒）。 */
export interface QueryParams {
  start: number;
  end: number;
  granularity?: Granularity;
  userId?: number;
  modelName?: string;
  limit: number;
}

export interface QueryRange {
  start: number;
  end: number;
}

/** 参数非法：调用方捕获后返回 `invalidQuery(error.issues)`。 */
export class QueryValidationError extends Error {
  readonly code = "invalid_query";
  readonly issues: QueryIssue[];

  constructor(issues: QueryIssue[]) {
    super("查询参数不合法");
    this.name = "QueryValidationError";
    this.issues = issues;
  }
}

function snippet(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const clipped = text.length > 32 ? `${text.slice(0, 32)}…` : text;
  return JSON.stringify(clipped);
}

/** 无时区的 ISO 字符串统一按 Asia/Shanghai（+08:00）解释。 */
function toShanghaiIso(text: string): string {
  const withT = text.includes("T") ? text : text.replace(" ", "T");
  return withT.includes("T") ? `${withT}+08:00` : `${withT}T00:00:00+08:00`;
}

/**
 * ISO / Unix 秒 → 整数 Unix 秒（向下取整）；无法解析返回 null。
 * 纯数字字符串按 Unix 秒处理（`"1760000000"`），其余按 ISO 解析。
 */
export function parseTimeInput(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }

  const text = value.trim();
  if (text === "") return null;
  if (/^-?\d+$/.test(text)) return Number(text);

  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const milliseconds = Date.parse(hasZone ? text : toShanghaiIso(text));
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1000);
}

const epochSecondsSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const seconds = parseTimeInput(value);
    if (seconds === null) {
      ctx.addIssue({ code: "custom", message: `时间格式不合法：${snippet(value)}` });
      return z.NEVER;
    }
    return seconds;
  })
  .pipe(z.number().int().min(0).max(MAX_EPOCH_SECONDS, "时间戳超出允许范围（Unix 秒）"));

/** 公共查询参数 schema（未知参数被忽略；`limit` 缺省 20）。 */
export const queryParamsSchema = z
  .object({
    start: epochSecondsSchema,
    end: epochSecondsSchema,
    granularity: z.enum(GRANULARITIES).optional(),
    userId: z.coerce.number().int().positive().optional(),
    modelName: z
      .string()
      .regex(MODEL_NAME_PATTERN, "modelName 只允许字母/数字/._-/@ 且长度 ≤128")
      .refine((value) => value !== "all", "modelName 不能是保留值 all")
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .refine((value) => value.start < value.end, {
    message: "end 必须大于 start（区间为左闭右开）",
    path: ["end"],
  });

export type RawQueryParams = z.input<typeof queryParamsSchema>;

/**
 * 参数入口：`URLSearchParams` 或普通对象 → `QueryParams`。
 * 非法时抛 `QueryValidationError`（`issues` 已按字段聚合）。
 */
export function normalizeQueryParams(
  input: URLSearchParams | Record<string, unknown>,
): QueryParams {
  const raw = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : input;
  const parsed = queryParamsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QueryValidationError(toQueryIssues(parsed.error));
  }
  const { start, end, granularity, userId, modelName, limit } = parsed.data;
  return { start, end, granularity, userId, modelName, limit };
}

/* ------------------------------------------------------------------ */
/* Asia/Shanghai 时间工具                                              */
/* ------------------------------------------------------------------ */

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const SHANGHAI_OFFSET_FALLBACK_SECONDS = 8 * 3600;

const shanghaiPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHANGHAI_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function shanghaiCivilParts(epochSeconds: number): CivilParts {
  const parts = shanghaiPartsFormatter.formatToParts(new Date(epochSeconds * 1000));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Asia/Shanghai 相对 UTC 的偏移（秒，正常为 28800；按时刻查询以兼容历史夏令时）。 */
export function shanghaiOffsetSeconds(epochSeconds: number): number {
  const { year, month, day, hour, minute, second } = shanghaiCivilParts(epochSeconds);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  const offset = Math.round(asUtc - epochSeconds);
  return Number.isFinite(offset) ? offset : SHANGHAI_OFFSET_FALLBACK_SECONDS;
}

/** Asia/Shanghai 本地民用时间 → Unix 秒（迭代一次修正偏移，避免跨越夏令时边界时错 1 小时）。 */
function civilToEpochSeconds(parts: CivilParts): number {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) / 1000;
  let candidate = asUtc;
  for (let i = 0; i < 2; i += 1) {
    candidate = asUtc - shanghaiOffsetSeconds(candidate);
  }
  return candidate;
}

/** 东八区当日 00:00:00。 */
export function shanghaiDayStart(epochSeconds: number): number {
  const parts = shanghaiCivilParts(epochSeconds);
  return civilToEpochSeconds({ ...parts, hour: 0, minute: 0, second: 0 });
}

/** 东八区当周周一 00:00:00（与 PG `DATE_TRUNC('week', …)` 一致）。 */
export function shanghaiWeekStart(epochSeconds: number): number {
  const dayStart = shanghaiDayStart(epochSeconds);
  const civilText = shanghaiDate(dayStart);
  const weekday = new Date(`${civilText}T00:00:00Z`).getUTCDay(); // 0=周日
  const daysSinceMonday = (weekday + 6) % 7;
  return addShanghaiDays(dayStart, -daysSinceMonday);
}

/** 东八区当月 1 日 00:00:00。 */
export function shanghaiMonthStart(epochSeconds: number): number {
  const parts = shanghaiCivilParts(epochSeconds);
  return civilToEpochSeconds({ ...parts, day: 1, hour: 0, minute: 0, second: 0 });
}

/** 东八区自然日 `YYYY-MM-DD`（热力图/标签用）。 */
export function shanghaiDate(epochSeconds: number): string {
  const { year, month, day } = shanghaiCivilParts(epochSeconds);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 按自然日平移（东八区无夏令时，跨日按日历日计算）。 */
export function addShanghaiDays(epochSeconds: number, days: number): number {
  const parts = shanghaiCivilParts(epochSeconds);
  return civilToEpochSeconds({ ...parts, day: parts.day + days });
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 按自然月平移（目标月天数不足时钳到月末，保持时分秒）。 */
export function addShanghaiMonths(epochSeconds: number, months: number): number {
  const parts = shanghaiCivilParts(epochSeconds);
  const monthIndex = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return civilToEpochSeconds({ ...parts, year, month, day });
}

/** 按粒度取所在桶的起点（day/week/month → 对应 00:00:00）。 */
export function bucketStart(epochSeconds: number, granularity: Granularity): number {
  switch (granularity) {
    case "day":
      return shanghaiDayStart(epochSeconds);
    case "week":
      return shanghaiWeekStart(epochSeconds);
    case "month":
      return shanghaiMonthStart(epochSeconds);
  }
}

/**
 * 环比区间：整体按粒度平移一个自然单位（day → 前一天，week → 前 7 天，month → 上一个自然月）。
 * 注意 month 平移按日历月，起止长度可能不同（2 月 vs 3 月），属预期行为。
 */
export function prevRange(start: number, end: number, granularity: Granularity): QueryRange {
  switch (granularity) {
    case "day":
      return { start: addShanghaiDays(start, -1), end: addShanghaiDays(end, -1) };
    case "week":
      return { start: addShanghaiDays(start, -7), end: addShanghaiDays(end, -7) };
    case "month":
      return { start: addShanghaiMonths(start, -1), end: addShanghaiMonths(end, -1) };
  }
}

/** 同比区间：整体前移 12 个自然月。 */
export function yoyRange(start: number, end: number): QueryRange {
  return { start: addShanghaiMonths(start, -12), end: addShanghaiMonths(end, -12) };
}

/* ------------------------------------------------------------------ */
/* 缓存接入约定（与 BE-M0-04 对齐）                                     */
/* ------------------------------------------------------------------ */

/** scope → TTL 常量表（与 `cache.ts` 的 `CACHE_TTL_MS` 同源，禁止另建一份）。 */
export const SCOPE_TTL_MS = CACHE_TTL_MS;

export type QueryScope = CacheScope;

/** 归一化参数 → 确定性缓存 key（ISO 与 Unix 输入归一后必然同 key）。 */
export function queryCacheKey(scope: QueryScope, params: QueryParams): string {
  return cacheKey(scope, {
    start: params.start,
    end: params.end,
    granularity: params.granularity,
    userId: params.userId,
    modelName: params.modelName,
  });
}

/**
 * 缓存包装：先探测命中（用于 `meta.cached`），再走 `getOrCache`。
 * 命中判定与 TTL 口径完全交给缓存层，本函数不重复计时。
 */
export async function cachedQuery<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<{ data: T; cached: boolean }> {
  const hit = getCache().has(key);
  const data = await getOrCache(key, ttlMs, load);
  return { data, cached: hit };
}

/** 由归一化参数生成响应 meta。 */
export function metaFromParams(params: QueryParams, cached: boolean): ApiMeta {
  return {
    range: { start: params.start, end: params.end },
    granularity: params.granularity ?? null,
    cached,
  };
}
