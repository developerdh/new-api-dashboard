/**
 * Token 输入/输出占比（FE-M2-03）：双段条形（无图表库依赖，便于无障碍与快照）。
 * 数据来自单用户 overview 的 prompt/completion 聚合。
 */
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TokenSplitBarProps {
  promptTokens: number;
  completionTokens: number;
  className?: string;
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

export function TokenSplitBar({ promptTokens, completionTokens, className }: TokenSplitBarProps) {
  const total = promptTokens + completionTokens;
  const promptShare = ratio(promptTokens, total);
  const completionShare = ratio(completionTokens, total);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`输入 Token 占 ${formatPercent(promptShare)}，输出 Token 占 ${formatPercent(completionShare)}`}
      >
        <div
          className="h-full bg-chart-2 transition-[width]"
          style={{ width: `${promptShare * 100}%` }}
          title={`输入 ${formatPercent(promptShare)}`}
        />
        <div
          className="h-full bg-chart-1 transition-[width]"
          style={{ width: `${completionShare * 100}%` }}
          title={`输出 ${formatPercent(completionShare)}`}
        />
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-chart-2" aria-hidden="true" />
            输入 Token
          </dt>
          <dd className="tabular-nums">
            {formatCompactNumber(promptTokens)}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {formatPercent(promptShare)}
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-chart-1" aria-hidden="true" />
            输出 Token
          </dt>
          <dd className="tabular-nums">
            {formatCompactNumber(completionTokens)}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {formatPercent(completionShare)}
            </span>
          </dd>
        </div>
      </dl>

      {total === 0 ? (
        <p className="text-xs text-muted-foreground">所选区间内无 Token 使用记录</p>
      ) : null}
    </div>
  );
}
