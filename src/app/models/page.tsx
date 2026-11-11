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
        <div className="h-7 w-32 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-14 animate-pulse rounded-lg border bg-muted/60" />
      <div className="h-96 animate-pulse rounded-xl border bg-muted/60" />
      <div className="h-80 animate-pulse rounded-xl border bg-muted/60" />
      <div className="h-80 animate-pulse rounded-xl border bg-muted/60" />
    </div>
  );
}

/**
 * 模型分析页（FE-M2-04）：Suspense 外壳 + client 数据层。
 * client 使用 `useSearchParams`，必须由 Suspense 包裹以保预渲染。
 */
export default function ModelsPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <Suspense fallback={<ModelsSkeleton />}>
        <ModelsClient />
      </Suspense>
    </div>
  );
}
