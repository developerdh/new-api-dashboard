"use client";

/**
 * 时间范围选择器：只负责全局的 `start` / `end`，URL searchParams 是唯一状态载体。
 *
 * 口径（与后端一致）：
 * - `start`/`end` 为**整数 Unix 秒**，区间左闭右开；
 * - 预设按 Asia/Shanghai 自然日计算（今日/近7天/近30天/本月，见 `lib/time-range`）；
 * - 自定义日期以东八区当日 00:00 起、次日 00:00 止；
 * - 趋势分桶粒度 `granularity` 不属于全局条件，由各趋势卡标题栏的 GranularitySwitch 控制；
 * - 只写 URL、不在组件内维护查询状态，刷新/分享/快照可还原。
 */
import { CalendarDays } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatDateRange, toDateInputValue } from "@/lib/format";
import {
  DAY_SECONDS,
  PRESETS,
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

const SEGMENT = "flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5";
const SEGMENT_BUTTON = "h-7 px-2.5 text-xs";
const SEGMENT_ACTIVE =
  "bg-background text-primary shadow-xs hover:bg-background hover:text-primary";
const SEGMENT_IDLE = "text-muted-foreground";

export function TimeRangePicker({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));

  const [customStart, setCustomStart] = useState(() => toDateInputValue(current.start));
  const [customEnd, setCustomEnd] = useState(() => toDateInputValue(current.end - 1));

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
    "h-8 rounded-md border border-input bg-background px-2 text-xs tabular-nums outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30";

  return (
    <div
      className={cn(
        "sticky top-[var(--app-header-height)] z-20 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 p-2.5 shadow-xs backdrop-blur-xl",
        className,
      )}
    >
      <div className={SEGMENT} role="group" aria-label="时间范围预设">
        {PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={activePreset === preset.key}
            onClick={() => applyPreset(preset.key)}
            className={cn(
              SEGMENT_BUTTON,
              activePreset === preset.key ? SEGMENT_ACTIVE : SEGMENT_IDLE,
            )}
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
        <span className="text-xs text-muted-foreground">至</span>
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
          className="h-8 px-2.5 text-xs"
          onClick={applyCustom}
          disabled={customInvalid}
        >
          应用
        </Button>
      </div>

      <div className="ml-auto flex flex-col items-end leading-tight">
        {/* 与预设完全一致时显示「当前区间」；否则明确标注自定义，避免预设全不高亮被误读为选项丢失 */}
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {activePreset === undefined ? "自定义区间" : "当前区间"}
        </span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {formatDateRange(current.start, current.end)}
        </span>
      </div>
    </div>
  );
}
