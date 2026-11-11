/** FE-M2-01 单测：ECharts 主题补全（纯函数，不依赖浏览器）。 */
import { describe, expect, it } from "vitest";

import { applyChartTheme, readChartTheme, type ChartTheme } from "@/lib/chart-theme";

const THEME: ChartTheme = {
  mode: "dark",
  foreground: "#fafafa",
  mutedForeground: "#a3a3a3",
  border: "#333333",
  card: "#171717",
  palette: ["#111111", "#222222"],
};

describe("applyChartTheme", () => {
  it("补全颜色板 / 文字色 / tooltip / 坐标轴", () => {
    const themed = applyChartTheme(
      {
        xAxis: { type: "category", data: ["a", "b"] },
        yAxis: { type: "value" },
        series: [{ type: "line", data: [1, 2] }],
      },
      THEME,
    ) as Record<string, unknown>;

    expect(themed.color).toEqual(THEME.palette);
    expect(themed.textStyle).toMatchObject({ color: THEME.foreground });

    const tooltip = themed.tooltip as Record<string, unknown>;
    expect(tooltip.backgroundColor).toBe(THEME.card);
    expect(tooltip.borderColor).toBe(THEME.border);

    const xAxis = themed.xAxis as Record<string, unknown>;
    expect((xAxis.axisLine as Record<string, unknown>).lineStyle).toMatchObject({
      color: THEME.border,
    });
    expect(xAxis.axisLabel).toMatchObject({ color: THEME.mutedForeground });

    const yAxis = themed.yAxis as Record<string, unknown>;
    expect(yAxis.splitLine).toBeDefined();
    expect((yAxis.splitLine as Record<string, unknown>).lineStyle).toMatchObject({
      color: THEME.border,
    });
  });

  it("调用方显式配置优先（颜色板 / tooltip / 轴标签）", () => {
    const themed = applyChartTheme(
      {
        color: ["#ff0000"],
        tooltip: { textStyle: { color: "#00ff00" } },
        xAxis: { type: "category", axisLabel: { color: "#123456" } },
      },
      THEME,
    ) as Record<string, unknown>;

    expect(themed.color).toEqual(["#ff0000"]);
    expect((themed.tooltip as Record<string, unknown>).textStyle).toMatchObject({
      color: "#00ff00",
    });
    expect((themed.xAxis as Record<string, unknown>).axisLabel).toMatchObject({
      color: "#123456",
    });
  });

  it("支持坐标轴数组，且不修改入参", () => {
    const option = {
      xAxis: [{ type: "category" as const }, { type: "category" as const }],
      yAxis: [{ type: "value" as const }],
    };
    const themed = applyChartTheme(option, THEME) as Record<string, unknown>;

    expect(Array.isArray(themed.xAxis)).toBe(true);
    expect((themed.xAxis as unknown[])).toHaveLength(2);
    // 入参未被写入主题色
    expect((option.xAxis[0] as Record<string, unknown>).axisLine).toBeUndefined();
  });
});

describe("readChartTheme", () => {
  it("无 DOM 环境返回亮色兜底", () => {
    const theme = readChartTheme();
    expect(theme.mode).toBe("light");
    expect(theme.palette.length).toBe(5);
  });
});
