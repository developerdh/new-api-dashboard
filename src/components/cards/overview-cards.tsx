/** 总览指标卡组：3 张带额度轨的主指标 + 1 张低信息量合并卡，视觉权重一致。 */
import { MetricCard } from "@/components/cards/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCompactNumber, formatDelta, formatNumber, formatQuota } from "@/lib/format";
import type { OverviewSnapshot } from "@/server/queries/overview";
import type { TrendPoint } from "@/server/queries/trend";

export type DeltaMetric = "totalQuota" | "requestCount" | "totalTokens";

export interface OverviewCardsProps {
  data?: OverviewSnapshot;
  trendPoints?: TrendPoint[];
  /** 环比百分比（正负均为百分数，如 12.3 / -4.5）；缺失则不展示。 */
  deltas?: Partial<Record<DeltaMetric, number>>;
  /** 对比文案前缀（环比「较上期」/ 同比「较去年同期」）。 */
  compareLabel?: string;
  loading: boolean;
  /** 点击活跃用户数时打开用户消耗排行弹窗。 */
  onShowUsers?: () => void;
}

function deltaOf(
  deltas: OverviewCardsProps["deltas"],
  key: DeltaMetric,
  label: string,
): string | undefined {
  const value = deltas?.[key];
  return value === undefined ? undefined : `${label} ${formatDelta(value)}`;
}

/** 活跃用户 / 模型数信息量小且无趋势序列，合并成一张双指标卡；说明直接展示，不收进 i。 */
function CompactOverviewCard({
  activeUsers,
  modelCount,
  onShowUsers,
}: {
  activeUsers: string;
  modelCount: string;
  onShowUsers?: () => void;
}) {
  return (
    <Card data-card-hover="true" className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground">
          活跃概览
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        <div className="space-y-2.5">
          <div>
            <div className="flex items-baseline gap-2">
              <button
                type="button"
                onClick={onShowUsers}
                title="查看用户消耗排行"
                aria-label="查看用户消耗排行"
                className="text-2xl font-semibold tabular-nums tracking-tight transition-colors hover:text-primary hover:underline underline-offset-4"
              >
                {activeUsers}
              </button>
              <span className="text-xs text-muted-foreground">活跃用户</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">区间内去重用户数</p>
          </div>
          <div className="border-t border-border" />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {modelCount}
              </span>
              <span className="text-xs text-muted-foreground">模型数</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">区间内去重模型数</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewCards({
  data,
  trendPoints,
  deltas,
  compareLabel = "较上期",
  loading,
  onShowUsers,
}: OverviewCardsProps) {
  const points = trendPoints ?? [];
  const seriesOf = (key: DeltaMetric): number[] => points.map((point) => point[key]);
  const placeholder = loading || data === undefined;

  return (
    <>
      <MetricCard
        title="总消耗额度"
        value={placeholder ? "—" : formatQuota(data.totalQuota)}
        hint="按 500000 quota = $1 换算"
        delta={deltaOf(deltas, "totalQuota", compareLabel)}
        rail={seriesOf("totalQuota")}
        railLabel="额度 · 日分布"
      />

      <MetricCard
        title="总请求数"
        value={placeholder ? "—" : formatNumber(data.requestCount)}
        hint="来自 logs 精确计数"
        delta={deltaOf(deltas, "requestCount", compareLabel)}
        rail={seriesOf("requestCount")}
        railLabel="请求 · 日分布"
      />

      <MetricCard
        title="总 Token"
        value={placeholder ? "—" : formatCompactNumber(data.totalTokens)}
        hint="总量取 quota_data，输入/输出拆分取 logs（≤5 分钟延迟）"
        delta={deltaOf(deltas, "totalTokens", compareLabel)}
        rail={seriesOf("totalTokens")}
        railLabel="Token · 日分布"
      >
        {/* 输入/输出是统计信息而非口径说明，直接展示，不进 i 提示 */}
        <p className="text-[11px] tabular-nums text-muted-foreground">
          输入 {data === undefined ? "—" : formatCompactNumber(data.promptTokens)} · 输出{" "}
          {data === undefined ? "—" : formatCompactNumber(data.completionTokens)}
        </p>
      </MetricCard>

      <CompactOverviewCard
        activeUsers={placeholder ? "—" : formatNumber(data.activeUsers)}
        modelCount={placeholder ? "—" : formatNumber(data.modelCount)}
        onShowUsers={onShowUsers}
      />
    </>
  );
}
