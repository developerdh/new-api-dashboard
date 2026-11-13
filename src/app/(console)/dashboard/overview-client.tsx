"use client";

/**
 * 全局总览页客户端聚合：指标卡 → 沉默用户清单卡 → 排行 / 热力图 → 趋势。
 *
 * - 时间范围与粒度只读 URL（`start`/`end`/`granularity`）；筛选器放在标题下方，与其它页一致；
 * - 数据获取统一走 `useApi`，每块独立 loading/error/空数据三态；
 * - 趋势 / 排行 / 热力图各有独立的统计维度切换（消耗额度 / 请求数 / Token）；
 * - 用户排行弹窗为受控 Dialog，「查看全部」与指标卡里的活跃用户数共用同一入口；
 * - 热力图固定近半年，不随全局区间变化。
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { InactiveUsersCard } from "@/components/cards/inactive-users-card";
import { OverviewCards, type DeltaMetric } from "@/components/cards/overview-cards";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { ChartExportButton } from "@/components/charts/chart-export-button";
import { GranularitySwitch } from "@/components/charts/granularity-switch";
import { MetricSwitch } from "@/components/charts/metric-switch";
import { TREND_METRICS, TrendLine, type TrendMetric } from "@/components/charts/trend-line";
import { UserRankingBar } from "@/components/charts/user-ranking-bar";
import { TimeRangePicker } from "@/components/layout/time-range-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMillions, formatNumber, formatQuota } from "@/lib/format";
import { primaryUserLabel, secondaryUserLabel } from "@/lib/user-label";
import {
  lastNDaysRange,
  parseGranularity,
  resolveRangeFromParams,
} from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type { InactiveUserRow, InactiveUsersSnapshot } from "@/server/queries/inactive";
import type { OverviewSnapshot } from "@/server/queries/overview";
import type { TrendPoint, TrendSeries } from "@/server/queries/trend";
import type { UserRankingRow } from "@/server/queries/user";

const HEATMAP_DAYS = 183;
const RANKING_FETCH_LIMIT = 100;
const RANKING_CHART_LIMIT = 10;
const INACTIVE_FETCH_LIMIT = 200;

const COMPARE_OPTIONS = [
  { key: "prev", label: "环比" },
  { key: "yoy", label: "同比" },
] as const;

function seriesSum(points: Array<TrendPoint | null> | undefined, key: DeltaMetric): number {
  return (points ?? []).reduce((total, point) => total + (point === null ? 0 : point[key]), 0);
}

function percentDelta(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

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

export function OverviewClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const granularity = parseGranularity(searchParams.get("granularity"));
  const granularityParam = searchParams.get("granularity");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("totalQuota");
  const [rankingMetric, setRankingMetric] = useState<TrendMetric>("totalQuota");
  const [heatMetric, setHeatMetric] = useState<TrendMetric>("totalQuota");
  const [compare, setCompare] = useState<"prev" | "yoy">("prev");
  const [rankingOpen, setRankingOpen] = useState(false);

  const query = `start=${range.start}&end=${range.end}`;
  const overviewApi = useApi<OverviewSnapshot>(`/api/overview?${query}`);
  const trendApi = useApi<TrendSeries>(
    `/api/trend?${query}&granularity=${granularity}&compare=${compare}`,
  );
  // 指标卡的额度轨 / 环比固定按日分桶，与趋势图的粒度解耦
  const dailyTrendApi = useApi<TrendSeries>(
    `/api/trend?${query}&granularity=day&compare=${compare}`,
  );
  const rankingApi = useApi<{ rows: UserRankingRow[] }>(
    `/api/users/ranking?${query}&limit=${RANKING_FETCH_LIMIT}`,
  );
  const inactiveApi = useApi<InactiveUsersSnapshot>(
    `/api/users/inactive?${query}&limit=${INACTIVE_FETCH_LIMIT}`,
  );

  const heatRange = useMemo(() => lastNDaysRange(HEATMAP_DAYS), []);
  const heatApi = useApi<TrendSeries>(
    `/api/trend?start=${heatRange.start}&end=${heatRange.end}&granularity=day`,
  );

  const trendPoints = useMemo(() => trendApi.data?.points ?? [], [trendApi.data?.points]);
  const dailyPoints = useMemo(
    () => dailyTrendApi.data?.points ?? [],
    [dailyTrendApi.data?.points],
  );
  const compareLabel = compare === "prev" ? "较上期" : "较去年同期";
  const deltas = useMemo<Partial<Record<DeltaMetric, number>>>(() => {
    const compare = dailyTrendApi.data?.compareSeries;
    if (compare === undefined) return {};
    return {
      totalQuota: percentDelta(
        seriesSum(dailyPoints, "totalQuota"),
        seriesSum(compare, "totalQuota"),
      ),
      requestCount: percentDelta(
        seriesSum(dailyPoints, "requestCount"),
        seriesSum(compare, "requestCount"),
      ),
      totalTokens: percentDelta(
        seriesSum(dailyPoints, "totalTokens"),
        seriesSum(compare, "totalTokens"),
      ),
    };
  }, [dailyTrendApi.data?.compareSeries, dailyPoints]);

  const rankingRows = rankingApi.data?.rows ?? [];
  const chartRows = rankingRows.slice(0, RANKING_CHART_LIMIT);

  /** 用户详情链接统一携带账号 + 昵称，标题即时显示昵称（无需等详情接口返回）。 */
  const userDetailHref = (
    userId: number,
    username: string,
    displayName: string | undefined,
    start: number,
    end: number,
  ): string => {
    const params = new URLSearchParams({ start: String(start), end: String(end) });
    if (username !== "") params.set("username", username);
    if (displayName !== undefined && displayName !== "") params.set("name", displayName);
    if (granularityParam !== null) params.set("granularity", granularityParam);
    return `/users/${userId}?${params.toString()}`;
  };

  const openUser = (row: UserRankingRow): void => {
    router.push(
      userDetailHref(row.userId, row.username, row.displayName, range.start, range.end),
    );
  };

  // 与全局筛选保持一致：总览选哪个区间，进详情就是哪个区间，返回总览时也原样带回。
  // （曾经这里用「上期区间」，导致点进沉默用户后筛选区间被换成上期、返回也带回上期。）
  const inactiveUserHref = (row: InactiveUserRow): string =>
    userDetailHref(row.userId, row.username, row.displayName, range.start, range.end);

  return (
    <main className="flex flex-col gap-6">
      <Dialog open={rankingOpen} onOpenChange={setRankingOpen}>
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
              用量概览 / Overview
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">全局总览</h1>
            <p className="text-sm text-muted-foreground">
              区间由筛选器控制；额度来自 quota_data 聚合，请求数取自 logs 精确计数。
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
            quota_data 延迟 ≤ 5 分钟
          </span>
        </header>

        <TimeRangePicker />

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <OverviewCards
            data={overviewApi.data}
            trendPoints={dailyPoints}
            deltas={deltas}
            compareLabel={compareLabel}
            loading={overviewApi.loading}
            onShowUsers={() => setRankingOpen(true)}
          />
        </section>

        <InactiveUsersCard
          data={inactiveApi.data}
          loading={inactiveApi.loading}
          error={inactiveApi.error}
          onRetry={inactiveApi.refresh}
          userHref={inactiveUserHref}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-3 py-5">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5">
              <h2 className="text-sm font-semibold">用户消耗排行</h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <MetricSwitch
                  options={TREND_METRICS}
                  value={rankingMetric}
                  onChange={setRankingMetric}
                  label="排行统计维度"
                />
                <ChartExportButton
                  exportName="users-ranking"
                  title="用户消耗排行"
                  csvHref={`/api/export/csv?dataset=usersRanking&start=${range.start}&end=${range.end}&limit=100`}
                  csvLabel="排行明细"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRankingOpen(true)}
                  disabled={rankingRows.length === 0}
                >
                  查看全部
                </Button>
              </div>
            </div>

            <div className="px-5">
              <SectionBody
                loading={rankingApi.loading}
                error={rankingApi.error}
                onRetry={rankingApi.refresh}
                skeletonHeight={260}
              >
                <UserRankingBar rows={chartRows} onSelect={openUser} metric={rankingMetric} />
              </SectionBody>
            </div>
          </Card>

          <Card className="gap-3 py-5">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5">
              <h2 className="text-sm font-semibold">每日消耗热力图</h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <MetricSwitch
                  options={TREND_METRICS}
                  value={heatMetric}
                  onChange={setHeatMetric}
                  label="热力图统计维度"
                />
                <ChartExportButton exportName="dashboard-heatmap" title="每日消耗热力图" />
              </div>
            </div>
            <div className="px-5">
              <SectionBody
                loading={heatApi.loading}
                error={heatApi.error}
                onRetry={heatApi.refresh}
                skeletonHeight={190}
              >
                <CalendarHeatmap
                  points={heatApi.data?.points ?? []}
                  height={190}
                  metric={heatMetric}
                  exportName="dashboard-heatmap"
                />
              </SectionBody>
            </div>
          </Card>
        </div>

        <Card className="gap-3 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">消耗趋势</h2>
              <p className="text-[11px] text-muted-foreground">
                按所选粒度聚合，支持环比 / 同比对照
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MetricSwitch
                options={TREND_METRICS}
                value={trendMetric}
                onChange={setTrendMetric}
                label="趋势统计维度"
              />
              <GranularitySwitch />
              <MetricSwitch
                options={COMPARE_OPTIONS}
                value={compare}
                onChange={setCompare}
                label="对比方式"
              />
              <ChartExportButton exportName="dashboard-trend" title="消耗趋势" />
            </div>
          </div>
          <div className="px-5">
            <SectionBody
              loading={trendApi.loading}
              error={trendApi.error}
              onRetry={trendApi.refresh}
              skeletonHeight={300}
            >
              <TrendLine
                points={trendPoints}
                comparePoints={trendApi.data?.compareSeries}
                metric={trendMetric}
                height={300}
                exportName="dashboard-trend"
              />
            </SectionBody>
          </div>
        </Card>

        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>用户消耗排行 · 全部</DialogTitle>
            <DialogDescription>当前区间共 {rankingRows.length} 位用户。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead className="text-right">消耗</TableHead>
                  <TableHead className="text-right">请求数</TableHead>
                  <TableHead className="text-right">Token (M)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rankingRows.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link
                          className="underline-offset-4 hover:underline"
                          href={userDetailHref(
                            row.userId,
                            row.username,
                            row.displayName,
                            range.start,
                            range.end,
                          )}
                        >
                          {primaryUserLabel(row)}
                        </Link>
                        {secondaryUserLabel(row) === "" ? null : (
                          <span className="text-[11px] text-muted-foreground">
                            {secondaryUserLabel(row)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuota(row.totalQuota)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requestCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMillions(row.totalTokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
