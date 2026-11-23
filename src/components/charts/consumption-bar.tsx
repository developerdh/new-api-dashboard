"use client";

/**
 * 消耗分布柱状图：区间内按小时/天/周分桶的合计柱（不按模型分段）。
 *
 * - 分桶单位由 `distributionGranularity(range)` 派生后经 `unit` 传入，本组件不读 URL；
 * - 覆盖当前时间的 hour 区间：未来整点桶渲染 null（与 0 区分），悬停提示「未到」；
 * - 单自然日区间的 x 轴标签压缩为 `HH:00`，tooltip 仍显示服务端完整标签（`MM-DD HH:00`）；
 * - 统计维度（消耗额度/请求数/Token）由卡片层持有，切换时柱高与坐标轴同步换算。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { TREND_METRICS, type TrendMetric } from "@/components/charts/trend-line";
import { formatCompactNumber, formatNumber, formatQuota } from "@/lib/format";
import { nowEpochSeconds, type DistributionBucket } from "@/lib/time-range";
import type { TrendPoint } from "@/server/queries/trend";

const HOUR_SECONDS = 3_600;

function formatMetricValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/** 区间总计格式化：额度 → $，请求数 → 千分位整数，Token → 紧凑数（与指标卡口径一致）。 */
export function formatDistributionTotal(metric: TrendMetric, value: number): string {
  if (metric === "totalQuota") return formatQuota(value);
  if (metric === "requestCount") return formatNumber(value);
  return formatCompactNumber(value);
}

/** 单自然日判断：所有 hour 标签共享同一 `MM-DD` 前缀（标签形如 `11-10 08:00`）。 */
function isSingleNaturalDay(points: TrendPoint[], unit: DistributionBucket): boolean {
  if (unit !== "hour" || points.length === 0) return false;
  const firstDate = points[0].label.slice(0, 5);
  return points.every((point) => point.label.slice(0, 5) === firstDate);
}

/** 纯函数便于单测：合计柱 option（未来小时 null + 维度格式化 + 单日标签压缩）。 */
export function buildDistributionOption(
  points: TrendPoint[],
  unit: DistributionBucket,
  metric: TrendMetric,
  nowSeconds: number = nowEpochSeconds(),
): EChartsOption {
  // hour 桶且区间未结束时，未来整点桶为 null（与「已发生但为 0」区分）；
  // day/week 的末桶即使覆盖当前时间也是有效的部分数据，正常展示。
  const data = points.map((point) =>
    unit === "hour" && point.bucketStart + HOUR_SECONDS > nowSeconds ? null : point[metric],
  );
  const compressed = isSingleNaturalDay(points, unit);
  const labels = points.map((point) => (compressed ? point.label.slice(6) : point.label));
  const seriesName = TREND_METRICS.find((item) => item.key === metric)?.label ?? metric;

  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number; value?: unknown } | undefined;
        const point = points[first?.dataIndex ?? -1];
        if (point === undefined) return "";
        return first?.value === null || first?.value === undefined
          ? `${point.label}：未到`
          : `${point.label}：${formatMetricValue(metric, Number(first.value))}`;
      },
    },
    xAxis: { type: "category", data: labels },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatCompactNumber(value) },
    },
    series: [
      {
        name: seriesName,
        type: "bar",
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        emphasis: { focus: "series" },
        data,
      },
    ],
  } as unknown as EChartsOption;
}

export interface ConsumptionBarProps {
  points: TrendPoint[];
  /** 分桶单位（`distributionGranularity(range)` 派生）。 */
  unit: DistributionBucket;
  metric: TrendMetric;
  height?: number | string;
  /** 导出文件名 scope。 */
  exportName?: string;
  /** 当前时刻（Unix 秒）；hour 区间用它区分未来小时，默认取组件渲染时刻。 */
  nowSeconds?: number;
}

export function ConsumptionBar({
  points,
  unit,
  metric,
  height = 300,
  exportName = "distribution",
  nowSeconds,
}: ConsumptionBarProps) {
  const now = useMemo(() => nowSeconds ?? nowEpochSeconds(), [nowSeconds]);
  const option = useMemo(
    () => buildDistributionOption(points, unit, metric, now),
    [metric, now, points, unit],
  );

  return (
    <EChart
      option={option}
      height={height}
      empty={points.length === 0}
      emptyMessage="所选区间暂无消耗分布数据"
      ariaLabel="消耗分布图"
      exportName={exportName}
    />
  );
}
