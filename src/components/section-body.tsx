"use client";

/**
 * 区块内容三态容器：错误态（可重试）/ 加载骨架 / 正常 children。
 *
 * 由 overview / models / user 三页的同构实现抽取而来，避免错误态样式与文案逐页漂移。
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-sm">
      <p className="text-muted-foreground">{message}</p>
      {onRetry !== undefined ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function SectionBody({
  loading,
  error,
  onRetry,
  skeletonHeight,
  children,
}: {
  loading: boolean;
  error?: { message: string };
  onRetry?: () => void;
  skeletonHeight: number;
  children: ReactNode;
}) {
  if (error !== undefined) return <ErrorBox message={error.message} onRetry={onRetry} />;
  if (loading) {
    return (
      <div
        className="w-full rounded-lg skeleton-shimmer"
        style={{ height: skeletonHeight }}
        aria-busy="true"
      />
    );
  }
  return <>{children}</>;
}
