"use client";

/**
 * ECharts 封装（FE-M2-01 / FE-M3-02）：声明式 option + 客户端懒加载 + 自适应 + 单图导出。
 *
 * 导出（方案 §8.1）：按钮取 `chart.getOption()` + 本仓库 echarts 运行时（/api/echarts/runtime）
 * 生成自包含 HTML；离线打开保留 tooltip/图例/缩放交互。文件名 `<scope>-<start>_<end>.html`
 * （start/end 来自当前 URL，缺省回落日期）。
 */
import type { ECharts, EChartsOption } from "echarts";
import { Download } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { buildChartHtml, chartExportFilename } from "@/lib/export-html";
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
  /** 是否显示「导出 HTML」按钮（迷你趋势等可关闭）。 */
  exportable?: boolean;
  /** 导出文件名 scope（如 `dashboard-trend`）。 */
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
  exportable = true,
  exportName = "chart",
}: EChartProps) {
  const instanceRef = useRef<ECharts | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleReady = useCallback((chart: ECharts | null) => {
    instanceRef.current = chart;
  }, []);

  const handleExport = useCallback(async () => {
    const chart = instanceRef.current;
    if (chart === null) return;

    setExporting(true);
    try {
      const response = await fetch("/api/echarts/runtime", {
        headers: { accept: "text/javascript" },
      });
      if (!response.ok) throw new Error(`runtime HTTP ${response.status}`);
      const runtime = await response.text();

      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      const html = buildChartHtml({
        option: chart.getOption(),
        runtime,
        title: typeof title === "string" ? title : exportName,
        theme,
        height: typeof height === "number" ? height : 520,
      });

      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = chartExportFilename(exportName, window.location.search);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(
        "[chart] export failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setExporting(false);
    }
  }, [exportName, height, title]);

  const showHeader = title !== undefined || actions !== undefined || exportable;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3">
          {title !== undefined ? <div className="text-sm font-medium">{title}</div> : <span />}
          <div className="flex items-center gap-2">
            {actions}
            {exportable && !empty ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleExport()}
                disabled={exporting}
                title="导出为自包含 HTML（离线可交互）"
              >
                <Download className="size-4" />
                <span className="hidden sm:inline">{exporting ? "导出中…" : "导出 HTML"}</span>
              </Button>
            ) : null}
          </div>
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
