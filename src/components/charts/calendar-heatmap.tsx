"use client";

/** 每日消耗日历热力图（FE-M2-02）：近一年（固定窗口，卡内口径）。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useTheme } from "@/app/providers";
import { EChart } from "@/components/charts/EChart";
import { readChartTheme, type ChartTheme } from "@/lib/chart-theme";
import { formatQuota } from "@/lib/format";
import type { TrendPoint } from "@/server/queries/trend";

/** 纯函数便于单测：日历热力 option（日期标签 + 消耗强度）。 */
export function buildCalendarOption(points: TrendPoint[], theme: ChartTheme): EChartsOption {
  const data = points.map((point) => [point.label, point.totalQuota]);
  const max = Math.max(1, ...points.map((point) => point.totalQuota));
  const first = points[0]?.label;
  const last = points[points.length - 1]?.label;

  return {
    tooltip: {
      formatter: (params: { value?: unknown }) => {
        const value = params.value as [string, number] | undefined;
        if (!Array.isArray(value)) return "";
        return `${value[0]}：${formatQuota(value[1])}`;
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
}

export function CalendarHeatmap({
  points,
  height = 190,
  exportName = "heatmap",
}: CalendarHeatmapProps) {
  const { resolvedTheme } = useTheme();
  // 主题切换后 class 已先写入 DOM，需重读 CSS 变量再重建 option
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolvedTheme 仅用于触发重读，readChartTheme 内部读取 DOM
  const theme = useMemo(() => readChartTheme(), [resolvedTheme]);
  const option = useMemo(() => buildCalendarOption(points, theme), [points, theme]);

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
