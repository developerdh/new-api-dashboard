"use client";

/** 卡片标题栏里的导出 HTML 小图标按钮（与图表实例注册表配合，不占图表区行高）。 */
import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { exportChartByName } from "@/lib/chart-export";

export interface ChartExportButtonProps {
  /** 与图表组件的 exportName 一致。 */
  exportName: string;
  /** 导出 HTML 内标题；缺省用 exportName。 */
  title?: string;
  label?: string;
}

export function ChartExportButton({
  exportName,
  title,
  label = "导出 HTML",
}: ChartExportButtonProps) {
  const [exporting, setExporting] = useState(false);

  const onClick = async (): Promise<void> => {
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

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-7 text-muted-foreground"
      onClick={() => void onClick()}
      disabled={exporting}
      title={label}
      aria-label={label}
    >
      {exporting ? (
        <span
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        <Download className="size-3.5" />
      )}
    </Button>
  );
}
