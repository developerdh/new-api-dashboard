"use client";

/** 单用户模型消耗分布：环形图 Top10 + 其余合并「其他」。 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { formatQuota } from "@/lib/format";
import type { UserModelRow } from "@/server/queries/user";

const TOP_MODELS = 10;

export interface ModelSlice {
  name: string;
  value: number;
}

/** Top N + 「其他」合并（纯函数便于单测）。 */
export function buildModelSlices(rows: UserModelRow[], top: number = TOP_MODELS): ModelSlice[] {
  const sorted = [...rows].sort((a, b) => b.totalQuota - a.totalQuota);
  const head = sorted.slice(0, top).map((row) => ({
    name: row.modelName || "未知模型",
    value: row.totalQuota,
  }));
  const rest = sorted.slice(top);
  const others = rest.reduce((sum, row) => sum + row.totalQuota, 0);
  return others > 0 ? [...head, { name: "其他", value: others }] : head;
}

export function buildModelPieOption(slices: ModelSlice[]): EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      valueFormatter: (value: unknown) => formatQuota(Number(value)),
    },
    legend: {
      type: "scroll",
      orient: "vertical",
      right: 0,
      top: "middle",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["45%", "70%"],
        center: ["38%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderWidth: 1 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 12, fontWeight: "bold" } },
        data: slices,
      },
    ],
  } as unknown as EChartsOption;
}

export interface ModelPieProps {
  rows: UserModelRow[];
  height?: number | string;
  exportName?: string;
}

export function ModelPie({ rows, height = 260, exportName = "user-models" }: ModelPieProps) {
  const slices = useMemo(() => buildModelSlices(rows), [rows]);
  const option = useMemo(() => buildModelPieOption(slices), [slices]);

  return (
    <EChart
      option={option}
      height={height}
      empty={slices.length === 0}
      emptyMessage="所选区间暂无模型消耗"
      ariaLabel="模型消耗分布"
      exportName={exportName}
    />
  );
}
