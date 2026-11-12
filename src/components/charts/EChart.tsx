"use client";

/**
 * ECharts 封装：声明式 option + 客户端懒加载 + 自适应。
 *
 * 单图导出（方案 §8.1）：实例按 exportName 注册到 `lib/chart-export`，
 * 由卡片标题栏的 ChartExportButton 触发；图表区域不再为导出按钮多渲染一行。
 */
import type { ECharts, EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { registerChart } from "@/lib/chart-export";
import { cn } from "@/lib/utils";

const EChartInner = dynamic(() => import("./echart-inner"), {
  ssr: false,
  loading: () => <div className="h-full w-full rounded-lg skeleton-shimmer" />,
});

export interface EChartProps {
  option: EChartsOption;
  /** 图表区高度（数字 = px）。 */
  height?: number | string;
  title?: ReactNode;
  /** 顶部操作区（传入时才渲染顶行）。 */
  actions?: ReactNode;
  className?: string;
  /** 无数据时显示占位，不初始化 ECharts。 */
  empty?: boolean;
  emptyMessage?: string;
  ariaLabel?: string;
  /** 事件绑定（如柱状图 click）；key 为 ECharts 事件名。 */
  onEvents?: Record<string, (params: unknown) => void>;
  /** 注册名，与卡片标题栏 ChartExportButton 的 exportName 一致。 */
  exportName?: string;
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
  exportName = "chart",
}: EChartProps) {
  const nameRef = useRef(exportName);
  useEffect(() => {
    nameRef.current = exportName;
  }, [exportName]);

  const handleReady = useCallback((chart: ECharts | null) => {
    registerChart(nameRef.current, chart);
  }, []);

  const showHeader = title !== undefined || actions !== undefined;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3">
          {title !== undefined ? <div className="text-sm font-medium">{title}</div> : <span />}
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : null}
      <div style={{ height }} className="w-full">
        {empty ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <EChartInner
            option={option}
            ariaLabel={ariaLabel}
            onEvents={onEvents}
            onReady={handleReady}
          />
        )}
      </div>
    </div>
  );
}
