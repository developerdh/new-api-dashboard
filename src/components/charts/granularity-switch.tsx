"use client";

/**
 * 趋势分桶粒度切换：只影响 trend 系列接口（趋势图分桶、对比期定义），
 * 因此放在趋势卡标题栏，而不是全局时间筛选条。仍写 URL `granularity`，
 * 保证刷新 / 分享 / 快照可还原。
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { MetricSwitch } from "@/components/charts/metric-switch";
import { GRANULARITIES, parseGranularity, type Granularity } from "@/lib/time-range";

const OPTIONS = GRANULARITIES.map((item) => ({ key: item.key, label: `按${item.label}` }));

export function GranularitySwitch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = parseGranularity(searchParams.get("granularity"));

  const onChange = (key: Granularity): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("granularity", key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return <MetricSwitch options={OPTIONS} value={value} onChange={onChange} label="趋势粒度" />;
}
