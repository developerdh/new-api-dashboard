/**
 * 时间范围工具（起的前端共享件，供选择器与页面复用）。
 *
 * 口径与后端一致：Unix 秒、`[start, end)`、Asia/Shanghai 自然日/自然月。
 * 东八区自 1991 年后无夏令时，故用固定 +8h 偏移做自然日分桶。
 */
export const DAY_SECONDS = 86_400;
export const SHANGHAI_OFFSET_SECONDS = 8 * 3_600;

export type Granularity = "day" | "week" | "month";

export interface TimeRange {
  start: number;
  end: number;
}

export type RangePreset = "today" | "7d" | "30d" | "month";

export const PRESETS: ReadonlyArray<{ key: RangePreset; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "month", label: "本月" },
];

/** 缺省区间：近 30 天。单日区间下折线只有 1 个点且隐藏 symbol，趋势与对比线都不可见。 */
export const DEFAULT_RANGE_PRESET: RangePreset = "30d";

export const GRANULARITIES: ReadonlyArray<{ key: Granularity; label: string }> = [
  { key: "day", label: "日" },
  { key: "week", label: "周" },
  { key: "month", label: "月" },
];

/** 东八区当日 00:00:00（Unix 秒）。 */
export function shanghaiDayStart(epochSeconds: number): number {
  const local = epochSeconds + SHANGHAI_OFFSET_SECONDS;
  return Math.floor(local / DAY_SECONDS) * DAY_SECONDS - SHANGHAI_OFFSET_SECONDS;
}

/** 东八区当月 1 日 00:00:00（Unix 秒）。 */
export function shanghaiMonthStart(epochSeconds: number): number {
  const localDate = new Date((epochSeconds + SHANGHAI_OFFSET_SECONDS) * 1000);
  const localMonthStart =
    Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), 1) / 1000;
  return localMonthStart - SHANGHAI_OFFSET_SECONDS;
}

/** 今日（东八区自然日）区间。 */
export function todayRange(nowSeconds: number = Math.floor(Date.now() / 1000)): TimeRange {
  const start = shanghaiDayStart(nowSeconds);
  return { start, end: start + DAY_SECONDS };
}

/** 预设区间（都包含今日）。 */
export function presetRange(
  preset: RangePreset,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TimeRange {
  const today = todayRange(nowSeconds);
  switch (preset) {
    case "today":
      return today;
    case "7d":
      return { start: today.start - 6 * DAY_SECONDS, end: today.end };
    case "30d":
      return { start: today.start - 29 * DAY_SECONDS, end: today.end };
    case "month":
      return { start: shanghaiMonthStart(today.start), end: today.end };
  }
}

/** 近 N 天（含今日）区间；用于热力图等固定窗口。 */
export function lastNDaysRange(
  days: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TimeRange {
  const today = todayRange(nowSeconds);
  return { start: today.start - (days - 1) * DAY_SECONDS, end: today.end };
}

/** URL 参数 → 整数 Unix 秒；非法返回 null。 */
export function parseEpochSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** URL 参数 → 粒度；缺省/非法回退 day（与后端 schema 一致）。 */
export function parseGranularity(value: string | null): Granularity {
  return value === "week" || value === "month" ? value : "day";
}

/** URL 参数 → 区间；缺省回退 `DEFAULT_RANGE_PRESET`（不写回 URL，由选择器负责写入）。 */
export function resolveRangeFromParams(
  startParam: string | null,
  endParam: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TimeRange {
  const fallback = presetRange(DEFAULT_RANGE_PRESET, nowSeconds);
  return {
    start: parseEpochSeconds(startParam) ?? fallback.start,
    end: parseEpochSeconds(endParam) ?? fallback.end,
  };
}
