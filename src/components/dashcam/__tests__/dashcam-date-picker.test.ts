import { describe, expect, it } from "vitest";

import { buildMonth } from "@/components/dashcam/dashcam-date-picker";

describe("日历网格", () => {
  it("2026-11：1 号是周日，35 格（5 行），本月 30 天 + 下月 1–5 号补位", () => {
    const cells = buildMonth(2026, 11);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toMatchObject({ date: "2026-11-01", day: 1, inMonth: true });
    expect(cells[29]).toMatchObject({ date: "2026-11-30", day: 30, inMonth: true });
    expect(cells.slice(30).map((cell) => cell.date)).toEqual([
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
    ]);
  });

  it("跨年：2027-01 的前导格来自 2026-12", () => {
    const cells = buildMonth(2027, 1);
    expect(cells.length % 7).toBe(0);
    expect(cells[0]?.date).toMatch(/^2026-12-\d{2}$/);
    expect(cells[0]?.inMonth).toBe(false);
    expect(cells.find((cell) => cell.date === "2027-01-01")?.inMonth).toBe(true);
  });

  it("闰年 2 月有 29 天", () => {
    const cells = buildMonth(2028, 2);
    expect(cells.filter((cell) => cell.inMonth).map((cell) => cell.date)).toContain("2028-02-29");
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(29);
  });
});
