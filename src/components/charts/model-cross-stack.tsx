"use client";

/**
 * 用户 × 模型交叉分布：横向堆叠柱。
 *
 * 数据来自 `/api/models/cross`：稀疏 cells + others（others = 用户总消耗 − Top 模型消耗之和）。
 * 渲染时按「用户 × 模型」补 0；模型列顺序固定为响应 models，others 作为最后一段。
 * 用户数 20 左右、模型段 11，横向堆叠 + dataZoom（滚轮/滑块）保证可读性。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { EChart } from "@/components/charts/EChart";
import { formatPercent, formatQuota } from "@/lib/format";
import { primaryUserLabel } from "@/lib/user-label";
import type { ModelCrossResult } from "@/server/queries/model";

const OTHERS_NAME = "其他模型";

/** 纯函数便于单测：交叉矩阵 → 堆叠柱 option。 */
export function buildCrossStackOption(result: ModelCrossResult): EChartsOption {
  const users = result.users;
  const cellIndex = new Map<string, number>();
  for (const cell of result.cells) {
    cellIndex.set(`${cell.userId}|${cell.modelName}`, cell.totalQuota);
  }
  const userTotals = new Map<number, number>();
  for (const user of users) userTotals.set(user.userId, 0);
  for (const cell of result.cells) {
    userTotals.set(cell.userId, (userTotals.get(cell.userId) ?? 0) + cell.totalQuota);
  }
  for (const other of result.others) {
    userTotals.set(other.userId, (userTotals.get(other.userId) ?? 0) + other.totalQuota);
  }

  const categories = users.map((user) => primaryUserLabel(user));

  const series = result.models.map((modelName) => ({
    name: modelName,
    type: "bar" as const,
    stack: "cross",
    barMaxWidth: 20,
    emphasis: { focus: "series" as const },
    data: users.map((user) => cellIndex.get(`${user.userId}|${modelName}`) ?? 0),
  }));

  series.push({
    name: OTHERS_NAME,
    type: "bar" as const,
    stack: "cross",
    barMaxWidth: 20,
    emphasis: { focus: "series" as const },
    data: users.map((user) => {
      const other = result.others.find((item) => item.userId === user.userId)?.totalQuota ?? 0;
      return other;
    }),
  });

  return {
    grid: { left: 8, right: 24, top: 32, bottom: 24, containLabel: true },
    legend: { type: "scroll", top: 0 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const items = Array.isArray(params) ? params : [params];
        const lines: string[] = [];
        let total = 0;

        for (const item of items) {
          const record = item as { seriesName?: string; value?: unknown; dataIndex?: number };
          const value = Number(record.value ?? 0);
          const user = record.dataIndex === undefined ? undefined : users[record.dataIndex];
          const userTotal =
            user === undefined ? 0 : (userTotals.get(user.userId) ?? 0);
          if (value <= 0) continue;
          total += value;
          lines.push(
            `${record.seriesName ?? ""}：${formatQuota(value)}（${formatPercent(
              userTotal > 0 ? value / userTotal : 0,
            )}）`,
          );
        }

        return [`合计 ${formatQuota(total)}`, ...lines].join("<br/>");
      },
    },
    dataZoom: [
      { type: "inside", yAxisIndex: 0 },
      { type: "slider", yAxisIndex: 0, width: 10, right: 2, showDetail: false },
    ],
    xAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatQuota(value) },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: categories,
      axisLabel: { width: 120, overflow: "truncate" },
    },
    series,
  } as unknown as EChartsOption;
}

export interface ModelCrossStackProps {
  result: ModelCrossResult | undefined;
  height?: number;
}

export function ModelCrossStack({ result, height }: ModelCrossStackProps) {
  const option = useMemo(
    () => buildCrossStackOption(result ?? { users: [], models: [], cells: [], others: [] }),
    [result],
  );
  const rowCount = result?.users.length ?? 0;

  return (
    <EChart
      option={option}
      height={height ?? Math.max(260, rowCount * 26 + 96)}
      empty={rowCount === 0 || (result?.models.length ?? 0) === 0}
      emptyMessage="所选区间暂无可交叉分析的数据"
      ariaLabel="用户与模型交叉分布"
      exportName="models-cross"
    />
  );
}
