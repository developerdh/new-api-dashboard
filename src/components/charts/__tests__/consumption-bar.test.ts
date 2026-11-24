/** 单测：消耗分布柱状 option 构建（未来小时 null、单日标签压缩、维度格式化、按模型堆叠）。 */
import { describe, expect, it } from "vitest";

import {
  buildDistributionOption,
  buildModelDistributionOption,
} from "@/components/charts/consumption-bar";
import type { ModelTrendSeries } from "@/server/queries/model";
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
  series: Array<{ name: string; stack?: string; data: unknown[] }>;
  xAxis: { data: string[] };
  yAxis: { axisLabel: { formatter: (value: number) => string } };
  tooltip: { formatter: (params: unknown) => string };
  legend?: unknown;
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

  it("纵轴单位随维度：额度 → $（quota 换算），请求数 → 紧凑数字", () => {
    const points = [hourPoint(0), hourPoint(1)];
    const quotaOption = asBarOption(
      buildDistributionOption(points, "hour", "totalQuota", T0 + 2 * DAY),
    );
    const countOption = asBarOption(
      buildDistributionOption(points, "hour", "requestCount", T0 + 2 * DAY),
    );

    // 50 万 quota = $1；纵轴不再出现 quota 原始值的紧凑形态（如 50万）
    expect(quotaOption.yAxis.axisLabel.formatter(500_000)).toBe("$1.00");
    expect(countOption.yAxis.axisLabel.formatter(1_200)).toBe("1200");
  });
});

describe("buildModelDistributionOption（按模型堆叠）", () => {
  const NOW = T0 + 2 * DAY;

  function modelSeries(name: string, values: Array<[hour: number, quota: number]>): ModelTrendSeries {
    return {
      modelName: name,
      points: values.map(([hour, quota]) => ({
        bucketStart: T0 + hour * HOUR,
        label: `11-10 ${String(hour).padStart(2, "0")}:00`,
        totalQuota: quota,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requestCount: 0,
      })),
    };
  }

  it("每模型一条堆叠序列 +「其他」= 合计 − Σ模型（不小于 0）", () => {
    const points = [
      { ...hourPoint(0, 1_000_000) }, // 合计 100 万：gpt 60 万 + claude 20 万 → 其他 20 万
      { ...hourPoint(1, 500_000) }, // 合计 50 万：gpt 30 万 + claude 20 万 → 其他 0
    ];
    const series = [
      modelSeries("gpt-4o", [[0, 600_000], [1, 300_000]]),
      modelSeries("claude", [[0, 200_000], [1, 200_000]]),
    ];

    const option = asBarOption(buildModelDistributionOption(points, series, "hour", "totalQuota", NOW));

    expect(option.series.map((item) => item.name)).toEqual(["gpt-4o", "claude", "其他"]);
    expect(option.series.every((item) => item.stack === "distribution")).toBe(true);
    expect(option.series[0]?.data).toEqual([600_000, 300_000]);
    expect(option.series[2]?.data).toEqual([200_000, 0]);
    expect(option.legend).toBeDefined();
  });

  it("模型分段恰好覆盖合计时不追加「其他」段", () => {
    const points = [{ ...hourPoint(0, 400_000) }];
    const series = [modelSeries("gpt-4o", [[0, 400_000]])];

    const option = asBarOption(buildModelDistributionOption(points, series, "hour", "totalQuota", NOW));

    expect(option.series.map((item) => item.name)).toEqual(["gpt-4o"]);
  });

  it("未来整点桶：全部分段（含其他）整桶 null，tooltip 提示「未到」", () => {
    const points = Array.from({ length: 24 }, (_, hour) => hourPoint(hour, 100));
    const series = [modelSeries("gpt-4o", [[0, 100]])];
    const option = asBarOption(
      buildModelDistributionOption(points, series, "hour", "totalQuota", T0 + 12 * HOUR),
    );

    for (const item of option.series) {
      expect(item.data).toHaveLength(24);
      // 未到小时（12 点起）：该桶全部分段整桶 null；已发生小时为数值
      expect(item.data.slice(12).every((value) => value === null)).toBe(true);
      expect(item.data.slice(0, 12).every((value) => value !== null)).toBe(true);
    }
    expect(option.tooltip.formatter([{ dataIndex: 20, seriesName: "gpt-4o", value: null }])).toBe(
      "11-10 20:00：未到",
    );
  });

  it("tooltip：合计行 + 模型明细（模型名转义）", () => {
    const points = [{ ...hourPoint(0, 1_000_000) }];
    const series = [
      modelSeries('<img onerror="x">', [[0, 400_000]]),
      modelSeries("gpt-4o", [[0, 600_000]]),
    ];
    const option = asBarOption(buildModelDistributionOption(points, series, "hour", "totalQuota", NOW));

    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesName: '<img onerror="x">', value: 400_000 },
      { dataIndex: 0, seriesName: "gpt-4o", value: 600_000 },
    ]);
    expect(html).toContain("合计 $2.00");
    expect(html).toContain("&lt;img onerror=&quot;x&quot;&gt;：$0.80");
    expect(html).toContain("gpt-4o：$1.20");
  });
});
