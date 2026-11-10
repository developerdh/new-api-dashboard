import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "用户详情",
};

/**
 * 占位页：单用户统计（真实图表归 FE-M2-03，接口归 BE-M1-05）。
 *
 * Next 16 开启 cacheComponents 后，`params` 属运行期数据：静态外壳先出，
 * 动态部分放 <Suspense> 内流式渲染，否则该路由无法预渲染（构建报错）。
 */
export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">用户详情</h1>
        <p className="text-sm text-muted-foreground">
          看板骨架占位页（INF-M0-01）；数据接入见 FE-M2-03 / BE-M1-05。
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载用户信息…</p>}>
        <UserIdLabel params={params} />
      </Suspense>
    </main>
  );
}

async function UserIdLabel({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <p className="text-sm text-muted-foreground">
      用户 ID：<span className="font-mono">{id}</span>
    </p>
  );
}