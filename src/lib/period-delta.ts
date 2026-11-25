/**
 * 周期对比逐期环比差分（周期对比卡专用）。
 *
 * 口径（specs/period-comparison「逐期环比百分比」）：
 * - 每期相对上一期的百分比变化；首期无上期不标注（null）；
 * - 上期值 ≤ 0 时不计算百分比（除零），同样不标注；
 * - 百分比保留 1 位小数；四舍五入后为 0 显示为持平（无 ▲/▼ 符号）；
 * - 中性展示：▲/▼ 只表达方向，不引入涨跌红绿语义。
 */
export interface PeriodDelta {
  /** 变化方向：`up` → ▲、`down` → ▼、`flat` → 无符号（四舍五入后为 0）。 */
  direction: "up" | "down" | "flat";
  /** 相对上期的百分比变化，保留 1 位小数（如 `12.5` 表示 +12.5%）。 */
  percent: number;
}

/** 单期环比：current vs previous；previous ≤ 0 或非有限值时返回 null。 */
export function periodDelta(current: number, previous: number): PeriodDelta | null {
  if (!Number.isFinite(previous) || previous <= 0) return null;
  if (!Number.isFinite(current)) return null;
  const raw = ((current - previous) / previous) * 100;
  const percent = Math.round(raw * 10) / 10;
  if (percent > 0) return { direction: "up", percent };
  if (percent < 0) return { direction: "down", percent };
  return { direction: "flat", percent: 0 };
}

/** 逐期环比序列：首期为 null，其余按相邻两期差分。 */
export function periodDeltas(values: number[]): Array<PeriodDelta | null> {
  return values.map((value, index) => (index === 0 ? null : periodDelta(value, values[index - 1])));
}

/** 柱顶标注文案：`▲ +12.5%` / `▼ 3.2%` / `0%`；null（不标注）返回空串。 */
export function formatPeriodDelta(delta: PeriodDelta | null): string {
  if (delta === null) return "";
  if (delta.direction === "flat") return "0%";
  const arrow = delta.direction === "up" ? "▲" : "▼";
  const sign = delta.direction === "up" ? "+" : "";
  return `${arrow} ${sign}${Math.abs(delta.percent)}%`;
}
