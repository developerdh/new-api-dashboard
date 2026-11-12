import type { Metadata } from "next";
import { Suspense } from "react";

import { UserClient } from "./user-client";

export const metadata: Metadata = {
  title: "用户详情",
};

function UserSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-40 rounded-lg bg-muted skeleton-shimmer" />
        <div className="h-4 w-1/2 rounded-lg bg-muted skeleton-shimmer" />
      </div>
      <div className="h-14 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-32 rounded-xl border bg-muted/60 skeleton-shimmer" />
        ))}
      </div>
      <div className="h-72 rounded-xl border bg-muted/60 skeleton-shimmer" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-60 rounded-xl border bg-muted/60 skeleton-shimmer" />
        <div className="h-60 rounded-xl border bg-muted/60 skeleton-shimmer" />
      </div>
    </div>
  );
}

/** 用户详情页：Suspense 外壳 + 客户端数据层；容器由 (console) 布局统一提供。 */
export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<UserSkeleton />}>
      <UserContent params={params} />
    </Suspense>
  );
}

async function UserContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserClient userId={id} />;
}
