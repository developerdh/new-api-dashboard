"use client";

/** 用户消耗排行（FE-M2-02）：Top N 横向柱状图，点击柱子跳转用户详情。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import type { UserRankingRow } from "@/server/queries/user";

/** 纯函数便于单测：横向柱状（消耗降序，用户名过长截断展示）。 */
export function buildRankingOption(rows: UserRankingRow[]): EChartsOption {
  return {
    grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value: unknown) => formatQuota(Number(value)),
    },
    xAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatCompactNumber(value) },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => row.username || `用户 ${row.userId}`),
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
          formatter: (params: { value?: unknown }) => formatQuota(Number(params.value ?? 0)),
        },
        data: rows.map((row) => row.totalQuota),
      },
    ],
  } as unknown as EChartsOption;
}

export interface UserRankingBarProps {
  rows: UserRankingRow[];
  onSelect?: (row: UserRankingRow) => void;
  height?: number | string;
}

export function UserRankingBar({ rows, onSelect, height }: UserRankingBarProps) {
  const option = useMemo(() => buildRankingOption(rows), [rows]);
  const onEvents = useMemo(
    () => ({
      click: (params: unknown): void => {
        const dataIndex = (params as { dataIndex?: number }).dataIndex;
        if (dataIndex === undefined || onSelect === undefined) return;
        const row = rows[dataIndex];
        if (row !== undefined) onSelect(row);
      },
    }),
    [onSelect, rows],
  );

  return (
    <EChart
      option={option}
      height={height ?? Math.max(220, rows.length * 30 + 40)}
      empty={rows.length === 0}
      emptyMessage="所选区间暂无排行数据"
      ariaLabel="用户消耗排行"
      onEvents={onEvents}
    />
  );
}
