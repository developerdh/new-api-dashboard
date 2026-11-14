"use client";

/**
 * 请求/响应字节数的双胶囊：颜色区分方向（蓝=请求、绿=响应）、固定宽度对齐。
 *
 * 为什么不用 `X → Y`：箭头文本在表格里宽窄不一，列会显得参差；
 * 两个定宽胶囊上下对齐，纵向扫一眼就能比较大小。
 */
import { cn } from "@/lib/utils";

const CAPSULE =
  "inline-flex h-[18px] items-center justify-center rounded-md px-1.5 text-[11px] tabular-nums whitespace-nowrap";

export function BytePair({
  request,
  response,
  className,
}: {
  request: string;
  response: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center justify-end gap-1", className)}>
      <span className={cn(CAPSULE, "w-[4.75rem] bg-info/15 text-info")} title={`请求 ${request}`}>
        {request}
      </span>
      <span
        className={cn(CAPSULE, "w-[4.75rem] bg-success/15 text-success")}
        title={`响应 ${response}`}
      >
        {response}
      </span>
    </span>
  );
}

/** 表头用：与 BytePair 同宽的两列小标题，颜色与胶囊对应。 */
export function BytePairHead({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-end gap-1", className)}>
      <span className="w-[4.75rem] text-center text-info">请求</span>
      <span className="w-[4.75rem] text-center text-success">响应</span>
    </span>
  );
}
