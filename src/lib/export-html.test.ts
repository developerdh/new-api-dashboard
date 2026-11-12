/** 单测：自包含 HTML 模板（option 序列化转义、主题、文件名）。 */
import { describe, expect, it } from "vitest";

import {
  buildChartHtml,
  chartExportFilename,
  escapeHtml,
  serializeOption,
} from "@/lib/export-html";

const RUNTIME = "window.echarts={init:function(){return {setOption:function(){}}}};";

describe("serializeOption", () => {
  it("转义 `<`，防止 </script> 提前闭合脚本块", () => {
    const json = serializeOption({ title: "</script><b>x" });
    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c/script");
  });

  it("null/undefined 输出 null", () => {
    expect(serializeOption(undefined)).toBe("null");
    expect(serializeOption(null)).toBe("null");
  });
});

describe("escapeHtml", () => {
  it("转义 HTML 特殊字符", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("chartExportFilename", () => {
  it("URL 带 start/end 时按 <scope>-<start>_<end>.html", () => {
    expect(
      chartExportFilename("dashboard-trend", "?start=1794240000&end=1794326400&granularity=day"),
    ).toBe("dashboard-trend-1794240000_1794326400.html");
  });

  it("无区间参数时回落日期；scope 做安全字符收敛", () => {
    const now = new Date("2026-11-11T03:00:00Z");
    expect(chartExportFilename("models/cross", "", now)).toBe("models-cross-2026-11-11.html");
    expect(chartExportFilename("///", "", now)).toBe("chart-2026-11-11.html");
  });

  it("非法 start/end（非数字）回落日期", () => {
    const now = new Date("2026-11-11T03:00:00Z");
    expect(chartExportFilename("trend", "?start=abc&end=def", now)).toBe("trend-2026-11-11.html");
  });
});

describe("buildChartHtml", () => {
  it("内联运行时与 option，保留交互入口（echarts.init / resize）", () => {
    const html = buildChartHtml({
      option: { series: [{ type: "line", data: [1, 2] }] },
      runtime: RUNTIME,
      title: "趋势 <测试>",
      theme: "dark",
      height: 300,
    });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("#0a0a0a");
    expect(html).toContain("height: 300px");
    expect(html).toContain("echarts.init(");
    expect(html).toContain("chart.resize()");
    expect(html).toContain("chart.setOption(");
    expect(html).toContain(RUNTIME);
    expect(html).toContain("&lt;测试&gt;");
    // option 以 JSON 内联，且不含可提前闭合脚本的原始标签
    expect(html).toContain('"series"');
    expect(html).not.toContain("</script><b>");
  });

  it("运行时若出现 </script 会被转义（防御性）", () => {
    const html = buildChartHtml({
      option: {},
      runtime: "var x='</script>';",
    });
    expect(html).not.toContain("</script>';");
    expect(html).toContain("<\\/script>");
  });
});
