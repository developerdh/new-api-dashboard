"use client";

/**
 * 周期对比柱状图：固定窗口（近 6 个自然月 / 近 12 个自然周，含残期）逐期对比。
 *
 * - 数据来自 `/api/trend`（合计）与 `/api/models/trend`（模型序列）的月/周粒度查询，
 *   由页面用固定窗口区间预取后传入，本组件不读 URL、不随全局区间变化；
 * - 按模型堆叠（窗口内 Top 模型 + 「其他」= 合计 − Σ模型分段，模式同消耗分布卡），
 *   模型序列未到达时回落为合计单序列；
 * - 柱顶 ▲/▼ 环比标注：整桶合计相对上期（中性色，`labelLayout.hideOverlap` 防拥挤），
 *   首期与上期 ≤ 0 不标注（差分逻辑见 `src/lib/period-delta`）；模型分段不标注环比；
 * - 末桶为进行中的残期时 tooltip 标注「截至 MM-DD」（基准 `nowSeconds` 由页面注入）；
 * - 空期（数据起点之前）按 0 连续展示且无模型分段；
 * - 数值单位与所选维度一致（额度 → 美元）；周窗口 x 轴标签压缩为 `MM-DD`（tooltip 仍为完整日期）。
 */
import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { useTheme } from "@/app/providers";
import { EChart } from "@/components/charts/EChart";
import { TREND_METRICS, type TrendMetric } from "@/components/charts/trend-line";
import { readChartTheme, type ChartTheme } from "@/lib/chart-theme";
import { escapeHtml } from "@/lib/export-html";
import { formatCompactNumber, formatQuota } from "@/lib/format";
import { formatPeriodDelta, periodDeltas } from "@/lib/period-delta";
import { nowEpochSeconds, shanghaiDateOf, type PeriodWindowUnit } from "@/lib/time-range";
import type { ModelTrendSeries } from "@/server/queries/model";
import type { TrendPoint } from "@/server/queries/trend";

const OTHERS_NAME = "其他";
/** 柱顶环比标注的承载序列名（透明零值段：不出图例、不进 tooltip 行）。 */
const DELTA_SERIES_NAME = "_delta";

function formatMetricValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

/** x 轴标签：月保持 `YYYY-MM`；周压缩为 `MM-DD`。 */
function axisLabels(points: TrendPoint[], unit: PeriodWindowUnit): string[] {
  return points.map((point) => (unit === "week" ? point.label.slice(5) : point.label));
}

/** 柱顶环比标注属性（透明零值段 / 合计序列共用）。 */
function deltaLabelProps(formatter: (dataIndex: number) => string, labelColor?: string) {
  return {
    show: true,
    position: "top",
    fontSize: 10,
    ...(labelColor !== undefined ? { color: labelColor } : {}),
    formatter: (params: { dataIndex?: number }) => formatter(params.dataIndex ?? -1),
  };
}

/** 纯函数便于单测：周期对比 option（模型堆叠 / 环比标注 / 残期 tooltip / 维度格式化）。 */
export function buildPeriodOption(
  points: TrendPoint[],
  modelSeries: ModelTrendSeries[] | undefined,
  unit: PeriodWindowUnit,
  metric: TrendMetric,
  nowSeconds: number = nowEpochSeconds(),
  theme?: ChartTheme,
): EChartsOption {
  const labelColor = theme?.mutedForeground;
  const deltas = periodDeltas(points.map((point) => point[metric]));
  const deltaFormatter = (dataIndex: number): string => formatPeriodDelta(deltas[dataIndex] ?? null);

  // 末桶覆盖当前时刻即为残期（end=now 的窗口恒成立；保留判断以便窗口来源变化时仍正确）
  const residualIndex =
    points.length > 0 && points[points.length - 1].bucketStart <= nowSeconds
      ? points.length - 1
      : -1;
  const residualAsOf = residualIndex >= 0 ? shanghaiDateOf(nowSeconds).slice(5) : "";

  const tooltipFormatter = (params: unknown): string => {
    const items = Array.isArray(params) ? params : [params];
    const first = items[0] as { dataIndex?: number } | undefined;
    const dataIndex = first?.dataIndex ?? -1;
    const point = points[dataIndex];
    if (point === undefined) return "";

    const residualSuffix = dataIndex === residualIndex ? `（截至 ${residualAsOf}）` : "";
    const lines = [
      `${point.label}${residualSuffix} · 合计 ${formatMetricValue(metric, point[metric])}`,
    ];
    for (const item of items) {
      const record = item as { seriesName?: string; value?: unknown };
      const value = Number(record.value ?? 0);
      if (record.seriesName === undefined || record.value === null || value <= 0) continue;
      if (record.seriesName === DELTA_SERIES_NAME) continue;
      // 模型名为库内 model_name（请求方可控），tooltip 按 HTML 渲染必须转义
      lines.push(`${escapeHtml(record.seriesName)}：${formatMetricValue(metric, value)}`);
    }
    const deltaLine = deltaFormatter(dataIndex);
    if (deltaLine !== "") lines.push(`较上期 ${deltaLine}`);
    return lines.join("<br/>");
  };

  // 模型序列点按桶起点索引（序列与合计同一窗口枚举，缺失补 0）
  const byModelBucket = (modelSeries ?? []).map((series) => {
    const index = new Map<number, ModelTrendSeries["points"][number]>();
    for (const point of series.points) index.set(point.bucketStart, point);
    return { name: series.modelName, index };
  });

  const stacked = byModelBucket.length > 0;
  const seriesData: Array<Record<string, unknown>> = byModelBucket.map(({ name, index }) => ({
    name,
    type: "bar",
    stack: "period",
    barMaxWidth: 28,
    emphasis: { focus: "series" as const },
    data: points.map((point) => index.get(point.bucketStart)?.[metric] ?? 0),
  }));

  // 其他 = 该期合计 − Σ模型分段（不小于 0）；只在确有差额时追加「其他」段，避免图例噪声
  let legendNames: string[] = [];
  if (stacked) {
    const othersData = points.map((point) => {
      const modelsSum = byModelBucket.reduce(
        (total, { index }) => total + (index.get(point.bucketStart)?.[metric] ?? 0),
        0,
      );
      return Math.max(0, point[metric] - modelsSum);
    });
    if (othersData.some((value) => value > 0)) {
      seriesData.push({
        name: OTHERS_NAME,
        type: "bar",
        stack: "period",
        barMaxWidth: 28,
        emphasis: { focus: "series" },
        data: othersData,
      });
    }
    legendNames = [...byModelBucket.map(({ name }) => name)];
    if (othersData.some((value) => value > 0)) legendNames.push(OTHERS_NAME);
    // 透明零值段压在堆叠顶：仅承载柱顶环比标注，不参与图例与 tooltip 行
    seriesData.push({
      name: DELTA_SERIES_NAME,
      type: "bar",
      stack: "period",
      barMaxWidth: 28,
      silent: true,
      legendHoverLink: false,
      itemStyle: { color: "transparent" },
      tooltip: { show: false },
      data: points.map(() => 0),
      label: deltaLabelProps(deltaFormatter, labelColor),
      labelLayout: { hideOverlap: true },
    });
  } else {
    const seriesName = TREND_METRICS.find((item) => item.key === metric)?.label ?? metric;
    seriesData.push({
      name: seriesName,
      type: "bar",
      barMaxWidth: 28,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      emphasis: { focus: "series" },
      data: points.map((point) => point[metric]),
      label: deltaLabelProps(deltaFormatter, labelColor),
      labelLayout: { hideOverlap: true },
    });
  }

  return {
    grid: { left: 8, right: 8, top: stacked ? 48 : 40, bottom: 8, containLabel: true },
    ...(stacked
      ? {
          legend: {
            type: "scroll",
            top: 0,
            itemWidth: 10,
            itemHeight: 10,
            textStyle: { fontSize: 12 },
            // 显式列名：排除 DELTA_SERIES_NAME
            data: legendNames,
          },
        }
      : {}),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: tooltipFormatter,
    },
    xAxis: { type: "category", data: axisLabels(points, unit) },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatMetricValue(metric, value) },
    },
    series: seriesData,
  } as unknown as EChartsOption;
}

export interface PeriodComparisonChartProps {
  points: TrendPoint[];
  /** 按模型堆叠的模型序列（`/api/models/trend`，固定窗口区间）；未提供时回落为合计单序列。 */
  modelSeries?: ModelTrendSeries[];
  /** 窗口单位（月 / 周），仅影响 x 轴标签压缩方式。 */
  unit: PeriodWindowUnit;
  metric: TrendMetric;
  /** 残期「截至」基准（Unix 秒）；缺省取组件渲染时刻。 */
  nowSeconds?: number;
  height?: number | string;
  /** 导出文件名 scope。 */
  exportName?: string;
}

export function PeriodComparisonChart({
  points,
  modelSeries,
  unit,
  metric,
  nowSeconds,
  height = 300,
  exportName = "period-comparison",
}: PeriodComparisonChartProps) {
  const { resolvedTheme } = useTheme();
  const now = useMemo(() => nowSeconds ?? nowEpochSeconds(), [nowSeconds]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolvedTheme 仅用于触发重读，readChartTheme 内部读取 DOM
  const theme = useMemo(() => readChartTheme(), [resolvedTheme]);
  const option = useMemo(
    () => buildPeriodOption(points, modelSeries, unit, metric, now, theme),
    [metric, modelSeries, now, points, theme, unit],
  );

  return (
    <EChart
      option={option}
      height={height}
      empty={points.length === 0}
      emptyMessage="窗口内暂无周期数据"
      ariaLabel="周期对比图"
      exportName={exportName}
    />
  );
}
