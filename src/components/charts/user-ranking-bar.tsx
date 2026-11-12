"use client";

/**
 * 用户排行：Top N 横向柱状图，点击柱子跳转用户详情。
 * `metric` 切换统计维度时，坐标轴 / 柱标签 / tooltip 使用同一单位，并按该维度重新降序排列。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import type { TrendMetric } from "@/components/charts/trend-line";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import { fullUserLabel, primaryUserLabel } from "@/lib/user-label";
import type { UserRankingRow } from "@/server/queries/user";

function formatValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/** 纯函数便于单测：横向柱状（用户名过长截断展示）。 */
export function buildRankingOption(
  rows: UserRankingRow[],
  metric: TrendMetric = "totalQuota",
): EChartsOption {
  return {
    grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      // 坐标轴只放得下昵称，hover 时补上账号便于对账
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number; value?: unknown } | undefined;
        const row = rows[first?.dataIndex ?? -1];
        const label = row === undefined ? "" : fullUserLabel(row);
        return `${label}<br/>${formatValue(metric, Number(first?.value ?? 0))}`;
      },
    },
    xAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatValue(metric, value) },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => primaryUserLabel(row)),
      axisLabel: { width: 120, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 16,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: "right",
          formatter: (params: { value?: unknown }) =>
            formatValue(metric, Number(params.value ?? 0)),
        },
        data: rows.map((row) => row[metric]),
      },
    ],
  } as unknown as EChartsOption;
}

export interface UserRankingBarProps {
  rows: UserRankingRow[];
  onSelect?: (row: UserRankingRow) => void;
  height?: number | string;
  metric?: TrendMetric;
}

export function UserRankingBar({
  rows,
  onSelect,
  height,
  metric = "totalQuota",
}: UserRankingBarProps) {
  const sortedRows = useMemo(
    () => [...rows].sort((left, right) => right[metric] - left[metric]),
    [rows, metric],
  );
  const option = useMemo(
    () => buildRankingOption(sortedRows, metric),
    [sortedRows, metric],
  );
  const onEvents = useMemo(
    () => ({
      click: (params: unknown): void => {
        const dataIndex = (params as { dataIndex?: number }).dataIndex;
        if (dataIndex === undefined || onSelect === undefined) return;
        const row = sortedRows[dataIndex];
        if (row !== undefined) onSelect(row);
      },
    }),
    [onSelect, sortedRows],
  );

  return (
    <EChart
      option={option}
      height={height ?? Math.max(220, rows.length * 30 + 40)}
      empty={rows.length === 0}
      emptyMessage="所选区间暂无排行数据"
      ariaLabel="用户消耗排行"
      onEvents={onEvents}
      exportName="users-ranking"
    />
  );
}
