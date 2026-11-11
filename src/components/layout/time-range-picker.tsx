"use client";

/**
 * 时间范围 / 粒度选择器（FE-M2-01）：URL searchParams 是唯一状态载体。
 *
 * 口径（与后端一致）：
 * - `start`/`end` 为**整数 Unix 秒**，区间左闭右开；
 * - 预设按 Asia/Shanghai 自然日计算（今日/近7天/近30天/本月，见 `lib/time-range`）；
 * - 自定义日期以东八区当日 00:00 起、次日 00:00 止；
 * - `granularity` ∈ day/week/month，缺省 day；
 * - 只写 URL、不在组件内维护查询状态，刷新/分享/快照可还原（为 BE-M3-03 服务）。
 */
import { CalendarDays } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatDateRange, toDateInputValue } from "@/lib/format";
import {
  DAY_SECONDS,
  GRANULARITIES,
  PRESETS,
  parseGranularity,
  presetRange,
  resolveRangeFromParams,
  type RangePreset,
} from "@/lib/time-range";
import { cn } from "@/lib/utils";

function dateInputToSeconds(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1000);
}

export function TimeRangePicker({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const granularity = parseGranularity(searchParams.get("granularity"));

  const [customStart, setCustomStart] = useState(() => toDateInputValue(current.start));
  const [customEnd, setCustomEnd] = useState(() => toDateInputValue(current.end - 1));

  // URL 被外部改变（浏览器前进/后退、预设点击）时同步输入框
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL（外部状态）→ 受控输入框同步
    setCustomStart(toDateInputValue(current.start));
    setCustomEnd(toDateInputValue(current.end - 1));
  }, [current.end, current.start]);

  const updateParams = (patch: Record<string, string | null>): void => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const applyPreset = (key: RangePreset): void => {
    const range = presetRange(key);
    updateParams({ start: String(range.start), end: String(range.end) });
  };

  const customStartSeconds = dateInputToSeconds(customStart);
  const customEndDay = dateInputToSeconds(customEnd);
  const customEndSeconds = customEndDay === null ? null : customEndDay + DAY_SECONDS;
  const customInvalid =
    customStartSeconds === null ||
    customEndSeconds === null ||
    customStartSeconds >= customEndSeconds;

  const applyCustom = (): void => {
    if (customInvalid) return;
    updateParams({ start: String(customStartSeconds), end: String(customEndSeconds) });
  };

  const activePreset = PRESETS.find((preset) => {
    const range = presetRange(preset.key);
    return range.start === current.start && range.end === current.end;
  })?.key;

  const inputClass =
    "h-8 rounded-md border border-input bg-background px-2 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-2",
        className,
      )}
    >
      <div className="flex items-center gap-1" role="group" aria-label="时间范围预设">
        {PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            size="sm"
            variant={activePreset === preset.key ? "secondary" : "ghost"}
            aria-pressed={activePreset === preset.key}
            onClick={() => applyPreset(preset.key)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 text-sm">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
        <input
          type="date"
          value={customStart}
          onChange={(event) => setCustomStart(event.target.value)}
          className={inputClass}
          aria-label="开始日期"
        />
        <span className="text-muted-foreground">至</span>
        <input
          type="date"
          value={customEnd}
          onChange={(event) => setCustomEnd(event.target.value)}
          className={inputClass}
          aria-label="结束日期"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={applyCustom}
          disabled={customInvalid}
        >
          应用
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateRange(current.start, current.end)}
        </span>
        <div
          role="group"
          aria-label="时间粒度"
          className="flex items-center rounded-md border p-0.5"
        >
          {GRANULARITIES.map((item) => (
            <Button
              key={item.key}
              type="button"
              size="sm"
              variant={granularity === item.key ? "secondary" : "ghost"}
              aria-pressed={granularity === item.key}
              className="h-7 px-2"
              onClick={() => updateParams({ granularity: item.key })}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
