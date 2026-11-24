"use client";

/**
 * 消耗分布柱状图：区间内按小时/天/周分桶，按模型堆叠展示（Top 模型 + 其他）。
 *
 * - 分桶单位由 `distributionGranularity(range)` 派生后经 `unit` 传入，本组件不读 URL；
 * - 每模型一条堆叠柱序列 + 图例，「其他」= 该桶合计 − Σ模型分段（来自主趋势序列，
 *   按 bucketStart 对齐）；模型序列未到达时回落为合计单序列；
 * - 覆盖当前时间的 hour 区间：未来整点桶整桶渲染 null（与 0 区分），悬停提示「未到」；
 * - 单自然日区间的 x 轴标签压缩为 `HH:00`，tooltip 仍显示服务端完整标签（`MM-DD HH:00`）；
 * - 数值单位与所选维度一致：额度统一美元（formatQuota），请求数/Token 紧凑数字；
 *   纵轴、悬停、总计同一口径（模型名进 HTML tooltip 需转义）。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { TREND_METRICS, type TrendMetric } from "@/components/charts/trend-line";
import { escapeHtml } from "@/lib/export-html";
import { formatCompactNumber, formatNumber, formatQuota } from "@/lib/format";
import { nowEpochSeconds, type DistributionBucket } from "@/lib/time-range";
import type { ModelTrendSeries } from "@/server/queries/model";
import type { TrendPoint } from "@/server/queries/trend";

const HOUR_SECONDS = 3_600;
const OTHERS_NAME = "其他";

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

/** x 轴标签（单自然日的 hour 区间压缩为 HH:00）。 */
function distributionLabels(points: TrendPoint[], unit: DistributionBucket): string[] {
  const compressed = isSingleNaturalDay(points, unit);
  return points.map((point) => (compressed ? point.label.slice(6) : point.label));
}

/** 纵轴刻度：与所选维度同单位（额度 → $）。 */
function axisLabelFormatter(metric: TrendMetric): (value: number) => string {
  return (value: number) => formatMetricValue(metric, value);
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
    xAxis: { type: "category", data: distributionLabels(points, unit) },
    yAxis: { type: "value", axisLabel: { formatter: axisLabelFormatter(metric) } },
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

/** 纯函数便于单测：按模型堆叠 option（其他 = 合计 − Σ模型，模型名转义）。 */
export function buildModelDistributionOption(
  points: TrendPoint[],
  modelSeries: ModelTrendSeries[],
  unit: DistributionBucket,
  metric: TrendMetric,
  nowSeconds: number = nowEpochSeconds(),
): EChartsOption {
  const isFuture = (point: TrendPoint): boolean =>
    unit === "hour" && point.bucketStart + HOUR_SECONDS > nowSeconds;

  // 模型序列点按桶起点索引（序列与主趋势同一 trendBuckets 枚举，缺失补 0）
  const byModelBucket = modelSeries.map((series) => {
    const index = new Map<number, (typeof series.points)[number]>();
    for (const point of series.points) index.set(point.bucketStart, point);
    return { name: series.modelName, index };
  });

  const seriesData = byModelBucket.map(({ name, index }) => ({
    name,
    type: "bar" as const,
    stack: "distribution",
    barMaxWidth: 28,
    emphasis: { focus: "series" as const },
    data: points.map(
      (point) =>
        (isFuture(point) ? null : ((index.get(point.bucketStart)?.[metric] as number) ?? 0)),
    ),
  }));

  // 其他 = 该桶合计 − Σ模型分段（不小于 0）；只在确有差额时追加「其他」段，避免图例噪声
  const othersData = points.map((point) => {
    if (isFuture(point)) return null;
    const modelsSum = byModelBucket.reduce(
      (total, { index }) => total + ((index.get(point.bucketStart)?.[metric] as number) ?? 0),
      0,
    );
    return Math.max(0, point[metric] - modelsSum);
  });
  const hasOthers = othersData.some((value) => typeof value === "number" && value > 0);
  if (hasOthers) {
    seriesData.push({
      name: OTHERS_NAME,
      type: "bar",
      stack: "distribution",
      barMaxWidth: 28,
      emphasis: { focus: "series" },
      data: othersData,
    });
  }

  return {
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    legend: { type: "scroll", top: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number } | undefined;
        const point = points[first?.dataIndex ?? -1];
        if (point === undefined) return "";
        if (isFuture(point)) return `${point.label}：未到`;

        const lines = [`${point.label} · 合计 ${formatMetricValue(metric, point[metric])}`];
        for (const item of items) {
          const record = item as { seriesName?: string; value?: unknown };
          const value = Number(record.value ?? 0);
          if (record.seriesName === undefined || record.value === null || value <= 0) continue;
          // 模型名为库内 model_name（请求方可控），tooltip 按 HTML 渲染必须转义
          lines.push(`${escapeHtml(record.seriesName)}：${formatMetricValue(metric, value)}`);
        }
        return lines.join("<br/>");
      },
    },
    xAxis: { type: "category", data: distributionLabels(points, unit) },
    yAxis: { type: "value", axisLabel: { formatter: axisLabelFormatter(metric) } },
    series: seriesData,
  } as unknown as EChartsOption;
}

export interface ConsumptionBarProps {
  points: TrendPoint[];
  /** 分桶单位（`distributionGranularity(range)` 派生）。 */
  unit: DistributionBucket;
  metric: TrendMetric;
  /** 按模型堆叠的模型序列（`/api/models/trend`）；未提供时回落为合计单序列。 */
  modelSeries?: ModelTrendSeries[];
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
  modelSeries,
  height = 300,
  exportName = "distribution",
  nowSeconds,
}: ConsumptionBarProps) {
  const now = useMemo(() => nowSeconds ?? nowEpochSeconds(), [nowSeconds]);
  const option = useMemo(
    () =>
      modelSeries !== undefined
        ? buildModelDistributionOption(points, modelSeries, unit, metric, now)
        : buildDistributionOption(points, unit, metric, now),
    [metric, modelSeries, now, points, unit],
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
