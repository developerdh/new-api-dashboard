"use client";

/** 总览指标卡组（FE-M2-02）：5 张卡 + 迷你趋势 + 环比徽标。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { MetricCard } from "@/components/cards/MetricCard";
import { EChart } from "@/components/charts/EChart";
import {
  formatCompactNumber,
  formatDelta,
  formatNumber,
  formatQuota,
} from "@/lib/format";
import type { OverviewSnapshot } from "@/server/queries/overview";
import type { TrendPoint } from "@/server/queries/trend";

export type DeltaMetric = "totalQuota" | "requestCount" | "totalTokens";

export interface OverviewCardsProps {
  data?: OverviewSnapshot;
  trendPoints?: TrendPoint[];
  /** 环比百分比（正负均为百分数，如 12.3 / -4.5）；缺失则不展示。 */
  deltas?: Partial<Record<DeltaMetric, number>>;
  /** 对比文案前缀（环比「较上期」/ 同比「较去年同期」）。 */
  compareLabel?: string;
  loading: boolean;
}

function Sparkline({ values }: { values: number[] }) {
  const option = useMemo<EChartsOption>(
    () =>
      ({
        grid: { left: 0, right: 0, top: 2, bottom: 2 },
        xAxis: { type: "category", show: false, boundaryGap: false, data: values.map((_, i) => i) },
        yAxis: { type: "value", show: false },
        tooltip: { show: false },
        series: [
          {
            type: "line",
            smooth: true,
            showSymbol: false,
            lineWidth: 1.5,
            areaStyle: { opacity: 0.15 },
            data: values,
          },
        ],
      }) as EChartsOption,
    [values],
  );

  if (values.length < 2) return null;
  return <EChart option={option} height={40} ariaLabel="迷你趋势" />;
}

function deltaOf(
  deltas: OverviewCardsProps["deltas"],
  key: DeltaMetric,
  label: string,
): string | undefined {
  const value = deltas?.[key];
  return value === undefined ? undefined : `${label} ${formatDelta(value)}`;
}

export function OverviewCards({
  data,
  trendPoints,
  deltas,
  compareLabel = "较上期",
  loading,
}: OverviewCardsProps) {
  const points = trendPoints ?? [];
  const seriesOf = (key: DeltaMetric): number[] => points.map((point) => point[key]);
  const placeholder = loading || data === undefined;

  return (
    <>
      <MetricCard
        title="总消耗额度"
        value={placeholder ? "—" : formatQuota(data.totalQuota)}
        hint={placeholder ? "加载中…" : "按 500000 quota = $1 换算"}
        delta={deltaOf(deltas, "totalQuota", compareLabel)}
      >
        <Sparkline values={seriesOf("totalQuota")} />
      </MetricCard>

      <MetricCard
        title="总请求数"
        value={placeholder ? "—" : formatNumber(data.requestCount)}
        hint={placeholder ? "加载中…" : "来自 logs 精确计数"}
        delta={deltaOf(deltas, "requestCount", compareLabel)}
      >
        <Sparkline values={seriesOf("requestCount")} />
      </MetricCard>

      <MetricCard
        title="总 Token"
        value={placeholder ? "—" : formatCompactNumber(data.totalTokens)}
        hint={
          placeholder
            ? "加载中…"
            : `输入 ${formatCompactNumber(data.promptTokens)} · 输出 ${formatCompactNumber(data.completionTokens)}`
        }
        delta={deltaOf(deltas, "totalTokens", compareLabel)}
      >
        <Sparkline values={seriesOf("totalTokens")} />
      </MetricCard>

      <MetricCard
        title="活跃用户"
        value={placeholder ? "—" : formatNumber(data.activeUsers)}
        hint={placeholder ? "加载中…" : "区间内去重用户数"}
      />

      <MetricCard
        title="模型数"
        value={placeholder ? "—" : formatNumber(data.modelCount)}
        hint={placeholder ? "加载中…" : "区间内去重模型数"}
      />
    </>
  );
}
