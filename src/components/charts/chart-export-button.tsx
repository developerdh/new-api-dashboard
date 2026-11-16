"use client";

/**
 * 卡片标题栏的导出按钮（与图表实例注册表配合，不占图表区行高）。
 *
 * 两种形态：
 * - 只给 `exportName`：单图标，点击直接导出「图表 HTML」；
 * - 再给 `csvHref`：合并成一个按钮 + 下拉菜单，由用户选 HTML 还是 CSV。
 *
 * 为什么合并：两个并排的小图标在标题栏里既占宽又难分辨（肉眼分不出哪个是 HTML、
 * 哪个是数据），合并成「一个下载按钮 + 菜单」后语义自明，标题栏也少挤一格。
 */
import { ChevronDown, Download, FileCode2, FileSpreadsheet } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportChartByName } from "@/lib/chart-export";
import { cn } from "@/lib/utils";

export interface ChartExportButtonProps {
  /** 与图表组件的 exportName 一致。 */
  exportName: string;
  /** 导出 HTML 内标题；缺省用 exportName。 */
  title?: string;
  /** 触发器文案（title / aria-label）；给了 csvHref 时默认「导出」。 */
  label?: string;
  /** 数据 CSV 下载地址；给了就把按钮改成下拉菜单。 */
  csvHref?: string;
  /** CSV 菜单项文案。 */
  csvLabel?: string;
}

const SPINNER = (
  <span
    className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    aria-hidden="true"
  />
);

export function ChartExportButton({
  exportName,
  title,
  label = "导出 HTML",
  csvHref,
  csvLabel = "数据表格",
}: ChartExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  // 导出失败/图表未就绪的短暂提示：置为警示色 + title，2.5s 后复位（否则点击只闪一下静默无反应）
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (hint === null) return;
    const timer = setTimeout(() => setHint(null), 2_500);
    return () => clearTimeout(timer);
  }, [hint]);

  const exportHtml = async (): Promise<void> => {
    setExporting(true);
    setHint(null);
    try {
      const exported = await exportChartByName(exportName, { title: title ?? exportName });
      // 空数据态 / 实例已销毁时注册表里找不到图表
      if (!exported) setHint("当前无可导出的图表");
    } catch (error) {
      console.error(
        "[chart] export failed",
        error instanceof Error ? error.message : String(error),
      );
      setHint("导出失败，请重试");
    } finally {
      setExporting(false);
    }
  };

  const feedbackTitle = hint ?? label;

  if (csvHref === undefined) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn("size-7 text-muted-foreground", hint !== null && "text-destructive")}
        onClick={() => void exportHtml()}
        disabled={exporting}
        title={feedbackTitle}
        aria-label={feedbackTitle}
      >
        {exporting ? SPINNER : <Download className="size-3.5" />}
      </Button>
    );
  }

  const menuLabel = label === "导出 HTML" ? "导出" : label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 w-auto gap-0.5 px-1.5 text-muted-foreground",
            hint !== null && "text-destructive",
          )}
          disabled={exporting}
          title={hint ?? menuLabel}
          aria-label={hint ?? menuLabel}
          aria-haspopup="menu"
        >
          {exporting ? SPINNER : <Download className="size-3.5" />}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          导出当前视图
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportHtml()} disabled={exporting}>
          <FileCode2 className="size-3.5" />
          <span className="flex-1">图表 HTML</span>
          <span className="text-[10px] text-muted-foreground">自包含</span>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={csvHref} download>
            <FileSpreadsheet className="size-3.5" />
            <span className="flex-1">{csvLabel}</span>
            <span className="text-[10px] text-muted-foreground">CSV</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
