/** 单测：趋势 option 构建（对比期虚线、tooltip 逐桶较上期/较去年同期标注、对照缺失不显示）。 */
import { describe, expect, it } from "vitest";

import { buildTrendOption } from "@/components/charts/trend-line";
import type { TrendPoint } from "@/server/queries/trend";

function point(label: string, quota: number): TrendPoint {
  return {
    bucketStart: 0,
    label,
    totalQuota: quota,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestCount: 0,
    activeUsers: 0,
  };
}

interface LineOption {
  series: Array<{ name: string; data: unknown[] }>;
  tooltip: { formatter: (params: unknown) => string };
}

function asLineOption(option: unknown): LineOption {
  return option as LineOption;
}

const points = [point("11-01", 100), point("11-02", 150), point("11-03", 300)];

describe("buildTrendOption", () => {
  it("无对比时 tooltip 只展示当前序列数值", () => {
    const option = asLineOption(buildTrendOption(points, undefined, "totalQuota"));
    expect(option.series.length).toBe(1);
    const html = option.tooltip.formatter([{ dataIndex: 1, seriesName: "消耗额度", value: 150 }]);
    expect(html).toBe("消耗额度：$0.0003");
    expect(html).not.toContain("较上期");
  });

  it("环比模式：逐桶附加「较上期 ▲/▼」", () => {
    const compare = [point("10-01", 100), point("10-02", 0), null];
    const option = asLineOption(buildTrendOption(points, compare, "totalQuota", "prev"));
    expect(option.series.length).toBe(2);
    expect(option.series[1].data).toEqual([100, 0, null]);

    // 同位置 100→150
    expect(option.tooltip.formatter([{ dataIndex: 0, seriesName: "消耗额度", value: 100 }])).toBe(
      "消耗额度：$0.0002<br/>较上期 0%",
    );
    // 对照为 0 → 不显示百分比行
    expect(option.tooltip.formatter([{ dataIndex: 1, seriesName: "消耗额度", value: 150 }])).toBe(
      "消耗额度：$0.0003",
    );
    // 对照为 null → 不显示百分比行
    expect(option.tooltip.formatter([{ dataIndex: 2, seriesName: "消耗额度", value: 300 }])).toBe(
      "消耗额度：$0.0006",
    );
  });

  it("同比文案：较去年同期", () => {
    const compare = [point("11-01", 100), point("11-02", 100), point("11-03", 100)];
    const option = asLineOption(buildTrendOption(points, compare, "totalQuota", "yoy"));
    expect(option.tooltip.formatter([{ dataIndex: 2, seriesName: "消耗额度", value: 300 }])).toBe(
      "消耗额度：$0.0006<br/>较去年同期 ▲ +200%",
    );
  });

  it("对比期虚线值也进 tooltip 行", () => {
    const compare = [point("10-01", 50), point("10-02", 50), point("10-03", 50)];
    const option = asLineOption(buildTrendOption(points, compare, "totalQuota", "prev"));
    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesName: "消耗额度", value: 100 },
      { dataIndex: 0, seriesName: "对比期", value: 50 },
    ]) as string;
    expect(html).toContain("消耗额度：$0.0002");
    expect(html).toContain("对比期：$0.0001");
    expect(html).toContain("较上期 ▲ +100%");
  });
});
