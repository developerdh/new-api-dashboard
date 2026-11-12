"use client";

/** 每日消耗日历热力图：窗口长度由调用方传入的固定序列决定（当前为近半年）。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useTheme } from "@/app/providers";
import { EChart } from "@/components/charts/EChart";
import type { TrendMetric } from "@/components/charts/trend-line";
import { readChartTheme, type ChartTheme } from "@/lib/chart-theme";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import type { TrendPoint } from "@/server/queries/trend";

function formatValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/** 纯函数便于单测：日历热力 option（日期标签 + 消耗强度）。 */
export function buildCalendarOption(
  points: TrendPoint[],
  theme: ChartTheme,
  metric: TrendMetric = "totalQuota",
): EChartsOption {
  const data = points.map((point) => [point.label, point[metric]]);
  const max = Math.max(1, ...points.map((point) => point[metric]));
  const first = points[0]?.label;
  const last = points[points.length - 1]?.label;

  return {
    tooltip: {
      formatter: (params: { value?: unknown }) => {
        const value = params.value as [string, number] | undefined;
        if (!Array.isArray(value)) return "";
        return `${value[0]}：${formatValue(metric, value[1])}`;
      },
    },
    visualMap: {
      min: 0,
      max,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 80,
      textStyle: { color: theme.mutedForeground },
      inRange: {
        color: [
          theme.mode === "dark" ? "#262626" : "#f1f5f9",
          theme.palette[1] ?? "#2a9d8f",
          theme.palette[0] ?? "#e76f51",
        ],
      },
      calculable: false,
    },
    calendar: {
      top: 36,
      left: 44,
      right: 16,
      bottom: 24,
      cellSize: ["auto", 12],
      range: first !== undefined && last !== undefined ? [first, last] : undefined,
      itemStyle: { color: "transparent", borderWidth: 1, borderColor: theme.border },
      yearLabel: { show: false },
      dayLabel: { firstDay: 1, nameMap: "ZH", color: theme.mutedForeground },
      monthLabel: { nameMap: "ZH", color: theme.mutedForeground },
      splitLine: { show: false },
    },
    series: [
      {
        type: "heatmap",
        coordinateSystem: "calendar",
        itemStyle: { borderRadius: 2 },
        data,
      },
    ],
  } as unknown as EChartsOption;
}

export interface CalendarHeatmapProps {
  points: TrendPoint[];
  height?: number | string;
  exportName?: string;
  metric?: TrendMetric;
}

export function CalendarHeatmap({
  points,
  height = 190,
  exportName = "heatmap",
  metric = "totalQuota",
}: CalendarHeatmapProps) {
  const { resolvedTheme } = useTheme();
  // 主题切换后 class 已先写入 DOM，需重读 CSS 变量再重建 option
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolvedTheme 仅用于触发重读，readChartTheme 内部读取 DOM
  const theme = useMemo(() => readChartTheme(), [resolvedTheme]);
  const option = useMemo(
    () => buildCalendarOption(points, theme, metric),
    [points, theme, metric],
  );

  return (
    <EChart
      option={option}
      height={height}
      empty={points.length === 0}
      emptyMessage="暂无热力图数据"
      ariaLabel="每日消耗日历热力图"
      exportName={exportName}
    />
  );
}
