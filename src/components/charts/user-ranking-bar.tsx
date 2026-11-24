"use client";

/**
 * 用户排行：Top N 横向柱状图。
 * `metric` 切换统计维度时，坐标轴 / 柱标签 / tooltip 使用同一单位，并按该维度重新降序排列。
 *
 * 姓名（y 轴标签）与柱体均可点击跳转用户详情：`triggerEvent` 让标签参与事件，
 * 标签以图表主色（palette[0]）展示以传达可点（ECharts 不支持下线样式，悬停为 pointer）。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useTheme } from "@/app/providers";
import { EChart } from "@/components/charts/EChart";
import type { TrendMetric } from "@/components/charts/trend-line";
import { escapeHtml } from "@/lib/export-html";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import { readChartTheme } from "@/lib/chart-theme";
import { fullUserLabel, primaryUserLabel } from "@/lib/user-label";
import type { UserRankingRow } from "@/server/queries/user";

function formatValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/**
 * 解析排行图点击事件 → 对应行：
 * - 柱体（series）：按 dataIndex；
 * - y 轴姓名标签（axisLabel）：ECharts 只回传类目文本，按标签回查（重名取首个，柱体点击不受影响）。
 */
export function resolveRankingClickRow(
  params: unknown,
  rows: UserRankingRow[],
): UserRankingRow | undefined {
  const p = params as { targetType?: string; dataIndex?: number; value?: unknown };
  if (p.targetType === "axisLabel") {
    const label = String(p.value ?? "");
    return rows.find((row) => primaryUserLabel(row) === label);
  }
  return rows[p.dataIndex ?? -1];
}

/** 纯函数便于单测：横向柱状（姓名标签可点，用户名过长截断展示）。 */
export function buildRankingOption(
  rows: UserRankingRow[],
  metric: TrendMetric = "totalQuota",
  linkColor?: string,
): EChartsOption {
  return {
    grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      // 坐标轴只放得下昵称，hover 时补上账号便于对账
      // tooltip 以 HTML 渲染，昵称/账号为用户可控字符串，必须转义防注入
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number; value?: unknown } | undefined;
        const row = rows[first?.dataIndex ?? -1];
        const label = row === undefined ? "" : escapeHtml(fullUserLabel(row));
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
      // 姓名标签参与事件：可点击跳转详情
      triggerEvent: true,
      data: rows.map((row) => primaryUserLabel(row)),
      axisLabel: {
        width: 120,
        overflow: "truncate",
        // 链接色传达可点；applyChartTheme 对显式设置的 axisLabel 让位，主题切换由组件重算
        ...(linkColor === undefined ? {} : { color: linkColor }),
      },
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
  const { resolvedTheme } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolvedTheme 仅用于触发重读，readChartTheme 内部读取 DOM
  const theme = useMemo(() => readChartTheme(), [resolvedTheme]);
  const sortedRows = useMemo(
    () => [...rows].sort((left, right) => right[metric] - left[metric]),
    [rows, metric],
  );
  const option = useMemo(
    () => buildRankingOption(sortedRows, metric, theme.palette[0]),
    [metric, sortedRows, theme.palette],
  );
  const onEvents = useMemo(
    () => ({
      click: (params: unknown): void => {
        if (onSelect === undefined) return;
        const row = resolveRankingClickRow(params, sortedRows);
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
