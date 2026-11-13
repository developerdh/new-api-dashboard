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
import { useState } from "react";

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

  const exportHtml = async (): Promise<void> => {
    setExporting(true);
    try {
      await exportChartByName(exportName, { title: title ?? exportName });
    } catch (error) {
      console.error(
        "[chart] export failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setExporting(false);
    }
  };

  if (csvHref === undefined) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground"
        onClick={() => void exportHtml()}
        disabled={exporting}
        title={label}
        aria-label={label}
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
          className="size-7 w-auto gap-0.5 px-1.5 text-muted-foreground"
          disabled={exporting}
          title={menuLabel}
          aria-label={menuLabel}
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
