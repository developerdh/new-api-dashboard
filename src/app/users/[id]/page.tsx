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
        <div className="h-7 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-14 animate-pulse rounded-lg border bg-muted/60" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-xl border bg-muted/60" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl border bg-muted/60" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-60 animate-pulse rounded-xl border bg-muted/60" />
        <div className="h-60 animate-pulse rounded-xl border bg-muted/60" />
      </div>
    </div>
  );
}

/**
 * 用户详情页（FE-M2-03）：Suspense 外壳 + 客户端数据层。
 * `params` 与 `useSearchParams` 均为运行期数据，统一放在 Suspense 内以保预渲染。
 */
export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <Suspense fallback={<UserSkeleton />}>
        <UserContent params={params} />
      </Suspense>
    </div>
  );
}

async function UserContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserClient userId={id} />;
}
