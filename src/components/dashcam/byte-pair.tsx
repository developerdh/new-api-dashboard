"use client";

/**
 * 请求/响应字节双胶囊：仅在详情抽屉的兜底场景使用（正文缺失 / 非对话协议
 * 没有 usage 时退回字节展示）。列表一律用 TokenPair。
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
