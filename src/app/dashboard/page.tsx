import type { Metadata } from "next";

import { StatCard } from "@/components/cards/stat-card";

export const metadata: Metadata = {
  title: "全局总览",
};

/** 占位页：全局总览（真实指标卡/趋势/排行归 FE-M2-02）。 */
export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">全局总览</h1>
        <p className="text-sm text-muted-foreground">
          看板骨架占位页（INF-M0-01）；数据接入见 FE-M2-02 / BE-M1-02。
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard title="总请求数" value="—" hint="待接入 /api/overview" />
        <StatCard title="总 Token 数" value="—" hint="待接入 /api/overview" />
        <StatCard title="活跃用户" value="—" hint="待接入 /api/overview" />
      </section>
    </main>
  );
}