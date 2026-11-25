/** 单测：周期对比 option 构建（模型堆叠/其他差额、柱顶环比标注、残期 tooltip、维度格式化、周标签压缩）。 */
import { describe, expect, it } from "vitest";

import { buildPeriodOption } from "@/components/charts/period-comparison";
import type { ModelTrendSeries } from "@/server/queries/model";
import type { TrendPoint } from "@/server/queries/trend";

/** 2026-06-01 00:00:00 +08 = 1780243200；按自然月递增构造月窗口。 */
const M0 = 1_780_243_200;
const DAY = 86_400;

/** 近似自然月递增（测试固定 6 个月桶，直接用 UTC 月长即可，不追求边界秒级精确）。 */
function monthShift(start: number, months: number): number {
  const local = new Date((start + 8 * 3_600) * 1000);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1) / 1000 - 8 * 3_600
  );
}

function monthPoint(month: number, quota: number, requests = 0): TrendPoint {
  return {
    bucketStart: monthShift(M0, month),
    label: `2026-${String(month + 6).padStart(2, "0")}`,
    totalQuota: quota,
    totalTokens: quota * 10,
    promptTokens: 0,
    completionTokens: 0,
    requestCount: requests,
    activeUsers: 0,
  };
}

function modelSeries(name: string, values: number[]): ModelTrendSeries {
  return {
    modelName: name,
    points: values.map((quota, month) => ({
      bucketStart: monthShift(M0, month),
      label: `2026-${String(month + 6).padStart(2, "0")}`,
      totalQuota: quota,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
    })),
  };
}

interface BarOption {
  series: Array<{
    name: string;
    stack?: string;
    data: unknown[];
    silent?: boolean;
    label?: { formatter: (params: { dataIndex?: number }) => string };
    labelLayout?: { hideOverlap: boolean };
  }>;
  xAxis: { data: string[] };
  yAxis: { axisLabel: { formatter: (value: number) => string } };
  tooltip: { formatter: (params: unknown) => string };
  legend?: { data?: string[] };
}

function asBarOption(option: unknown): BarOption {
  return option as BarOption;
}

function tooltipParam(dataIndex: number, seriesName?: string, value?: unknown): unknown {
  return [{ dataIndex, seriesName, value }];
}

describe("buildPeriodOption（合计单序列回落）", () => {
  const points = [0, 1, 2, 3, 4, 5].map((month) => monthPoint(month, (month + 1) * 100));

  it("无模型序列时为单序列合计柱，柱顶标注逐期环比", () => {
    const option = asBarOption(buildPeriodOption(points, undefined, "month", "totalQuota", M0 + 160 * DAY));
    expect(option.series.length).toBe(1);
    expect(option.series[0].data).toEqual([100, 200, 300, 400, 500, 600]);
    expect(option.series[0].label?.formatter({ dataIndex: 1 })).toBe("▲ +100%");
    expect(option.series[0].label?.formatter({ dataIndex: 0 })).toBe("");
    expect(option.series[0].labelLayout?.hideOverlap).toBe(true);
    expect(option.legend).toBeUndefined();
  });

  it("首期无上期不标注、上期为 0 不标注", () => {
    const withZero = [monthPoint(0, 0), monthPoint(1, 100), monthPoint(2, 50)];
    const option = asBarOption(buildPeriodOption(withZero, undefined, "month", "totalQuota", M0 + 80 * DAY));
    const label = option.series[0].label?.formatter;
    expect(label?.({ dataIndex: 0 })).toBe("");
    expect(label?.({ dataIndex: 1 })).toBe(""); // 上期 0 → 不标注
    expect(label?.({ dataIndex: 2 })).toBe("▼ 50%");
  });

  it("维度切换同步：请求数口径的数值与环比", () => {
    const points2 = [0, 1, 2].map((month) => monthPoint(month, month * 100, (month + 1) * 10));
    const option = asBarOption(buildPeriodOption(points2, undefined, "month", "requestCount", M0 + 90 * DAY));
    expect(option.series[0].data).toEqual([10, 20, 30]);
    expect(option.series[0].label?.formatter({ dataIndex: 2 })).toBe("▲ +50%");
    // y 轴格式化随维度走（请求数 → 紧凑数字，小数值原样）
    expect(option.yAxis.axisLabel.formatter(1234)).toBe("1234");
  });

  it("月窗口 x 轴保持 YYYY-MM 标签", () => {
    const option = asBarOption(buildPeriodOption(points, undefined, "month", "totalQuota", M0 + 160 * DAY));
    expect(option.xAxis.data).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  });
});

describe("buildPeriodOption（按模型堆叠）", () => {
  // 6 个月：合计 quota = 100/200/200/200/200/200；模型 A 前两月、B 全程
  const points = [
    monthPoint(0, 100),
    monthPoint(1, 200),
    monthPoint(2, 200),
    monthPoint(3, 200),
    monthPoint(4, 200),
    monthPoint(5, 200),
  ];
  const series = [modelSeries("model-a", [60, 80, 0, 0, 0, 0]), modelSeries("model-b", [30, 30, 30, 30, 30, 30])];

  it("堆叠段按桶起点对齐，其他段 = 合计 − Σ模型（仅在确有差额时出现）", () => {
    const option = asBarOption(buildPeriodOption(points, series, "month", "totalQuota", M0 + 160 * DAY));
    const names = option.series.map((item) => item.name);
    expect(names).toEqual(["model-a", "model-b", "其他", "_delta"]);
    expect(option.series[0].data).toEqual([60, 80, 0, 0, 0, 0]);
    expect(option.series[2].data).toEqual([10, 90, 170, 170, 170, 170]);

    // 全部由模型构成（无差额）→ 不追加其他段
    const exact = [
      monthPoint(0, 90),
      monthPoint(1, 110),
      monthPoint(2, 30),
      monthPoint(3, 30),
      monthPoint(4, 30),
      monthPoint(5, 30),
    ];
    const exactOption = asBarOption(
      buildPeriodOption(exact, [modelSeries("model-a", [60, 80, 0, 0, 0, 0]), modelSeries("model-b", [30, 30, 30, 30, 30, 30])], "month", "totalQuota", M0 + 160 * DAY),
    );
    expect(exactOption.series.map((item) => item.name)).toEqual(["model-a", "model-b", "_delta"]);
  });

  it("图例显式列名，排除透明环比承载段", () => {
    const option = asBarOption(buildPeriodOption(points, series, "month", "totalQuota", M0 + 160 * DAY));
    expect(option.legend?.data).toEqual(["model-a", "model-b", "其他"]);
  });

  it("环比标注挂在透明零值段上、按整桶合计计算", () => {
    const option = asBarOption(buildPeriodOption(points, series, "month", "totalQuota", M0 + 160 * DAY));
    const deltaSeries = option.series.find((item) => item.name === "_delta");
    expect(deltaSeries?.silent).toBe(true);
    expect(deltaSeries?.data).toEqual([0, 0, 0, 0, 0, 0]);
    // 合计 100→200 = ▲ +100%（模型分段涨跌不参与标注）
    expect(deltaSeries?.label?.formatter({ dataIndex: 1 })).toBe("▲ +100%");
  });

  it("空期（0 合计）无模型分段数值但仍占桶位", () => {
    const sparse = [monthPoint(0, 0), monthPoint(1, 0), monthPoint(2, 100), monthPoint(3, 100), monthPoint(4, 100), monthPoint(5, 100)];
    const option = asBarOption(buildPeriodOption(sparse, [modelSeries("model-a", [0, 0, 100, 100, 100, 100])], "month", "totalQuota", M0 + 160 * DAY));
    expect(option.series[0].data[0]).toBe(0);
    expect(option.series[0].data[2]).toBe(100);
    // 空期合计 0：其他段为 0，透明段仍补位
    const deltaSeries = option.series.find((item) => item.name === "_delta");
    expect(deltaSeries?.data[0]).toBe(0);
    expect(deltaSeries?.label?.formatter({ dataIndex: 2 })).toBe(""); // 上期 0 → 不标注
    expect(deltaSeries?.label?.formatter({ dataIndex: 3 })).toBe("0%");
  });
});

describe("buildPeriodOption（tooltip 与残期）", () => {
  const points = [0, 1, 2, 3, 4, 5].map((month) => monthPoint(month, (month + 1) * 100));
  const now = monthShift(M0, 5) + 25 * DAY; // 末桶（11 月）进行中

  it("残期 tooltip 标注「截至 MM-DD」并附合计与环比行", () => {
    const option = asBarOption(buildPeriodOption(points, undefined, "month", "totalQuota", now));
    const html = option.tooltip.formatter(tooltipParam(5)) as string;
    expect(html).toContain("2026-11（截至 11-26）");
    expect(html).toContain("合计");
    expect(html).toContain("较上期");
  });

  it("非残期不出现「截至」", () => {
    const option = asBarOption(buildPeriodOption(points, undefined, "month", "totalQuota", now));
    const html = option.tooltip.formatter(tooltipParam(2)) as string;
    expect(html).not.toContain("截至");
    expect(html).toContain("较上期 ▲ +50%");
  });

  it("首期 tooltip 无环比行", () => {
    const option = asBarOption(buildPeriodOption(points, undefined, "month", "totalQuota", now));
    const html = option.tooltip.formatter(tooltipParam(0)) as string;
    expect(html).not.toContain("较上期");
  });

  it("堆叠 tooltip 列出各模型分段绝对值（转义模型名）", () => {
    const series = [modelSeries("model-a", [100, 100, 100, 100, 100, 100]), modelSeries("model-b", [100, 100, 100, 100, 100, 100])];
    const option = asBarOption(buildPeriodOption(points, series, "month", "totalQuota", now));
    const html = option.tooltip.formatter([
      { dataIndex: 1, seriesName: "model-a", value: 100 },
      { dataIndex: 1, seriesName: "model-b", value: 100 },
    ]) as string;
    expect(html).toContain("model-a：");
    expect(html).toContain("model-b：");
    expect(html).toContain("合计");
  });

  it("周窗口 x 轴标签压缩为 MM-DD", () => {
    const w0 = 1_781_102_400; // 2026-06-08（周一）00:00 +08
    const weekPoints = Array.from({ length: 3 }, (_, week) => ({
      bucketStart: w0 + week * 7 * DAY,
      label: `2026-06-${String(8 + week * 7).padStart(2, "0")}`,
      totalQuota: 100,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
      activeUsers: 0,
    }));
    const option = asBarOption(
      buildPeriodOption(weekPoints, undefined, "week", "totalQuota", w0 + 20 * DAY),
    );
    expect(option.xAxis.data).toEqual(["06-08", "06-15", "06-22"]);
  });
});
