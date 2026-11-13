"use client";

/**
 * 会话列表的日期下拉（对齐 new-api 的日历选择器，替代原生 input[type=date]）。
 *
 * 为什么自己写而不引第三方：项目已有 Radix 的 dropdown/select，但菜单项会接管键盘焦点，
 * 塞一个月历进去不好控；原生 date 输入又完全不可定制。这里只依赖一个容器 ref +
 * 外部点击/Esc 关闭，零新依赖、键盘可达。
 *
 * 口径：全部用 `YYYY-MM-DD` 字符串比较，不碰 Date 的本地时区；可选范围由 `min`/`max`
 * 限定为当前查询区间（审计索引本来也只有这些天有数据），越界日期直接禁用。
 */
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

interface Cell {
  date: string;
  day: number;
  inMonth: boolean;
}

function parse(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 用 UTC 构造做「某月 1 号是周几 / 该月几天」的纯算术，避开本地时区。 */
export function buildMonth(year: number, month: number): Cell[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysInPrevMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const cells: Cell[] = [];

  for (let index = 0; index < firstWeekday; index += 1) {
    const day = daysInPrevMonth - firstWeekday + index + 1;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    cells.push({ date: toDate(prevYear, prevMonth, day), day, inMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: toDate(year, month, day), day, inMonth: true });
  }
  // 补齐到整周（5 或 6 行），面板高度稳定
  while (cells.length % 7 !== 0 || cells.length < 35) {
    const day = cells.length - firstWeekday - daysInMonth + 1;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    cells.push({ date: toDate(nextYear, nextMonth, day), day, inMonth: false });
  }
  return cells;
}

const SELECT_CLASS =
  "h-7 rounded-md border border-input bg-background px-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function AuditDatePicker({
  value,
  onChange,
  min,
  max,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  /** 可选范围（含端点），YYYY-MM-DD */
  min: string;
  max: string;
}) {
  const [open, setOpen] = useState(false);
  const initial = parse(value ?? max);
  const [cursor, setCursor] = useState({ year: initial.year, month: initial.month });
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const cells = useMemo(() => buildMonth(cursor.year, cursor.month), [cursor]);
  const minParts = parse(min);
  const maxParts = parse(max);
  const minMonthIndex = minParts.year * 12 + minParts.month;
  const maxMonthIndex = maxParts.year * 12 + maxParts.month;
  const cursorMonthIndex = cursor.year * 12 + cursor.month;

  // 年份下拉覆盖可选区间，外加当前正在浏览的年份（前面板可能翻到区间外）
  const years = useMemo(() => {
    const set = new Set<number>([cursor.year]);
    for (let year = minParts.year; year <= maxParts.year; year += 1) set.add(year);
    return [...set].sort((a, b) => a - b);
  }, [cursor.year, minParts.year, maxParts.year]);

  const shiftMonth = (delta: number): void => {
    setCursor((current) => {
      const index = current.year * 12 + current.month - 1 + delta;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  };

  return (
    <div ref={rootRef} className="relative ml-1 flex items-center">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="按日期过滤"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="按日期过滤（只查看所选自然日）"
        className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs tabular-nums shadow-xs outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
      >
        <span className={value === null ? "text-muted-foreground" : ""}>
          {value ?? "全部日期"}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>

      {open ? (
        <div
          data-slot="audit-date-picker"
          role="dialog"
          aria-label="选择日期"
          className="absolute top-full right-0 z-50 mt-1 w-[264px] rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="mb-2 flex items-center justify-between gap-1">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
              onClick={() => shiftMonth(-1)}
              disabled={cursorMonthIndex <= minMonthIndex}
              aria-label="上一个月"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="flex items-center gap-1">
              <select
                value={cursor.month}
                onChange={(event) => setCursor((c) => ({ ...c, month: Number(event.target.value) }))}
                className={SELECT_CLASS}
                aria-label="月份"
              >
                {MONTHS.map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={cursor.year}
                onChange={(event) => setCursor((c) => ({ ...c, year: Number(event.target.value) }))}
                className={SELECT_CLASS}
                aria-label="年份"
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
              onClick={() => shiftMonth(1)}
              disabled={cursorMonthIndex >= maxMonthIndex}
              aria-label="下一个月"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-muted-foreground">
            {WEEKDAYS.map((label) => (
              <div key={label} className="py-1">
                {label}
              </div>
            ))}
            {cells.map((cell) => {
              const disabled = cell.date < min || cell.date > max;
              const selected = cell.date === value;
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  aria-label={cell.date}
                  onClick={() => {
                    onChange(cell.date);
                    setOpen(false);
                  }}
                  className={cn(
                    "mx-auto flex size-8 items-center justify-center rounded-full text-xs tabular-nums transition-colors",
                    "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                    !cell.inMonth && "text-muted-foreground/60",
                    selected && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                    disabled && "pointer-events-none opacity-25",
                  )}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t pt-2 text-xs">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              全部日期
            </button>
            <span className="text-[11px] text-muted-foreground">
              {min} ~ {max}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
