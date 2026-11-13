/** 单测：格式化工具（数字/额度/日期/区间/增量）。 */
import { describe, expect, it } from "vitest";

import {
  QUOTA_PER_USD,
  formatBytes,
  formatCompactNumber,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDateTimeSecond,
  formatDelta,
  formatNumber,
  formatPercent,
  formatQuota,
  toDateInputValue,
} from "@/lib/format";

const T_DAY = 1_794_240_000; // 2026-11-10 00:00 +08
const DAY = 86_400;

describe("数字格式化", () => {
  it("千分位与紧凑写法", () => {
    expect(formatNumber(1_234_567)).toBe("1,234,567");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatCompactNumber(1_234_567)).toMatch(/123.5万/);
  });

  it("百分比与带符号增量", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(0.5, 0)).toBe("50%");
    expect(formatDelta(12.34)).toBe("+12.3%");
    expect(formatDelta(-5)).toBe("-5.0%");
    expect(formatDelta(Number.NaN)).toBe("—");
  });
});

describe("额度换算（New API quota → USD）", () => {
  it("默认 500000 quota = $1", () => {
    expect(QUOTA_PER_USD).toBe(500_000);
    expect(formatQuota(500_000)).toBe("$1.00");
    expect(formatQuota(250_000)).toBe("$0.50");
  });

  it("小于 0.01 时保留 4 位；自定义换算率生效", () => {
    expect(formatQuota(1_000)).toBe("$0.0020");
    expect(formatQuota(2, 1)).toBe("$2.00");
    expect(formatQuota(Number.NaN)).toBe("—");
  });
});

describe("日期格式化（Asia/Shanghai）", () => {
  it("日期/日期时间/input 值", () => {
    expect(formatDate(T_DAY)).toBe("2026/11/10");
    expect(formatDateTime(T_DAY)).toBe("2026/11/10 00:00");
    expect(formatDateTimeSecond(T_DAY + 62)).toBe("2026/11/10 00:01:02");
    expect(toDateInputValue(T_DAY)).toBe("2026-11-10");
    expect(formatDate(Number.NaN)).toBe("—");
  });

  it("字节数按 1024 进制格式化", () => {
    expect(formatBytes(913)).toBe("913 B");
    expect(formatBytes(1243)).toBe("1.2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("区间：同日折叠为一天，跨日显示 ~", () => {
    expect(formatDateRange(T_DAY, T_DAY + DAY)).toBe("2026/11/10");
    expect(formatDateRange(T_DAY, T_DAY + 2 * DAY)).toBe("2026/11/10 ~ 2026/11/11");
  });
});
