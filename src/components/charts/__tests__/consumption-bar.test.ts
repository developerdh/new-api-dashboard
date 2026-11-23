/** 单测：消耗分布柱状 option 构建（未来小时 null、单日标签压缩、维度格式化）。 */
import { describe, expect, it } from "vitest";

import { buildDistributionOption } from "@/components/charts/consumption-bar";
import type { TrendPoint } from "@/server/queries/trend";

/** 2026-11-10 00:00:00 +08 = 1794240000。 */
const T0 = 1_794_240_000;
const HOUR = 3_600;
const DAY = 86_400;

/** 构造 2026-11-10 的小时桶点（label 与服务端 bucketLabel(hour) 同格式）。 */
function hourPoint(hour: number, quota = 0): TrendPoint {
  return {
    bucketStart: T0 + hour * HOUR,
    label: `11-10 ${String(hour).padStart(2, "0")}:00`,
    totalQuota: quota,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestCount: 0,
    activeUsers: 0,
  };
}

function dayPoint(day: number): TrendPoint {
  return { ...hourPoint(0), bucketStart: T0 + day * DAY, label: `2026-1${day % 10}-10` };
}

interface BarOption {
  series: Array<{ name: string; data: unknown[] }>;
  xAxis: { data: string[] };
  tooltip: { formatter: (params: unknown) => string };
}

function asBarOption(option: unknown): BarOption {
  return option as BarOption;
}

describe("buildDistributionOption", () => {
  it("hour：未来整点桶渲染 null，已发生桶保留值", () => {
    const points = Array.from({ length: 24 }, (_, hour) => hourPoint(hour, hour + 1));
    const option = asBarOption(buildDistributionOption(points, "hour", "totalQuota", T0 + 16 * HOUR));
    const data = option.series[0].data;

    // 00:00–15:00 已发生（15:00 桶的右边界 16:00 不超过 now）→ 保留值
    expect(data.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, hour) => hour + 1));
    // 16:00–23:00 未到 → null（与 0 区分）
    expect(data.slice(16)).toEqual(Array.from({ length: 8 }, () => null));
  });

  it("hour：已结束区间（昨日）无 null", () => {
    const points = Array.from({ length: 24 }, (_, hour) => hourPoint(hour));
    const option = asBarOption(
      buildDistributionOption(points, "hour", "totalQuota", T0 + 2 * DAY),
    );
    expect(option.series[0].data.every((value) => value === 0)).toBe(true);
  });

  it("单自然日区间：x 轴标签压缩为 HH:00；tooltip 仍用完整标签", () => {
    const points = Array.from({ length: 24 }, (_, hour) => hourPoint(hour));
    const option = asBarOption(
      buildDistributionOption(points, "hour", "totalQuota", T0 + 2 * DAY),
    );

    expect(option.xAxis.data[0]).toBe("00:00");
    expect(option.xAxis.data[23]).toBe("23:00");
    expect(option.tooltip.formatter({ dataIndex: 8, value: 0 })).toBe("11-10 08:00：$0.00");
  });

  it("跨日 hour 区间不压缩标签", () => {
    const points = [...Array.from({ length: 24 }, (_, hour) => hourPoint(hour)), ...Array.from({ length: 24 }, (_, hour) => ({
      ...hourPoint(hour),
      bucketStart: T0 + DAY + hour * HOUR,
      label: `11-11 ${String(hour).padStart(2, "0")}:00`,
    }))];
    const option = asBarOption(
      buildDistributionOption(points, "hour", "totalQuota", T0 + 3 * DAY),
    );

    expect(option.xAxis.data[0]).toBe("11-10 00:00");
    expect(option.xAxis.data[24]).toBe("11-11 00:00");
  });

  it("day 单位：不做未来 null（末桶覆盖当前时间也正常展示）", () => {
    const points = [dayPoint(0), dayPoint(1)];
    // now 落在第二天的桶内
    const option = asBarOption(
      buildDistributionOption(points, "day", "totalQuota", T0 + DAY + 3_600),
    );
    expect(option.series[0].data).toEqual([0, 0]);
    expect(option.xAxis.data[1]).toBe("2026-11-10");
  });

  it("metric=requestCount 时柱高取请求数，tooltip 文案随维度", () => {
    const points = [{ ...hourPoint(0), requestCount: 42 }, { ...hourPoint(1), requestCount: 7 }];
    const option = asBarOption(
      buildDistributionOption(points, "hour", "requestCount", T0 + 2 * DAY),
    );

    expect(option.series[0].name).toBe("请求数");
    expect(option.series[0].data).toEqual([42, 7]);
    expect(option.tooltip.formatter({ dataIndex: 0, value: 42 })).toBe("11-10 00:00：42");
  });

  it("tooltip：null 桶提示「未到」", () => {
    const points = Array.from({ length: 24 }, (_, hour) => hourPoint(hour));
    const option = asBarOption(buildDistributionOption(points, "hour", "totalQuota", T0 + 12 * HOUR));

    expect(option.tooltip.formatter({ dataIndex: 20, value: null })).toBe("11-10 20:00：未到");
  });
});
