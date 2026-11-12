"use client";

/** ECharts 实际渲染层（02/03）：仅在客户端加载，负责 resize、主题联动、事件与实例回传。）*/
import * as echarts from "echarts";
import { useEffect, useRef } from "react";

import { applyChartTheme, readChartTheme } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

export interface EChartInnerProps {
  option: echarts.EChartsOption;
  className?: string;
  ariaLabel?: string;
  onEvents?: Record<string, (params: unknown) => void>;
  /** 实例就绪/销毁回传（导出用）。 */
  onReady?: (chart: echarts.ECharts | null) => void;
}

export default function EChartInner({
  option,
  className,
  ariaLabel,
  onEvents,
  onReady,
}: EChartInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  const eventsRef = useRef(onEvents);
  const readyRef = useRef(onReady);

  // 初始化一次：resize 监听 + 主题变化时重设 option + 事件绑定
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    readyRef.current?.(chart);
    chart.setOption(applyChartTheme(optionRef.current, readChartTheme()), { notMerge: true });

    const eventNames = Object.keys(eventsRef.current ?? {});
    for (const name of eventNames) {
      chart.on(name, (params: unknown) => {
        eventsRef.current?.[name]?.(params);
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    resizeObserver.observe(container);

    const themeObserver = new MutationObserver(() => {
      if (chart.isDisposed()) return;
      chart.setOption(applyChartTheme(optionRef.current, readChartTheme()), {
        notMerge: true,
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      readyRef.current?.(null);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // option 变化：更新 latest ref 并合并重设
  useEffect(() => {
    optionRef.current = option;
    const chart = chartRef.current;
    if (chart === null || chart.isDisposed()) return;
    chart.setOption(applyChartTheme(option, readChartTheme()), { notMerge: true });
  }, [option]);

  // 事件处理器更新（事件名在挂载时注册，回调始终取最新）
  useEffect(() => {
    eventsRef.current = onEvents;
  }, [onEvents]);

  // 实例回传回调更新
  useEffect(() => {
    readyRef.current = onReady;
  }, [onReady]);

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full", className)}
      role="img"
      aria-label={ariaLabel ?? "数据图表"}
    />
  );
}
