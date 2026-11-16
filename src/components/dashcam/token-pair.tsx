"use client";

/**
 * Token 用量胶囊：输入（蓝）、输出（绿），有缓存命中时追加「缓存」小标（琥珀）。
 *
 * 为什么取代字节胶囊：正文落盘字节对"这次调用花了多少上下文"几乎没有诊断价值，
 * token 才是模型视角的真实口径；缓存的输入 token 又能直接看出重复上下文被
 * 缓存吃掉多少。字节信息保留在胶囊的 title 里（悬停可见），详情抽屉的
 * 「原始报文」页签也有完整大小。
 *
 * 字段缺失（采集正文未含该 token 字段）显示 `—` 而不是 0——
 * 「未知」与「真实为 0」是两回事，渲染成 0 会误导对数。
 */
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashcamUsage } from "@/server/dashcam/types";

const CAPSULE =
  "inline-flex h-[18px] items-center justify-center rounded-md px-1.5 text-[11px] tabular-nums whitespace-nowrap";

/** 单个 token 字段的展示值：缺失 → `—`（未知），其余千分位。 */
export function tokenDisplay(value: number | undefined): string {
  return value === undefined ? "—" : formatNumber(value);
}

export function TokenPair({ usage, className }: { usage: DashcamUsage; className?: string }) {
  const cached = usage.cachedTokens ?? 0;
  return (
    <span className={cn("inline-flex items-center justify-end gap-1", className)}>
      <span
        className={cn(CAPSULE, "w-[4.5rem] bg-info/15 text-info")}
        title={`输入 ${tokenDisplay(usage.promptTokens)} token${usage.promptTokens === undefined ? "（未知）" : ""}`}
      >
        {tokenDisplay(usage.promptTokens)}
      </span>
      <span
        className={cn(CAPSULE, "w-[4.5rem] bg-success/15 text-success")}
        title={`输出 ${tokenDisplay(usage.completionTokens)} token${usage.completionTokens === undefined ? "（未知）" : ""}`}
      >
        {tokenDisplay(usage.completionTokens)}
      </span>
      {cached > 0 ? (
        <span
          className="inline-flex h-[18px] items-center rounded-md bg-warning/20 px-1.5 text-[10px] tabular-nums text-warning whitespace-nowrap"
          title={`缓存命中 ${formatNumber(cached)} token（重复上下文被缓存吃掉的部分）`}
        >
          缓存 {formatCompactNumber(cached)}
        </span>
      ) : null}
    </span>
  );
}

/** 表头用：与 TokenPair 同宽的两列小标题，颜色与胶囊对应。 */
export function TokenPairHead({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-end gap-1", className)}>
      <span className="w-[4.5rem] text-center text-info">输入</span>
      <span className="w-[4.5rem] text-center text-success">输出</span>
    </span>
  );
}
