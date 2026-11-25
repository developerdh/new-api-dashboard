"use client";

/** 消耗趋势面积图：当前区间 + 可选对比期（虚线），对比模式下 tooltip 逐桶附较对照期百分比。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import { formatPeriodDelta, periodDelta } from "@/lib/period-delta";
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
  /** 对比文案口径：环比「较上期」/ 同比「较去年同期」；仅 compare 开启时有意义。 */
  compareMode: "prev" | "yoy" = "prev",
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
      // 自定义 formatter：对照模式开启时逐桶附加「较上期 / 较去年同期 ±%」
      // （主值 vs 对照同序号桶；对照为 null 或对照值为 0 不显示该行）
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number } | undefined;
        const dataIndex = first?.dataIndex ?? -1;
        if (dataIndex < 0 || dataIndex >= points.length) return "";

        const lines: string[] = [];
        for (const item of items) {
          const record = item as { seriesName?: string; value?: unknown };
          if (record.value === null || record.value === undefined) continue;
          lines.push(
            `${record.seriesName ?? ""}：${formatMetricValue(metric, Number(record.value))}`,
          );
        }
        if (hasCompare) {
          const comparePoint = comparePoints?.[dataIndex] ?? null;
          const delta =
            comparePoint === null
              ? null
              : periodDelta(points[dataIndex][metric], comparePoint[metric]);
          if (delta !== null) {
            lines.push(`${compareMode === "yoy" ? "较去年同期" : "较上期"} ${formatPeriodDelta(delta)}`);
          }
        }
        return lines.join("<br/>");
      },
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
  /** 对比模式文案口径（tooltip 标注用），缺省按环比。 */
  compareMode?: "prev" | "yoy";
  height?: number | string;
  /** 导出文件名 scope。 */
  exportName?: string;
}

export function TrendLine({
  points,
  comparePoints,
  metric,
  compareMode = "prev",
  height = 300,
  exportName = "trend",
}: TrendLineProps) {
  const option = useMemo(
    () => buildTrendOption(points, comparePoints, metric, compareMode),
    [compareMode, comparePoints, metric, points],
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
