"use client";

/**
 * 图表实例注册表：把「导出按钮」与图表渲染解耦。
 *
 * EChart 在实例就绪/销毁时按 exportName 注册；卡片标题栏里的 ChartExportButton
 * 只按名字取实例并导出自包含 HTML。这样导出按钮可以和标题、分段控件同处一行，
 * 不必在图表区域上方再占一行。
 */
import type { ECharts } from "echarts";

import { buildChartHtml, chartExportFilename } from "@/lib/export-html";

const registry = new Map<string, ECharts>();

export function registerChart(name: string, chart: ECharts | null): void {
  if (chart === null) {
    registry.delete(name);
    return;
  }
  registry.set(name, chart);
}

export interface ChartExportOptions {
  title?: string;
  height?: number;
}

/** 生成并下载自包含 HTML；实例不存在时返回 false。 */
export async function exportChartByName(
  name: string,
  options: ChartExportOptions = {},
): Promise<boolean> {
  const chart = registry.get(name);
  if (chart === undefined || chart.isDisposed()) return false;

  const response = await fetch("/api/echarts/runtime", {
    headers: { accept: "text/javascript" },
  });
  if (!response.ok) throw new Error(`runtime HTTP ${response.status}`);
  const runtime = await response.text();

  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const html = buildChartHtml({
    option: chart.getOption(),
    runtime,
    title: options.title ?? name,
    theme,
    height: options.height ?? 520,
  });

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = chartExportFilename(name, window.location.search);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
