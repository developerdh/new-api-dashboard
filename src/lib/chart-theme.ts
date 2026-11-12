/**
 * ECharts 主题投递：把 CSS 变量映射为 option 的颜色，主题切换时重设 option。
 *
 * 为什么不 dispose 重建（卡内口径）：ECharts 无 setTheme API，重建会丢失缩放/图例状态；
 * 统一在 wrapper 里对 option 做「主题补全」，主题变化时 `setOption(themed, { notMerge: true })`。
 */
import type { EChartsOption } from "echarts";

export interface ChartTheme {
  mode: "light" | "dark";
  foreground: string;
  mutedForeground: string;
  border: string;
  card: string;
  palette: string[];
}

/** SSR 兜底：与新版 new-api 默认 preset 的蓝/青/紫/粉/绿图表色板对齐。 */
const FALLBACK_THEME: ChartTheme = {
  mode: "light",
  foreground: "#252525",
  mutedForeground: "#7a7a7a",
  border: "#ededed",
  card: "#ffffff",
  palette: ["#4aa3ff", "#17a9c4", "#a98bee", "#e07bc4", "#3ab584"],
};

/**
 * CSS 颜色 → sRGB。`--chart-*` 等变量的计算值是 `lab()` / `oklch()`（Tailwind v4 色彩空间），
 * ECharts 的 canvas 渲染器无法解析此类色值：色板会静默回落到内置默认色，
 * `visualMap` 渐变则直接渲染为黑色。用 1×1 canvas 实际绘制后读回像素，得到 sRGB 色值。
 */
function toSrgb(color: string): string {
  if (typeof document === "undefined") return color;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return color;

    // sentinel：若赋值后仍是哨兵值，说明浏览器无法解析该颜色，原样交回
    const sentinel = "#010203";
    ctx.fillStyle = sentinel;
    ctx.fillStyle = color;
    if (ctx.fillStyle === sentinel && !/#010203/i.test(color)) return color;

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 255) {
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    return color;
  }
}

/** 从 `<html>` 的 CSS 变量读取当前主题色（客户端调用；SSR 时返回亮色兜底）。 */
export function readChartTheme(): ChartTheme {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return FALLBACK_THEME;
  }
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value === "" ? fallback : toSrgb(value);
  };
  const palette = [1, 2, 3, 4, 5].map((index) =>
    read(`--chart-${index}`, FALLBACK_THEME.palette[index - 1] ?? FALLBACK_THEME.foreground),
  );

  return {
    mode: document.documentElement.classList.contains("dark") ? "dark" : "light",
    foreground: read("--foreground", FALLBACK_THEME.foreground),
    mutedForeground: read("--muted-foreground", FALLBACK_THEME.mutedForeground),
    border: read("--border", FALLBACK_THEME.border),
    card: read("--card", FALLBACK_THEME.card),
    palette,
  };
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 给单个坐标轴补主题色（保留调用方已显式设置的部分）。 */
function themeAxis(axis: unknown, theme: ChartTheme, withSplitLine: boolean): unknown {
  if (axis === undefined || axis === null) return axis;
  if (Array.isArray(axis)) {
    return axis.map((item) => themeAxis(item, theme, withSplitLine));
  }
  if (!isRecord(axis)) return axis;

  const axisLine = isRecord(axis.axisLine) ? axis.axisLine : {};
  const axisLabel = isRecord(axis.axisLabel) ? axis.axisLabel : {};
  const splitLine = isRecord(axis.splitLine) ? axis.splitLine : {};
  const lineStyle = isRecord(axisLine.lineStyle) ? axisLine.lineStyle : {};
  const splitStyle = isRecord(splitLine.lineStyle) ? splitLine.lineStyle : {};

  return {
    ...axis,
    axisLine: {
      ...axisLine,
      lineStyle: { color: theme.border, ...lineStyle },
    },
    axisLabel: { color: theme.mutedForeground, ...axisLabel },
    ...(withSplitLine
      ? {
          splitLine: {
            ...splitLine,
            lineStyle: { color: theme.border, type: "dashed", ...splitStyle },
          },
        }
      : {}),
  };
}

/** 给日历坐标系补主题色（热力图用）。 */
function themeCalendar(calendar: unknown, theme: ChartTheme): unknown {
  if (calendar === undefined || calendar === null) return calendar;
  if (Array.isArray(calendar)) return calendar.map((item) => themeCalendar(item, theme));
  if (!isRecord(calendar)) return calendar;

  const itemStyle = isRecord(calendar.itemStyle) ? calendar.itemStyle : {};
  const dayLabel = isRecord(calendar.dayLabel) ? calendar.dayLabel : {};
  const monthLabel = isRecord(calendar.monthLabel) ? calendar.monthLabel : {};
  const yearLabel = isRecord(calendar.yearLabel) ? calendar.yearLabel : {};

  return {
    ...calendar,
    itemStyle: { borderColor: theme.border, ...itemStyle },
    dayLabel: { color: theme.mutedForeground, ...dayLabel },
    monthLabel: { color: theme.mutedForeground, ...monthLabel },
    yearLabel: { color: theme.mutedForeground, ...yearLabel },
  };
}

/**
 * 深合并主题默认值：颜色板、文字色、tooltip、x/y 轴颜色、日历。
 * 不修改入参（返回新对象），调用方 option 的显式配置优先。
 */
export function applyChartTheme(option: EChartsOption, theme: ChartTheme): EChartsOption {
  const base = option as Record<string, unknown>;
  const textStyle = isRecord(base.textStyle) ? base.textStyle : {};
  const tooltip = isRecord(base.tooltip) ? base.tooltip : {};
  const tooltipTextStyle = isRecord(tooltip.textStyle) ? tooltip.textStyle : {};

  return {
    ...base,
    color: Array.isArray(base.color) ? base.color : theme.palette,
    textStyle: { color: theme.foreground, ...textStyle },
    tooltip: {
      backgroundColor: theme.card,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.foreground, ...tooltipTextStyle },
      ...tooltip,
    },
    ...(base.calendar === undefined ? {} : { calendar: themeCalendar(base.calendar, theme) }),
    xAxis: themeAxis(base.xAxis, theme, false),
    yAxis: themeAxis(base.yAxis, theme, true),
  } as EChartsOption;
}
