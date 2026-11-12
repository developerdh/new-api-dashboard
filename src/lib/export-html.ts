/**
 * 单图导出为自包含 HTML（方案 §8.1）。
 *
 * 口径：`getOption()` 序列化 + 内联 echarts 运行时（来自 `/api/echarts/runtime`，本地产物，不用 CDN）。
 * 交互（tooltip / 图例筛选 / dataZoom）由内联运行时保留；纯 SVG 快照方案不采用。
 *
 * 注意：ECharts option 中的函数（formatter 等）无法序列化，导出后退回默认格式化；
 * option JSON 中的 `<` 统一转义为 `\u003c`，避免 `</script>` 提前闭合。
 */

export interface ChartHtmlOptions {
  /** `chart.getOption()` 的返回值（或任意 ECharts option）。 */
  option: unknown;
  /** echarts 运行时源码（由 /api/echarts/runtime 获取）。 */
  runtime: string;
  title?: string;
  theme?: "light" | "dark";
  height?: number;
}

/** JSON 序列化并转义 `<`，防止脚本上下文中的标签闭合。 */
export function serializeOption(option: unknown): string {
  return JSON.stringify(option ?? null).replaceAll("<", "\\u003c");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 文件名：`<scope>-<start>_<end>.html`（取页面 URL 的 start/end）；无参数时回落日期。
 * scope 会做安全字符收敛（仅字母数字/点/下划线/连字符）。
 */
export function chartExportFilename(
  scope: string,
  search: string,
  now: Date = new Date(),
): string {
  const safeScope =
    scope
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "chart";

  const params = new URLSearchParams(search);
  const start = params.get("start");
  const end = params.get("end");
  if (start !== null && end !== null && /^\d+$/.test(start) && /^\d+$/.test(end)) {
    return `${safeScope}-${start}_${end}.html`;
  }
  const date = now.toISOString().slice(0, 10);
  return `${safeScope}-${date}.html`;
}

/** 生成自包含 HTML（内联运行时 + option，离线可打开且保留交互）。 */
export function buildChartHtml({
  option,
  runtime,
  title = "图表",
  theme = "light",
  height = 520,
}: ChartHtmlOptions): string {
  const background = theme === "dark" ? "#0a0a0a" : "#ffffff";
  const foreground = theme === "dark" ? "#fafafa" : "#0a0a0a";
  // 运行时内不应出现 `</script`；出现时做最小转义以保持在脚本块内
  const safeRuntime = runtime.replaceAll("</script", "<\\/script");

  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: ${background}; color: ${foreground}; }
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #chart { width: 100%; height: ${height}px; }
</style>
</head>
<body>
<div id="chart" role="img" aria-label="${escapeHtml(title)}"></div>
<script>${safeRuntime}</script>
<script>
(function () {
  var chart = echarts.init(document.getElementById("chart"), null, { renderer: "canvas" });
  chart.setOption(${serializeOption(option)});
  window.addEventListener("resize", function () { chart.resize(); });
})();
</script>
</body>
</html>
`;
}
