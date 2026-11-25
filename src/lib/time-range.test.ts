/** 单测：前端时间范围工具（预设/自然日/自然月/参数解析）。 */
import { describe, expect, it } from "vitest";

import {
  DAY_SECONDS,
  GRANULARITIES,
  PERIOD_MONTHS,
  PERIOD_WEEKS,
  PRESETS,
  distributionGranularity,
  lastNDaysRange,
  parseEpochSeconds,
  parseGranularity,
  periodWindowRange,
  presetRange,
  resolveRangeFromParams,
  shanghaiDayStart,
  shanghaiMonthStart,
  shanghaiWeekStart,
  todayRange,
} from "@/lib/time-range";

/** 2026-11-11 09:00:00 +08 = 1794358800。 */
const NOW = 1_794_358_800;
const TODAY_START = 1_794_326_400; // 2026-11-11 00:00 +08
const NOV1 = 1_793_462_400; // 2026-11-01 00:00 +08

describe("上海自然日/月边界", () => {
  it("当日任意时刻归到当日 00:00", () => {
    expect(shanghaiDayStart(NOW)).toBe(TODAY_START);
    expect(shanghaiDayStart(TODAY_START)).toBe(TODAY_START);
    expect(shanghaiDayStart(TODAY_START - 1)).toBe(TODAY_START - DAY_SECONDS);
  });

  it("当月 1 日 00:00", () => {
    expect(shanghaiMonthStart(NOW)).toBe(NOV1);
    expect(shanghaiMonthStart(NOV1)).toBe(NOV1);
  });

  it("当周周一 00:00（与服务端 DATE_TRUNC('week') 口径一致）", () => {
    // 2026-11-11 是周三 → 本周周一为 2026-11-09 00:00 +08
    expect(shanghaiWeekStart(NOW)).toBe(Date.parse("2026-11-09T00:00:00+08:00") / 1000);
    // 周日归到前一周周一：2026-11-15（周日）→ 2026-11-09
    const sunday = Date.parse("2026-11-15T23:00:00+08:00") / 1000;
    expect(shanghaiWeekStart(sunday)).toBe(Date.parse("2026-11-09T00:00:00+08:00") / 1000);
    // 周一当天归到当天
    const monday = Date.parse("2026-11-09T10:00:00+08:00") / 1000;
    expect(shanghaiWeekStart(monday)).toBe(Date.parse("2026-11-09T00:00:00+08:00") / 1000);
  });
});

describe("预设区间", () => {
  it("今日/近7天/近30天（含今日）与本月", () => {
    expect(presetRange("today", NOW)).toEqual({ start: TODAY_START, end: TODAY_START + DAY_SECONDS });
    expect(presetRange("7d", NOW)).toEqual({
      start: TODAY_START - 6 * DAY_SECONDS,
      end: TODAY_START + DAY_SECONDS,
    });
    expect(presetRange("30d", NOW)).toEqual({
      start: TODAY_START - 29 * DAY_SECONDS,
      end: TODAY_START + DAY_SECONDS,
    });
    expect(presetRange("month", NOW)).toEqual({ start: NOV1, end: TODAY_START + DAY_SECONDS });
    expect(todayRange(NOW).start).toBe(TODAY_START);
  });

  it("近 N 天窗口（热力图用）", () => {
    const range = lastNDaysRange(365, NOW);
    expect(range.end).toBe(TODAY_START + DAY_SECONDS);
    expect(range.start).toBe(TODAY_START - 364 * DAY_SECONDS);
    expect(range.end - range.start).toBe(365 * DAY_SECONDS);
  });

  it("预设与粒度清单稳定（供 UI 渲染）", () => {
    expect(PRESETS.map((item) => item.key)).toEqual(["today", "7d", "30d", "month"]);
    expect(GRANULARITIES.map((item) => item.key)).toEqual(["day", "week", "month"]);
  });
});

describe("URL 参数解析", () => {
  it("start/end 合法则使用，否则回退近 30 天（趋势图需要多点）", () => {
    expect(resolveRangeFromParams(String(NOV1), String(TODAY_START), NOW)).toEqual({
      start: NOV1,
      end: TODAY_START,
    });
    const fallback = {
      start: TODAY_START - 29 * DAY_SECONDS,
      end: TODAY_START + DAY_SECONDS,
    };
    expect(resolveRangeFromParams(null, null, NOW)).toEqual(fallback);
    expect(resolveRangeFromParams("abc", "-1", NOW)).toEqual(fallback);
  });

  it("Unix 秒解析与粒度回退", () => {
    expect(parseEpochSeconds("1760000000")).toBe(1_760_000_000);
    expect(parseEpochSeconds("0")).toBeNull();
    expect(parseEpochSeconds("-1")).toBeNull();
    expect(parseEpochSeconds("1.5")).toBeNull();
    expect(parseEpochSeconds(null)).toBeNull();

    expect(parseGranularity("week")).toBe("week");
    expect(parseGranularity("month")).toBe("month");
    expect(parseGranularity("hour")).toBe("hour");
    expect(parseGranularity("quarter")).toBe("day");
    expect(parseGranularity(null)).toBe("day");
  });
});

describe("消耗分布分桶（distributionGranularity）", () => {
  it("1/2 个自然日 → hour，3 日 → day", () => {
    // 今日区间（NOW 当天 0 点到次日 0 点）
    expect(distributionGranularity({ start: TODAY_START, end: TODAY_START + DAY_SECONDS })).toBe(
      "hour",
    );
    // 两日
    expect(
      distributionGranularity({ start: TODAY_START - DAY_SECONDS, end: TODAY_START + DAY_SECONDS }),
    ).toBe("hour");
    // 三日
    expect(
      distributionGranularity({ start: TODAY_START - 2 * DAY_SECONDS, end: TODAY_START + DAY_SECONDS }),
    ).toBe("day");
  });

  it("非整日起点按覆盖的自然日数计算", () => {
    // start 落在昨日 12:00、end 为今日 12:00 → 覆盖 2 个自然日 → hour
    expect(
      distributionGranularity({
        start: TODAY_START - DAY_SECONDS / 2,
        end: TODAY_START + DAY_SECONDS / 2,
      }),
    ).toBe("hour");
  });

  it("92 个自然日 → day，93 个自然日 → week", () => {
    const end = TODAY_START + DAY_SECONDS;
    expect(distributionGranularity({ start: end - 92 * DAY_SECONDS, end })).toBe("day");
    expect(distributionGranularity({ start: end - 93 * DAY_SECONDS, end })).toBe("week");
    // 近 30 天预设 → day；自定义半年 → week
    expect(distributionGranularity(presetRange("30d", NOW))).toBe("day");
    expect(distributionGranularity({ start: NOV1 - 184 * DAY_SECONDS, end })).toBe("week");
  });
});

describe("周期对比固定窗口（periodWindowRange）", () => {
  it("月窗口 = 近 6 个自然月（含当前残月），end = now", () => {
    const range = periodWindowRange("month", NOW);
    expect(range.end).toBe(NOW);
    expect(range.start).toBe(Date.parse("2026-06-01T00:00:00+08:00") / 1000);
    expect(PERIOD_MONTHS).toBe(6);
  });

  it("月窗口跨年：3 月 → 前一年 10 月 1 日", () => {
    const march = Date.parse("2026-03-15T12:00:00+08:00") / 1000;
    expect(periodWindowRange("month", march).start).toBe(
      Date.parse("2025-10-01T00:00:00+08:00") / 1000,
    );
    // 月末时刻不影响起点（起点只取决于所在自然月）
    const monthEnd = Date.parse("2026-03-31T23:00:00+08:00") / 1000;
    expect(periodWindowRange("month", monthEnd).start).toBe(
      Date.parse("2025-10-01T00:00:00+08:00") / 1000,
    );
  });

  it("周窗口 = 近 12 个自然周（周一锚定，含当前残周），end = now", () => {
    const range = periodWindowRange("week", NOW);
    expect(range.end).toBe(NOW);
    // 本周周一 2026-11-09 前推 11 周 → 2026-08-24 00:00 +08
    expect(range.start).toBe(Date.parse("2026-08-24T00:00:00+08:00") / 1000);
    expect(PERIOD_WEEKS).toBe(12);
  });

  it("窗口内桶数与服务端分桶枚举一致（6 月桶 / 12 周桶）", () => {
    // 按服务端桶边界口径枚举：月窗口首桶对齐自然月 1 日，逐月 +1 共 6 桶
    const monthStarts: number[] = [];
    let cursor = periodWindowRange("month", NOW).start;
    while (cursor < NOW) {
      monthStarts.push(cursor);
      const local = new Date((cursor + 8 * 3_600) * 1000);
      cursor =
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 - 8 * 3_600;
    }
    expect(monthStarts.length).toBe(6);

    // 周窗口：周一锚定，逐周 +7 天共 12 桶
    const weekStarts: number[] = [];
    let week = periodWindowRange("week", NOW).start;
    while (week < NOW) {
      weekStarts.push(week);
      week += 7 * DAY_SECONDS;
    }
    expect(weekStarts.length).toBe(12);
  });
});
