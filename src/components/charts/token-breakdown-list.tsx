/**
 * Token 构成列表：数值行 + 细比例条（无图表库依赖，行数可扩展，替代旧的双段占比条）。
 *
 * 口径（实测见 db-schema-notes §3.7）：openai 语义 prompt_tokens 已含缓存，
 * anthropic 语义不含 —— 有效输入 = prompt + anthropic 行缓存读写修正量；
 * 缓存命中率 = 缓存读取 / 有效输入。缓存为输入的细分，绝不与输入并列相加。
 */
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TokenBreakdownInput {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheOutsidePromptTokens: number;
}

export interface TokenBreakdownRow {
  key: "input" | "output";
  label: string;
  tokens: number;
  /** 占「有效输入 + 输出」合计的比例（0–1）。 */
  share: number;
  colorClass: string;
}

export interface TokenBreakdownCacheRow {
  key: "cache-read" | "cache-write";
  label: string;
  tokens: number;
  /** 占有效输入的比例（0–1，脏数据上限截断为 1）。 */
  share: number;
}

export interface TokenBreakdown {
  rows: TokenBreakdownRow[];
  /** 缓存子行（仅对应量 > 0 时出现），归属输入行之下。 */
  cacheRows: TokenBreakdownCacheRow[];
  /** 有效输入 = prompt + anthropic 语义行的缓存读写修正量。 */
  effectiveInputTokens: number;
  /** 缓存命中率 = 缓存读取 / 有效输入（0–1）。 */
  cacheHitRate: number;
  isEmpty: boolean;
}

/** 细比例条最小可见宽度：占比极小（如 0.8%）时仍可辨认，数值以文本为准。 */
const MIN_BAR_WIDTH = 0.02;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

/** 纯函数：由聚合快照推导列表行、占比与命中率（无副作用，供单测）。 */
export function computeTokenBreakdown(input: TokenBreakdownInput): TokenBreakdown {
  const effectiveInputTokens = input.promptTokens + input.cacheOutsidePromptTokens;
  const total = effectiveInputTokens + input.completionTokens;

  const rows: TokenBreakdownRow[] = [
    {
      key: "input",
      label: "输入 Token",
      tokens: effectiveInputTokens,
      share: total > 0 ? effectiveInputTokens / total : 0,
      colorClass: "bg-chart-2",
    },
    {
      key: "output",
      label: "输出 Token",
      tokens: input.completionTokens,
      share: total > 0 ? input.completionTokens / total : 0,
      colorClass: "bg-chart-1",
    },
  ];

  const cacheRows: TokenBreakdownCacheRow[] = [];
  if (input.cacheReadTokens > 0) {
    cacheRows.push({
      key: "cache-read",
      label: "其中缓存命中",
      tokens: input.cacheReadTokens,
      share: clamp01(input.cacheReadTokens / effectiveInputTokens),
    });
  }
  if (input.cacheWriteTokens > 0) {
    cacheRows.push({
      key: "cache-write",
      label: "其中缓存写入",
      tokens: input.cacheWriteTokens,
      share: clamp01(input.cacheWriteTokens / effectiveInputTokens),
    });
  }

  return {
    rows,
    cacheRows,
    effectiveInputTokens,
    cacheHitRate: clamp01(input.cacheReadTokens / effectiveInputTokens),
    isEmpty: total === 0,
  };
}

export interface TokenBreakdownListProps extends TokenBreakdownInput {
  className?: string;
}

export function TokenBreakdownList({
  promptTokens,
  completionTokens,
  cacheReadTokens,
  cacheWriteTokens,
  cacheOutsidePromptTokens,
  className,
}: TokenBreakdownListProps) {
  const breakdown = computeTokenBreakdown({
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheOutsidePromptTokens,
  });

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {breakdown.isEmpty ? (
        <p className="text-xs text-muted-foreground">所选区间内无 Token 使用记录</p>
      ) : (
        breakdown.rows.map((row) => (
          <div key={row.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn("size-2 rounded-full", row.colorClass)} aria-hidden="true" />
                {row.label}
              </span>
              <span className="tabular-nums">
                {formatCompactNumber(row.tokens)}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {formatPercent(row.share)}
                </span>
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className={cn("h-full rounded-full transition-[width]", row.colorClass)}
                style={{
                  width: `${Math.max(row.share, row.share > 0 ? MIN_BAR_WIDTH : 0) * 100}%`,
                }}
              />
            </div>
            {row.key === "input" && breakdown.cacheRows.length > 0 ? (
              <dl className="flex flex-col gap-1 pb-0.5 pl-3.5 text-xs text-muted-foreground">
                {breakdown.cacheRows.map((cacheRow) => (
                  <div key={cacheRow.key} className="flex items-baseline justify-between gap-3">
                    <dt>{cacheRow.label}</dt>
                    <dd className="tabular-nums">
                      {formatCompactNumber(cacheRow.tokens)}
                      <span className="ml-1.5">
                        {cacheRow.key === "cache-read"
                          ? `命中率 ${formatPercent(breakdown.cacheHitRate)}`
                          : `占输入 ${formatPercent(cacheRow.share)}`}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {row.key === "input" && breakdown.cacheRows.length > 0 ? (
              <p className="text-[11px] leading-4 text-muted-foreground/80">
                口径：输入含缓存读写修正（跨上游语义归一），命中率为缓存读取占有效输入比例
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
