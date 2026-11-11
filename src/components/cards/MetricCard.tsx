/**
 * 指标卡（FE-M2-01 / 方案 §7.2「总览：数字卡片」）。
 *
 * 纯展示组件（服务端/客户端均可用）：数值由调用方格式化好再传入，
 * 避免组件内做业务口径换算；环比/提示文字均为可选。
 */
import type { ReactNode } from "react";

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
  /** 卡片底部扩展区（迷你趋势图等）。 */
  children?: ReactNode;
}

export function MetricCard({
  title,
  value,
  hint,
  delta,
  icon,
  className,
  children,
}: MetricCardProps) {
  return (
    <Card className={cn("gap-3 py-5", className)}>
      <CardHeader className="px-5">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          {icon !== undefined ? (
            <span className="text-muted-foreground" aria-hidden="true">
              {icon}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          {delta !== undefined ? (
            <span className="text-xs text-muted-foreground tabular-nums">{delta}</span>
          ) : null}
        </div>
        {hint !== undefined ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        {children !== undefined ? <div className="mt-3">{children}</div> : null}
      </CardContent>
    </Card>
  );
}
