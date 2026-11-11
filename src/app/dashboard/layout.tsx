import { Suspense } from "react";

import { TimeRangePicker } from "@/components/layout/time-range-picker";

/**
 * 看板布局（FE-M2-01）：统一容器宽度 + 全局时间范围/粒度筛选栏。
 * 筛选状态只存于 URL（start/end/granularity），页面与快照共用同一载体。
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <Suspense
        fallback={<div className="h-14 w-full animate-pulse rounded-lg border bg-muted/40" />}
      >
        <TimeRangePicker />
      </Suspense>
      {children}
    </div>
  );
}
