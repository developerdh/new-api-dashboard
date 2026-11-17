"use client";

/**
 * 口径说明 i 图标：鼠标悬停 / 键盘聚焦时展示 tooltip。
 * 用 peer-hover + peer-focus-visible（而非 group-focus-within），避免点击后鼠标移开仍常驻。
 */
import { Info } from "lucide-react";
import { useId } from "react";

export interface InfoHintProps {
  /** 元素主体名，用于 aria-label（如卡片标题）。 */
  label: string;
  /** 口径说明文本。 */
  hint: string;
}

export function InfoHint({ label, hint }: InfoHintProps) {
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
        className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 w-max max-w-56 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 peer-hover:opacity-100 peer-focus-visible:opacity-100"
      >
        {hint}
      </span>
    </span>
  );
}
