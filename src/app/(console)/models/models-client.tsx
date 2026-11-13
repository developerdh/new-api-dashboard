"use client";

/**
 * 模型分析页客户端：排行（图+表 / 多模型趋势）/ 用户×模型交叉。
 *
 * - 时间范围与粒度继承 URL（start/end/granularity）；
 * - 模型候选来自 ranking（limit=100）；趋势默认 Top5、最多选 10 个（前端硬限制，API 同样限制）；
 * - 交叉固定 Top20 用户 × Top10 模型 + others（cross 端点，本页只消费）。
 */
import type { EChartsOption } from "echarts";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { ChartExportButton } from "@/components/charts/chart-export-button";
import { GranularitySwitch } from "@/components/charts/granularity-switch";
import { EChart } from "@/components/charts/EChart";
import { MetricSwitch } from "@/components/charts/metric-switch";
import { ModelCrossStack } from "@/components/charts/model-cross-stack";
import { TREND_METRICS, type TrendMetric } from "@/components/charts/trend-line";
import { TimeRangePicker } from "@/components/layout/time-range-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCompactNumber, formatNumber, formatQuota } from "@/lib/format";
import {
  TREND_MODEL_MAX,
  defaultModelSelection,
  toggleModelSelection,
} from "@/lib/model-selection";
import { parseGranularity, resolveRangeFromParams } from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type {
  ModelCrossResult,
  ModelRankingRow,
  ModelTrendResult,
} from "@/server/queries/model";

const RANKING_FETCH_LIMIT = 100;
const CROSS_USER_LIMIT = 20;
const MODEL_RANKING_CHART_LIMIT = 10;

type RankingSortKey = "totalQuota" | "avgCost";

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-sm">
      <p className="text-muted-foreground">{message}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function SectionBody({
  loading,
  error,
  onRetry,
  skeletonHeight,
  children,
}: {
  loading: boolean;
  error?: { message: string };
  onRetry: () => void;
  skeletonHeight: number;
  children: ReactNode;
}) {
  if (error !== undefined) return <ErrorBox message={error.message} onRetry={onRetry} />;
  if (loading) {
    return (
      <div
        className="w-full rounded-lg skeleton-shimmer"
        style={{ height: skeletonHeight }}
        aria-busy="true"
      />
    );
  }
  return <>{children}</>;
}

/** 模型排行横向柱状：坐标轴 / 柱标签 / tooltip 统一按所选维度格式化，并按该维度降序。 */
function formatRankingValue(metric: TrendMetric, value: number): string {
  return metric === "totalQuota" ? formatQuota(value) : formatCompactNumber(value);
}

export function buildModelRankingOption(
  rows: ModelRankingRow[],
  metric: TrendMetric = "totalQuota",
): EChartsOption {
  return {
    grid: { left: 8, right: 80, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown): string => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0] as { dataIndex?: number; value?: unknown } | undefined;
        const row = rows[first?.dataIndex ?? -1];
        const name = row === undefined ? "" : row.modelName;
        return `${name}<br/>${formatRankingValue(metric, Number(first?.value ?? 0))}`;
      },
    },
    xAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatRankingValue(metric, value) },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => row.modelName),
      axisLabel: { width: 140, overflow: "truncate" },
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
            formatRankingValue(metric, Number(params.value ?? 0)),
        },
        data: rows.map((row) => row[metric]),
      },
    ],
  } as unknown as EChartsOption;
}

/** 多模型趋势：每条模型一条折线（同粒度桶）。 */
function buildModelTrendOption(series: ModelTrendResult["series"]): EChartsOption {
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  return {
    grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
    legend: { type: "scroll", top: 0 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: unknown) => formatQuota(Number(value)),
    },
    xAxis: { type: "category", boundaryGap: false, data: labels },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatQuota(value) },
    },
    series: series.map((item) => ({
      name: item.modelName,
      type: "line" as const,
      smooth: true,
      showSymbol: false,
      data: item.points.map((point) => point.totalQuota),
    })),
  } as unknown as EChartsOption;
}

export function ModelsClient() {
  const searchParams = useSearchParams();
  const range = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const granularity = parseGranularity(searchParams.get("granularity"));

  const [selectedModels, setSelectedModels] = useState<string[] | null>(null);
  const [sortKey, setSortKey] = useState<RankingSortKey>("totalQuota");
  const [rankingMetric, setRankingMetric] = useState<TrendMetric>("totalQuota");

  const baseQuery = new URLSearchParams({
    start: String(range.start),
    end: String(range.end),
  });

  const rankingApi = useApi<{ rows: ModelRankingRow[] }>(
    `/api/models/ranking?${baseQuery.toString()}&limit=${RANKING_FETCH_LIMIT}`,
  );
  const rankingRows = useMemo(() => rankingApi.data?.rows ?? [], [rankingApi.data?.rows]);

  // 默认 Top5 由 ranking 推导；用户手动选择后以 state 为准（避免 effect 同步 state）
  const activeModels = useMemo<string[]>(() => {
    if (selectedModels !== null) return selectedModels;
    return defaultModelSelection(rankingRows.map((row) => row.modelName));
  }, [rankingRows, selectedModels]);

  const trendQuery = new URLSearchParams(baseQuery);
  trendQuery.set("granularity", granularity);
  if (activeModels.length > 0) trendQuery.set("models", activeModels.join(","));
  const trendApi = useApi<ModelTrendResult>(`/api/models/trend?${trendQuery.toString()}`);

  const crossApi = useApi<ModelCrossResult>(
    `/api/models/cross?${baseQuery.toString()}&limit=${CROSS_USER_LIMIT}`,
  );

  const sortedRows = useMemo(() => {
    const rows = [...rankingRows];
    rows.sort((a, b) =>
      sortKey === "avgCost" ? b.avgCost - a.avgCost : b.totalQuota - a.totalQuota,
    );
    return rows;
  }, [rankingRows, sortKey]);

  // 图表 Top10 随维度重排：切换 Token / 请求数后按该维度取前 10（候选集为 quota 口径 Top100）
  const chartRows = useMemo(
    () =>
      [...rankingRows]
        .sort((left, right) => right[rankingMetric] - left[rankingMetric])
        .slice(0, MODEL_RANKING_CHART_LIMIT),
    [rankingRows, rankingMetric],
  );

  const toggleModel = (modelName: string): void => {
    const next = toggleModelSelection(activeModels, modelName);
    if (next !== activeModels) setSelectedModels(next);
  };

  const atLimit = activeModels.length >= TREND_MODEL_MAX;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">模型分析</h1>
        <p className="text-sm text-muted-foreground">
          模型消耗/请求排行、多模型趋势与用户 × 模型交叉分布；区间由筛选器控制。
        </p>
      </header>

      <TimeRangePicker />

      <Card className="gap-4 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-semibold">模型排行</h2>
          <div className="flex flex-wrap items-center gap-2">
            <MetricSwitch
              options={TREND_METRICS}
              value={rankingMetric}
              onChange={setRankingMetric}
              label="排行统计维度"
            />
            <ChartExportButton
              exportName="models-ranking"
              title="模型排行"
              csvHref={`/api/export/csv?dataset=modelsRanking&start=${range.start}&end=${range.end}&limit=${RANKING_FETCH_LIMIT}`}
              csvLabel="排行明细"
            />
          </div>
        </div>
        <div className="px-5">
          <SectionBody
            loading={rankingApi.loading}
            error={rankingApi.error}
            onRetry={rankingApi.refresh}
            skeletonHeight={240}
          >
            <EChart
              option={buildModelRankingOption(chartRows, rankingMetric)}
              height={Math.max(220, chartRows.length * 30 + 40)}
              empty={rankingRows.length === 0}
              emptyMessage="所选区间暂无模型数据"
              ariaLabel="模型消耗排行"
              exportName="models-ranking"
            />
          </SectionBody>
        </div>
        <div className="px-5">
          <div className="overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead className="text-right">消耗</TableHead>
                  <TableHead className="text-right">请求数</TableHead>
                  <TableHead className="text-right">Token</TableHead>
                  <TableHead className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-pressed={sortKey === "avgCost"}
                      onClick={() =>
                        setSortKey((key) => (key === "avgCost" ? "totalQuota" : "avgCost"))
                      }
                    >
                      单次平均成本 {sortKey === "avgCost" ? "↓" : ""}
                    </Button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((row) => (
                  <TableRow key={row.modelName}>
                    <TableCell className="max-w-56 truncate">{row.modelName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuota(row.totalQuota)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requestCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.totalTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuota(row.avgCost)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </Card>

      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">模型趋势</h2>
            <p className="text-xs text-muted-foreground">
              已选 {activeModels.length}/{TREND_MODEL_MAX}
              {atLimit ? "（已达上限，取消勾选后可再选）" : "（默认 Top5，最多 10 个）"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <GranularitySwitch />
            <ChartExportButton exportName="models-trend" title="模型趋势" />
          </div>
        </div>
        <div className="max-h-24 overflow-auto px-5">
          <div className="flex flex-wrap gap-1.5">
            {rankingRows.map((row) => {
              const active = activeModels.includes(row.modelName);
              const disabled = !active && atLimit;
              return (
                <Button
                  key={row.modelName}
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => toggleModel(row.modelName)}
                >
                  {row.modelName}
                </Button>
              );
            })}
            {rankingRows.length === 0 ? (
              <span className="text-xs text-muted-foreground">暂无模型可选</span>
            ) : null}
          </div>
        </div>
        <div className="px-5">
          <SectionBody
            loading={trendApi.loading}
            error={trendApi.error}
            onRetry={trendApi.refresh}
            skeletonHeight={300}
          >
            <EChart
              option={buildModelTrendOption(trendApi.data?.series ?? [])}
              height={300}
              empty={(trendApi.data?.series.length ?? 0) === 0}
              emptyMessage="所选模型暂无可展示的趋势"
              ariaLabel="模型消耗趋势"
              exportName="models-trend"
            />
          </SectionBody>
        </div>
      </Card>

      <Card className="gap-3 py-5">
        <div className="flex items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-semibold">用户 × 模型交叉分布</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Top {CROSS_USER_LIMIT} 用户 × Top 10 模型 + 其他
            </span>
            <ChartExportButton exportName="models-cross" title="用户 × 模型交叉分布" />
          </div>
        </div>
        <div className="px-5">
          <SectionBody
            loading={crossApi.loading}
            error={crossApi.error}
            onRetry={crossApi.refresh}
            skeletonHeight={320}
          >
            <ModelCrossStack result={crossApi.data} />
          </SectionBody>
        </div>
      </Card>
    </main>
  );
}
