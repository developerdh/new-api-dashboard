"use client";

/**
 * 单用户详情客户端：总览卡 / 趋势 / 模型分布 / Token 占比 / 活跃热力图 / 最近记录。
 *
 * - 时间范围与粒度继承 URL（排行跳转时透传 start/end，另带 username + name 供标题即时展示）；
 * - 标题昵称优先、账号作次要信息；直接访问无 URL 名称时由 overview 返回的 users 身份补齐；
 * - 非法 id（后端 400 issues.path=id）显示错误态；区间内请求数为 0 时显示空态提示（与全 0 区分）。
 */
import { Download } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { MetricCard } from "@/components/cards/MetricCard";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { ChartExportButton } from "@/components/charts/chart-export-button";
import { GranularitySwitch } from "@/components/charts/granularity-switch";
import { ModelPie } from "@/components/charts/model-pie";
import { TokenSplitBar } from "@/components/charts/token-split-bar";
import { TREND_METRICS, TrendLine, type TrendMetric } from "@/components/charts/trend-line";
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
import {
  formatCompactNumber,
  formatDateTime,
  formatNumber,
  formatQuota,
} from "@/lib/format";
import { lastNDaysRange, parseGranularity, resolveRangeFromParams } from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import { primaryUserLabel, secondaryUserLabel } from "@/lib/user-label";
import type { UserOverviewSnapshot } from "@/server/queries/user";
import type { TrendSeries } from "@/server/queries/trend";
import type { UserModelRow, UserRecentRow } from "@/server/queries/user";

import { AuditSessions } from "./audit-sessions";

const HEATMAP_DAYS = 183;
const RECENT_PAGE_SIZE = 10;

/** 与 `src/server/queries/common.ts` 的 `EXCLUDED_STAT_USERNAMES` 保持一致的展示提示。 */
const EXCLUDED_STAT_ACCOUNT = "admin";

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-sm">
      <p className="text-muted-foreground">{message}</p>
      {onRetry !== undefined ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      ) : null}
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
  onRetry?: () => void;
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

export function UserClient({ userId }: { userId: string }) {
  const searchParams = useSearchParams();
  const range = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const granularity = parseGranularity(searchParams.get("granularity"));
  const urlUsername = searchParams.get("username");
  const urlDisplayName = searchParams.get("name");

  const [metric, setMetric] = useState<TrendMetric>("totalQuota");
  const [recentPage, setRecentPage] = useState(0);

  const query = `start=${range.start}&end=${range.end}`;
  const basePath = `/api/users/${encodeURIComponent(userId)}`;
  const overviewApi = useApi<UserOverviewSnapshot>(`${basePath}/overview?${query}`);
  const trendApi = useApi<TrendSeries>(
    `${basePath}/trend?${query}&granularity=${granularity}`,
  );
  const modelsApi = useApi<{ models: UserModelRow[]; recent: UserRecentRow[] }>(
    `${basePath}/models?${query}`,
  );

  const heatRange = useMemo(() => lastNDaysRange(HEATMAP_DAYS), []);
  const heatApi = useApi<TrendSeries>(
    `${basePath}/trend?start=${heatRange.start}&end=${heatRange.end}&granularity=day`,
  );

  const invalidId = overviewApi.error?.issues?.some((issue) => issue.path === "id") ?? false;
  const overview = overviewApi.data;
  const isEmpty = overview !== undefined && overview.requestCount === 0;
  // 统计口径排除的账号（admin）直接访问详情时全 0，给出解释而不是让人误以为无数据
  const isExcludedAccount =
    (overview?.username ?? urlUsername ?? "").trim().toLowerCase() ===
    EXCLUDED_STAT_ACCOUNT;

  const recent = modelsApi.data?.recent ?? [];
  const pageCount = Math.max(1, Math.ceil(recent.length / RECENT_PAGE_SIZE));
  const safePage = Math.min(recentPage, pageCount - 1);
  const pageRows = recent.slice(safePage * RECENT_PAGE_SIZE, (safePage + 1) * RECENT_PAGE_SIZE);

  const granularityParam = searchParams.get("granularity");
  const backHref = `/dashboard?${query}${
    granularityParam !== null ? `&granularity=${encodeURIComponent(granularityParam)}` : ""
  }`;
  // 标题先取 URL（跳转瞬间即有昵称），缺失时由 overview 返回的 users 身份补齐（直接访问/分享链接）。
  const identity = {
    userId: Number(userId) || 0,
    username: urlUsername ?? overview?.username ?? "",
    displayName: urlDisplayName ?? overview?.displayName ?? "",
  };
  const primaryLabel = primaryUserLabel(identity);
  const secondaryLabel = secondaryUserLabel(identity);

  if (invalidId) {
    return (
      <main className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">用户不存在或 ID 非法</h1>
          <p className="text-sm text-muted-foreground">
            用户 id 必须是正整数（当前：
            <span className="font-mono">{userId}</span>）。
          </p>
        </header>
        <div className="flex gap-2">
          <Button asChild size="sm">
            <Link href={backHref}>返回总览</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{primaryLabel}</h1>
            {secondaryLabel === "" ? null : (
              <span className="text-sm text-muted-foreground">{secondaryLabel}</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            用户 ID <span className="font-mono">{userId}</span> · 区间内单用户消耗与使用明细
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="icon" variant="ghost" className="size-7 text-muted-foreground">
            <a
              href={`/api/export/csv?dataset=userModels&userId=${encodeURIComponent(userId)}&start=${range.start}&end=${range.end}`}
              download
              title="导出 CSV"
              aria-label="导出该用户模型明细 CSV"
            >
              <Download className="size-3.5" />
            </a>
          </Button>
          <Button asChild size="sm">
            <Link href={backHref}>返回总览</Link>
          </Button>
        </div>
      </header>

      <TimeRangePicker />

      {isExcludedAccount ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          该账号（{EXCLUDED_STAT_ACCOUNT}）已从统计口径中排除，故所有指标恒为 0。
        </p>
      ) : isEmpty ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          所选区间内该用户没有使用记录（请求数为 0）。
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="总消耗额度"
          value={overview === undefined ? "—" : formatQuota(overview.totalQuota)}
          hint={overview === undefined ? "加载中…" : "按 500000 quota = $1 换算"}
        />
        <MetricCard
          title="请求数"
          value={overview === undefined ? "—" : formatNumber(overview.requestCount)}
          hint={overview === undefined ? "加载中…" : "来自 logs 精确计数"}
        />
        <MetricCard
          title="总 Token"
          value={overview === undefined ? "—" : formatCompactNumber(overview.totalTokens)}
          hint="总量取 quota_data，输入/输出拆分取 logs（≤5 分钟延迟）"
        >
          {/* 输入/输出是统计信息而非口径说明，直接展示，不进 i 提示 */}
          <p className="text-[11px] tabular-nums text-muted-foreground">
            输入 {overview === undefined ? "—" : formatCompactNumber(overview.promptTokens)} · 输出{" "}
            {overview === undefined ? "—" : formatCompactNumber(overview.completionTokens)}
          </p>
        </MetricCard>
        <MetricCard
          title="活跃天数"
          value={overview === undefined ? "—" : formatNumber(overview.activeDays)}
          hint={overview === undefined ? "加载中…" : "区间内东八区自然日去重"}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 py-5">
          <div className="flex items-center justify-between px-5">
            <h2 className="text-sm font-semibold">模型消耗分布</h2>
            <ChartExportButton exportName="user-models" title="模型消耗分布" />
          </div>
          <div className="px-5">
            <SectionBody
              loading={modelsApi.loading}
              error={modelsApi.error}
              onRetry={modelsApi.refresh}
              skeletonHeight={260}
            >
              <ModelPie rows={modelsApi.data?.models ?? []} />
            </SectionBody>
          </div>
        </Card>

        <Card className="gap-3 py-5">
          <div className="flex items-center justify-between px-5">
            <h2 className="text-sm font-semibold">Token 输入/输出占比</h2>
          </div>
          <div className="px-5 py-2">
            <SectionBody
              loading={overviewApi.loading}
              error={overviewApi.error}
              onRetry={overviewApi.refresh}
              skeletonHeight={140}
            >
              <TokenSplitBar
                promptTokens={overview?.promptTokens ?? 0}
                completionTokens={overview?.completionTokens ?? 0}
              />
            </SectionBody>
          </div>
        </Card>
      </div>

      <Card className="gap-3 py-5">
        <div className="flex items-center justify-between px-5">
          <h2 className="text-sm font-semibold">活跃热力图</h2>
          <ChartExportButton exportName="user-heatmap" title="活跃热力图" />
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
              exportName="user-heatmap"
            />
          </SectionBody>
        </div>
      </Card>

      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-semibold">最近使用记录</h2>
          <span className="text-xs text-muted-foreground">
            最近 {recent.length} 条（服务端最多返回 50 条）
          </span>
        </div>
        <div className="px-5">
          <SectionBody
            loading={modelsApi.loading}
            error={modelsApi.error}
            onRetry={modelsApi.refresh}
            skeletonHeight={220}
          >
            {recent.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                暂无使用记录
              </p>
            ) : (
              <>
                <div className="overflow-auto rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">消耗</TableHead>
                        <TableHead className="text-right">输入</TableHead>
                        <TableHead className="text-right">输出</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map((row, index) => (
                        <TableRow key={`${row.createdAt}-${row.modelName}-${safePage}-${index}`}>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            {formatDateTime(row.createdAt)}
                          </TableCell>
                          <TableCell className="max-w-40 truncate">{row.modelName}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatQuota(row.quota)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.promptTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.completionTokens)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">
                    第 {safePage + 1} / {pageCount} 页 · 共 {recent.length} 条
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={safePage === 0}
                      onClick={() => setRecentPage((page) => Math.max(0, page - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setRecentPage((page) => Math.min(pageCount - 1, page + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </>
            )}
          </SectionBody>
        </div>
      </Card>

      <AuditSessions userId={userId} start={range.start} end={range.end} />

      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-semibold">使用趋势</h2>
          <div className="flex flex-wrap items-center gap-2">
            <GranularitySwitch />
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
            <ChartExportButton exportName="user-trend" title="使用趋势" />
          </div>
        </div>
        <div className="px-5">
          <SectionBody
            loading={trendApi.loading}
            error={trendApi.error}
            onRetry={trendApi.refresh}
            skeletonHeight={280}
          >
            <TrendLine
              points={trendApi.data?.points ?? []}
              metric={metric}
              height={280}
              exportName="user-trend"
            />
          </SectionBody>
        </div>
      </Card>
    </main>
  );
}
