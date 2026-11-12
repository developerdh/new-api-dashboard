import type { Metadata } from "next";
import { Suspense } from "react";

import { ModelsClient } from "./models-client";

export const metadata: Metadata = {
  title: "模型分析",
};

function ModelsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-32 rounded-lg bg-muted skeleton-shimmer" />
        <div className="h-4 w-2/3 rounded-lg bg-muted skeleton-shimmer" />
      </div>
      <div className="h-14 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="h-96 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="h-80 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="h-80 rounded-xl border bg-muted/60 skeleton-shimmer" />
    </div>
  );
}

/** 模型分析页：Suspense 外壳 + client 数据层；容器由 (console) 布局统一提供。 */
export default function ModelsPage() {
  return (
    <Suspense fallback={<ModelsSkeleton />}>
      <ModelsClient />
    </Suspense>
  );
}
