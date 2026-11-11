import type { Metadata } from "next";
import { Suspense } from "react";

import { OverviewClient } from "./overview-client";

export const metadata: Metadata = {
  title: "全局总览",
};

function PageSkeleton() {
  return (
    <main className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-32 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-36 animate-pulse rounded-xl border bg-muted/60" />
        ))}
      </section>
      <div className="h-80 animate-pulse rounded-xl border bg-muted/60" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl border bg-muted/60" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/60" />
      </div>
    </main>
  );
}

/**
 * 全局总览（FE-M2-02）：页面只做 Suspense 边界与元数据，数据与交互在 client 组件。
 * `OverviewClient` 使用 `useSearchParams`，必须由 Suspense 包裹才能静态预渲染。
 */
export default function DashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OverviewClient />
    </Suspense>
  );
}
