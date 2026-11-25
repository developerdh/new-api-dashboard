/** 单测：周期对比逐期环比差分（首期/除零不标注、方向符号、保留位数）。 */
import { describe, expect, it } from "vitest";

import { formatPeriodDelta, periodDelta, periodDeltas } from "@/lib/period-delta";

describe("periodDelta", () => {
  it("上涨 / 下跌 / 持平", () => {
    expect(periodDelta(150, 100)).toEqual({ direction: "up", percent: 50 });
    expect(periodDelta(75, 100)).toEqual({ direction: "down", percent: -25 });
    expect(periodDelta(100, 100)).toEqual({ direction: "flat", percent: 0 });
  });

  it("上期 ≤ 0 或非有限值不计算（除零防护）", () => {
    expect(periodDelta(10, 0)).toBeNull();
    expect(periodDelta(10, -5)).toBeNull();
    expect(periodDelta(10, Number.NaN)).toBeNull();
    expect(periodDelta(Number.NaN, 100)).toBeNull();
  });

  it("保留 1 位小数（0.05 边界四舍五入为持平）", () => {
    expect(periodDelta(112.34, 100)).toEqual({ direction: "up", percent: 12.3 });
    // JS Math.round(-3.25 * 10) = -32 → -3.2（向 +∞ 取半，用例固定该行为）
    expect(periodDelta(96.75, 100)).toEqual({ direction: "down", percent: -3.2 });
    expect(periodDelta(100.04, 100)).toEqual({ direction: "flat", percent: 0 });
    expect(periodDelta(99.95, 100)).toEqual({ direction: "flat", percent: 0 });
  });

  it("大涨幅与清零", () => {
    expect(periodDelta(1000, 100)).toEqual({ direction: "up", percent: 900 });
    expect(periodDelta(0, 100)).toEqual({ direction: "down", percent: -100 });
  });
});

describe("periodDeltas", () => {
  it("首期为 null，其余按相邻两期差分", () => {
    expect(periodDeltas([100, 150, 75, 0, 10])).toEqual([
      null,
      { direction: "up", percent: 50 },
      { direction: "down", percent: -50 },
      { direction: "down", percent: -100 }, // 本期为 0、上期有值 → ▼100%
      null, // 上期为 0 → 不标注
    ]);
  });

  it("空序列返回空数组", () => {
    expect(periodDeltas([])).toEqual([]);
  });
});

describe("formatPeriodDelta", () => {
  it("▲ 带正号、▼ 不带负号、持平无符号、null 空串", () => {
    expect(formatPeriodDelta({ direction: "up", percent: 12.5 })).toBe("▲ +12.5%");
    expect(formatPeriodDelta({ direction: "down", percent: -3.2 })).toBe("▼ 3.2%");
    expect(formatPeriodDelta({ direction: "flat", percent: 0 })).toBe("0%");
    expect(formatPeriodDelta(null)).toBe("");
  });
});
