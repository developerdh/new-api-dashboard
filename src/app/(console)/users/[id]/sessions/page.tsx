import type { Metadata } from "next";
import { Suspense } from "react";

import { SessionsClient } from "./sessions-client";

export const metadata = {
  title: "会话记录",
} satisfies Metadata;

/** 会话独立页：与用户详情里的卡片共用查询口径，但用累加加载（适合连续回看）。 */
export default function SessionsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="h-72 rounded-xl border skeleton-shimmer" aria-busy="true" />}>
      <SessionsContent params={params} />
    </Suspense>
  );
}

async function SessionsContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionsClient userId={id} />;
}
