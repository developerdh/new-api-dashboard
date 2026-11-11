"use client";

/**
 * 全局总览页客户端聚合（FE-M2-02）：指标卡 / 趋势 / 热力图 / 排行四块数据。
 *
 * - 时间范围与粒度只读 URL（`start`/`end`/`granularity`），由 dashboard layout 的选择器写入；
 * - 数据获取统一走 `useApi`，每块独立 loading/error/空数据三态；
 * - 热力图固定近 365 天（卡内口径），不随全局区间变化；
 * - 用户排行取 limit=100：图表展示 Top10，表格「查看全部」复用同一响应。
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { OverviewCards, type DeltaMetric } from "@/components/cards/overview-cards";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { TREND_METRICS, TrendLine, type TrendMetric } from "@/components/charts/trend-line";
import { UserRankingBar } from "@/components/charts/user-ranking-bar";
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
import { formatNumber, formatQuota } from "@/lib/format";
import {
  lastNDaysRange,
  parseGranularity,
  resolveRangeFromParams,
} from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type { OverviewSnapshot } from "@/server/queries/overview";
import type { TrendPoint, TrendSeries } from "@/server/queries/trend";
import type { UserRankingRow } from "@/server/queries/user";

const HEATMAP_DAYS = 365;
const RANKING_FETCH_LIMIT = 100;
const RANKING_CHART_LIMIT = 10;

function seriesSum(points: Array<TrendPoint | null> | undefined, key: DeltaMetric): number {
  return (points ?? []).reduce((total, point) => total + (point === null ? 0 : point[key]), 0);
}

function percentDelta(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-sm">
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
        className="w-full animate-pulse rounded-lg bg-muted"
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
  const [metric, setMetric] = useState<TrendMetric>("totalQuota");
  const [compare, setCompare] = useState<"prev" | "yoy">("prev");
  const [showAllRanking, setShowAllRanking] = useState(false);

  const query = `start=${range.start}&end=${range.end}`;
  const overviewApi = useApi<OverviewSnapshot>(`/api/overview?${query}`);
  const trendApi = useApi<TrendSeries>(
    `/api/trend?${query}&granularity=${granularity}&compare=${compare}`,
  );
  const rankingApi = useApi<{ rows: UserRankingRow[] }>(
    `/api/users/ranking?${query}&limit=${RANKING_FETCH_LIMIT}`,
  );

  const heatRange = useMemo(() => lastNDaysRange(HEATMAP_DAYS), []);
  const heatApi = useApi<TrendSeries>(
    `/api/trend?start=${heatRange.start}&end=${heatRange.end}&granularity=day`,
  );

  const trendPoints = useMemo(() => trendApi.data?.points ?? [], [trendApi.data?.points]);
  const compareLabel = compare === "prev" ? "较上期" : "较去年同期";
  const deltas = useMemo<Partial<Record<DeltaMetric, number>>>(() => {
    const compare = trendApi.data?.compareSeries;
    if (compare === undefined) return {};
    return {
      totalQuota: percentDelta(
        seriesSum(trendPoints, "totalQuota"),
        seriesSum(compare, "totalQuota"),
      ),
      requestCount: percentDelta(
        seriesSum(trendPoints, "requestCount"),
        seriesSum(compare, "requestCount"),
      ),
      totalTokens: percentDelta(
        seriesSum(trendPoints, "totalTokens"),
        seriesSum(compare, "totalTokens"),
      ),
    };
  }, [trendApi.data?.compareSeries, trendPoints]);

  const rankingRows = rankingApi.data?.rows ?? [];
  const chartRows = rankingRows.slice(0, RANKING_CHART_LIMIT);

  const openUser = (row: UserRankingRow): void => {
    const params = new URLSearchParams({
      start: String(range.start),
      end: String(range.end),
    });
    if (row.username !== "") params.set("username", row.username);
    router.push(`/users/${row.userId}?${params.toString()}`);
  };

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">全局总览</h1>
        <p className="text-sm text-muted-foreground">
          区间由顶部筛选器控制；指标来自 quota_data 聚合与 logs 精确请求数（quota_data 最多 5 分钟延迟）。
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <OverviewCards
          data={overviewApi.data}
          trendPoints={trendPoints}
          deltas={deltas}
          compareLabel={compareLabel}
          loading={overviewApi.loading}
        />
      </section>

      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-medium">消耗趋势</h2>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1" role="group" aria-label="趋势指标">
              {TREND_METRICS.map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={metric === item.key ? "secondary" : "ghost"}
                  aria-pressed={metric === item.key}
                  onClick={() => setMetric(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="对比方式">
              {(
                [
                  { key: "prev", label: "环比" },
                  { key: "yoy", label: "同比" },
                ] as const
              ).map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={compare === item.key ? "secondary" : "ghost"}
                  aria-pressed={compare === item.key}
                  onClick={() => setCompare(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
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
              metric={metric}
              height={300}
            />
          </SectionBody>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 py-5">
          <div className="flex items-center justify-between px-5">
            <h2 className="text-sm font-medium">每日消耗热力图（近一年）</h2>
          </div>
          <div className="px-5">
            <SectionBody
              loading={heatApi.loading}
              error={heatApi.error}
              onRetry={heatApi.refresh}
              skeletonHeight={190}
            >
              <CalendarHeatmap points={heatApi.data?.points ?? []} height={190} />
            </SectionBody>
          </div>
        </Card>

        <Card className="gap-3 py-5">
          <div className="flex items-center justify-between px-5">
            <h2 className="text-sm font-medium">用户消耗排行</h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={showAllRanking}
              onClick={() => setShowAllRanking((value) => !value)}
              disabled={rankingRows.length === 0}
            >
              {showAllRanking ? "收起" : "查看全部"}
            </Button>
          </div>
          <div className="px-5">
            <SectionBody
              loading={rankingApi.loading}
              error={rankingApi.error}
              onRetry={rankingApi.refresh}
              skeletonHeight={260}
            >
              <UserRankingBar rows={chartRows} onSelect={openUser} />
              {showAllRanking && rankingRows.length > 0 ? (
                <div className="mt-3 max-h-80 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>用户</TableHead>
                        <TableHead className="text-right">消耗</TableHead>
                        <TableHead className="text-right">请求数</TableHead>
                        <TableHead className="text-right">Token</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rankingRows.map((row) => (
                        <TableRow key={row.userId}>
                          <TableCell>
                            <Link
                              className="underline-offset-4 hover:underline"
                              href={`/users/${row.userId}?start=${range.start}&end=${range.end}${
                                row.username !== ""
                                  ? `&username=${encodeURIComponent(row.username)}`
                                  : ""
                              }`}
                            >
                              {row.username || `用户 ${row.userId}`}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatQuota(row.totalQuota)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.requestCount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.totalTokens)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </SectionBody>
          </div>
        </Card>
      </div>
    </main>
  );
}
