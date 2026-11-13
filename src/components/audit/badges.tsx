"use client";

/** 审计区块共用的状态与标记徽标（列表与抽屉保持同一套语义色）。 */
import type { ReactNode } from "react";

export function StatusBadge({ status }: { status: number }) {
  const cls = status >= 400 ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success";
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${cls}`}>
      {status}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "warning";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-muted text-muted-foreground",
    info: "bg-info/15 text-info",
    warning: "bg-warning/20 text-warning",
  };
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] ${tones[tone]}`}>
      {children}
    </span>
  );
}
