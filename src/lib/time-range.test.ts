/** FE-M2-02 单测：前端时间范围工具（预设/自然日/自然月/参数解析）。 */
import { describe, expect, it } from "vitest";

import {
  DAY_SECONDS,
  GRANULARITIES,
  PRESETS,
  lastNDaysRange,
  parseEpochSeconds,
  parseGranularity,
  presetRange,
  resolveRangeFromParams,
  shanghaiDayStart,
  shanghaiMonthStart,
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
  it("start/end 合法则使用，否则回退今日", () => {
    expect(resolveRangeFromParams(String(NOV1), String(TODAY_START), NOW)).toEqual({
      start: NOV1,
      end: TODAY_START,
    });
    expect(resolveRangeFromParams(null, null, NOW)).toEqual({
      start: TODAY_START,
      end: TODAY_START + DAY_SECONDS,
    });
    expect(resolveRangeFromParams("abc", "-1", NOW)).toEqual({
      start: TODAY_START,
      end: TODAY_START + DAY_SECONDS,
    });
  });

  it("Unix 秒解析与粒度回退", () => {
    expect(parseEpochSeconds("1760000000")).toBe(1_760_000_000);
    expect(parseEpochSeconds("0")).toBeNull();
    expect(parseEpochSeconds("-1")).toBeNull();
    expect(parseEpochSeconds("1.5")).toBeNull();
    expect(parseEpochSeconds(null)).toBeNull();

    expect(parseGranularity("week")).toBe("week");
    expect(parseGranularity("month")).toBe("month");
    expect(parseGranularity("hour")).toBe("day");
    expect(parseGranularity(null)).toBe("day");
  });
});
