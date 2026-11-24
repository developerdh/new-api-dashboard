"use client";

/**
 * 口径说明 i 图标：鼠标悬停 / 键盘聚焦时展示 tooltip。
 * 用 peer-hover + peer-focus-visible（而非 group-focus-within），避免点击后鼠标移开仍常驻。
 */
import { Info } from "lucide-react";
import { useId } from "react";

import { cn } from "@/lib/utils";

export interface InfoHintProps {
  /** 元素主体名，用于 aria-label（如卡片标题）。 */
  label: string;
  /** 口径说明文本。 */
  hint: string;
  /**
   * tooltip 水平对齐：`right`（默认）= 右缘对齐图标、向左展开——图标靠卡片右缘时用；
   * `left` = 左缘对齐图标、向右展开——图标紧跟卡片左缘的标题时用，避免伸出卡片被裁剪。
   */
  align?: "left" | "right";
}

export function InfoHint({ label, hint, align = "right" }: InfoHintProps) {
  const hintId = useId();

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className="peer grid size-5 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-primary"
        aria-label={`${label}口径说明`}
        aria-describedby={hintId}
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
      <span
        id={hintId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-72 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 peer-hover:opacity-100 peer-focus-visible:opacity-100",
          align === "right" ? "right-0" : "left-0",
        )}
      >
        {hint}
      </span>
    </span>
  );
}
