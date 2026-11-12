"use client";

/**
 * 指标卡：数值由调用方格式化好再传入，避免组件内做业务口径换算。
 * `hint` 为口径说明，收进标题右侧的 i 图标，鼠标悬停 / 键盘聚焦时展示；
 * 用 peer-hover + peer-focus-visible（而非 group-focus-within），避免点击后鼠标移开仍常驻。
 * `rail` 传入区间内每日序列，渲染本看板签名元素「额度轨」。
 */
import { Info } from "lucide-react";
import { useId, type ReactNode } from "react";

import { QuotaRail } from "@/components/cards/quota-rail";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface MetricCardProps {
  title: string;
  value: string;
  hint?: string;
  /** 环比增量文案（已格式化，如 +12.3%）；为空则不展示。 */
  delta?: string;
  icon?: ReactNode;
  className?: string;
  /** 卡片底部扩展区。 */
  children?: ReactNode;
  /** 区间内每日数值序列，用于额度轨。 */
  rail?: number[];
  railLabel?: string;
}

export function MetricCard({
  title,
  value,
  hint,
  delta,
  icon,
  className,
  children,
  rail,
  railLabel,
}: MetricCardProps) {
  const hintId = useId();

  return (
    <Card data-card-hover="true" className={cn("gap-3 py-5", className)}>
      <CardHeader className="px-5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground">
            {title}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            {hint !== undefined ? (
              <span className="relative inline-flex">
                <button
                  type="button"
                  className="peer grid size-5 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-primary"
                  aria-label={`${title}口径说明`}
                  aria-describedby={hintId}
                >
                  <Info className="size-3.5" aria-hidden="true" />
                </button>
                <span
                  id={hintId}
                  role="tooltip"
                  className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 w-max max-w-56 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 peer-hover:opacity-100 peer-focus-visible:opacity-100"
                >
                  {hint}
                </span>
              </span>
            ) : null}
            {icon !== undefined ? (
              <span className="text-muted-foreground" aria-hidden="true">
                {icon}
              </span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          {delta !== undefined ? (
            <span className="text-xs tabular-nums text-muted-foreground">{delta}</span>
          ) : null}
        </div>
        {children !== undefined ? <div className="mt-3">{children}</div> : null}
        {rail !== undefined ? <QuotaRail values={rail} label={railLabel} /> : null}
      </CardContent>
    </Card>
  );
}
