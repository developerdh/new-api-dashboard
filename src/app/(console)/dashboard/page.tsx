import type { Metadata } from "next";
import { Suspense } from "react";

import { OverviewClient } from "./overview-client";

export const metadata: Metadata = {
  title: "全局总览",
};

function PageSkeleton() {
  return (
    <main className="flex flex-col gap-6" aria-busy="true">
      <div className="h-14 w-full rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="flex flex-col gap-2">
        <div className="h-7 w-32 rounded-lg bg-muted skeleton-shimmer" />
        <div className="h-4 w-2/3 rounded-lg bg-muted skeleton-shimmer" />
      </div>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-40 rounded-xl border bg-muted/60 skeleton-shimmer" />
        ))}
      </section>
      <div className="h-80 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 rounded-xl border bg-muted/60 skeleton-shimmer" />
        <div className="h-64 rounded-xl border bg-muted/60 skeleton-shimmer" />
      </div>
    </main>
  );
}

/** 全局总览：页面只做 Suspense 边界与元数据，数据与交互在 client 组件。 */
export default function DashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OverviewClient />
    </Suspense>
  );
}
