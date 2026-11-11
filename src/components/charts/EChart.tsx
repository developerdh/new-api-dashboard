"use client";

/**
 * ECharts 封装（FE-M2-01）：声明式 option + 客户端懒加载 + 自适应 + 导出插槽。
 *
 * 用法（FE-M2-02~04 统一走这里）：
 * ```tsx
 * <EChart option={option} title="趋势" actions={<Button>导出</Button>} height={320} />
 * ```
 * 导出按钮插槽由 FE-M3-02 接入（自包含 HTML 模板）。
 */
import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const EChartInner = dynamic(() => import("./echart-inner"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-muted" />,
});

export interface EChartProps {
  option: EChartsOption;
  /** 图表区高度（数字 = px）。 */
  height?: number | string;
  title?: ReactNode;
  /** 右上角操作区（导出按钮等）。 */
  actions?: ReactNode;
  className?: string;
  /** 无数据时显示占位，不初始化 ECharts。 */
  empty?: boolean;
  emptyMessage?: string;
  ariaLabel?: string;
  /** 事件绑定（如柱状图 click）；key 为 ECharts 事件名。 */
  onEvents?: Record<string, (params: unknown) => void>;
}

export function EChart({
  option,
  height = 320,
  title,
  actions,
  className,
  empty = false,
  emptyMessage = "暂无数据",
  ariaLabel,
  onEvents,
}: EChartProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {(title !== undefined || actions !== undefined) && (
        <div className="flex items-center justify-between gap-3">
          {title !== undefined ? <div className="text-sm font-medium">{title}</div> : <span />}
          {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      )}
      <div style={{ height }} className="w-full">
        {empty ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <EChartInner option={option} ariaLabel={ariaLabel} onEvents={onEvents} />
        )}
      </div>
    </div>
  );
}
