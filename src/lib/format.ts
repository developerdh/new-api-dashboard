/**
 * 数字 / 额度 / 日期格式化。
 *
 * 口径：后端 `quota` 原值透传（New API 额度单位），展示层换算为金额；
 * New API 默认 500000 quota = $1（可在后续卡片改成可配置项）。
 */
export const QUOTA_PER_USD = 500_000;

const numberFormatter = new Intl.NumberFormat("zh-CN");

const compactFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateTimeSecondFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `<input type="date">` 需要 `YYYY-MM-DD`（en-CA 输出即该格式）。 */
const dateInputFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 千分位整数（1234567 → 1,234,567）。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return numberFormatter.format(value);
}

/** 紧凑数字（1234567 → 123.5万）。 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return compactFormatter.format(value);
}

/** New API quota → 美元金额（500000 quota = $1，保留 2 位；小于 0.01 时保留 4 位）。 */
export function formatQuota(quota: number, quotaPerUsd: number = QUOTA_PER_USD): string {
  if (!Number.isFinite(quota)) return "—";
  const usd = quota / quotaPerUsd;
  const digits = Math.abs(usd) > 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return `$${usd.toFixed(digits)}`;
}

/** 大数 → 百万（M）单位，保留 1 位小数（12917870424 → 12917.9M）。 */
export function formatMillions(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 字节数（1024 进制，保留 1 位小数）：913 → 913 B，1243 → 1.2 KB。 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 秒差 → 人类可读跨度（会话「起止跨度」用：`42 秒` / `12 分` / `3.2 小时` / `2.0 天`）。
 * 只服务聚合列表的一列，不追求精确到分秒。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

/** 比例 → 百分比字符串（0.1234 → 12.3%）。 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** Unix 秒 → 东八区 `YYYY-MM-DD`。 */
export function formatDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "—";
  return dateFormatter.format(new Date(epochSeconds * 1000));
}

/** Unix 秒 → 东八区 `YYYY-MM-DD HH:mm`。 */
export function formatDateTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "—";
  return dateTimeFormatter.format(new Date(epochSeconds * 1000));
}

/**
 * Unix 秒 → 东八区 `YYYY-MM-DD HH:mm:ss`。
 * 监控列表按秒区分请求（同一分钟内可能有多条），故不能用分钟精度。
 */
export function formatDateTimeSecond(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "—";
  return dateTimeSecondFormatter.format(new Date(epochSeconds * 1000));
}

/** Unix 秒 → 东八区 `YYYY-MM-DD`（供 `<input type="date">` 使用）。 */
export function toDateInputValue(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "";
  return dateInputFormatter.format(new Date(epochSeconds * 1000));
}

/** 区间标签：同日只显示一天，否则 `起 ~ 止`（右端为开区间，展示时回退 1 秒）。 */
export function formatDateRange(start: number, end: number): string {
  const startLabel = formatDate(start);
  const endLabel = formatDate(Math.max(start, end - 1));
  return startLabel === endLabel ? startLabel : `${startLabel} ~ ${endLabel}`;
}

/** 有符号增量（用于指标卡环比文案）。 */
export function formatDelta(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}
