"use client";

/** 消耗趋势面积图（FE-M2-02）：当前区间 + 可选对比期（虚线）。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import type { TrendPoint } from "@/server/queries/trend";

export type TrendMetric = "totalQuota" | "requestCount" | "totalTokens";

export const TREND_METRICS: ReadonlyArray<{ key: TrendMetric; label: string }> = [
  { key: "totalQuota", label: "消耗额度" },
  { key: "requestCount", label: "请求数" },
  { key: "totalTokens", label: "Token" },
];

function formatMetricValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/** 纯函数便于单测：points 与 comparePoints 按桶序号对齐（compare 可含 null）。 */
export function buildTrendOption(
  points: TrendPoint[],
  comparePoints: Array<TrendPoint | null> | undefined,
  metric: TrendMetric,
): EChartsOption {
  const labels = points.map((point) => point.label);
  const values = points.map((point) => point[metric]);
  const hasCompare = (comparePoints ?? []).some((point) => point !== null);

  const series: Array<Record<string, unknown>> = [
    {
      name: TREND_METRICS.find((item) => item.key === metric)?.label ?? metric,
      type: "line",
      smooth: true,
      showSymbol: false,
      areaStyle: { opacity: 0.12 },
      emphasis: { focus: "series" },
      data: values,
    },
  ];

  if (hasCompare) {
    series.push({
      name: "对比期",
      type: "line",
      smooth: true,
      showSymbol: false,
      lineStyle: { type: "dashed", width: 1.5 },
      data: (comparePoints ?? []).map((point) => (point === null ? null : point[metric])),
    });
  }

  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: unknown) => formatMetricValue(metric, Number(value)),
    },
    xAxis: { type: "category", boundaryGap: false, data: labels },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatCompactNumber(value) },
    },
    series,
  } as unknown as EChartsOption;
}

export interface TrendLineProps {
  points: TrendPoint[];
  comparePoints?: Array<TrendPoint | null>;
  metric: TrendMetric;
  height?: number | string;
  /** 导出文件名 scope（FE-M3-02）。 */
  exportName?: string;
}

export function TrendLine({
  points,
  comparePoints,
  metric,
  height = 300,
  exportName = "trend",
}: TrendLineProps) {
  const option = useMemo(
    () => buildTrendOption(points, comparePoints, metric),
    [comparePoints, metric, points],
  );

  return (
    <EChart
      option={option}
      height={height}
      empty={points.length === 0}
      emptyMessage="所选区间暂无趋势数据"
      ariaLabel="消耗趋势图"
      exportName={exportName}
    />
  );
}
