"use client";

/**
 * 会话视图的筛选条：粒度（按会话 / 按请求）、形态、仅错误、按日期。
 *
 * 状态用单对象 `SessionView` 传：两处入口（用户详情卡片、独立页面）共用同一份口径，
 * 任一条件变化都由调用方把 `page` 重置回 1 —— 否则会出现「筛到只剩 1 页却停在第 3 页」。
 */
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { AuditDatePicker } from "@/components/audit/audit-date-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SessionView {
  /** 列表粒度 */
  group: "session" | "request";
  /** 请求形态 */
  stream: "all" | "stream" | "json";
  /** 只看失败 */
  failedOnly: boolean;
  /** 只看某一天（`YYYY-MM-DD`）；null = 全部 */
  date: string | null;
}

export const DEFAULT_SESSION_VIEW: SessionView = {
  group: "session",
  stream: "all",
  failedOnly: false,
  date: null,
};

function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {options.map((item) => (
        <Button
          key={item.key}
          type="button"
          size="sm"
          variant={value === item.key ? "secondary" : "ghost"}
          aria-pressed={value === item.key}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

const GROUP_OPTIONS = [
  { key: "session", label: "按会话" },
  { key: "request", label: "按请求" },
] as const;

const STREAM_OPTIONS = [
  { key: "all", label: "全部形态" },
  { key: "stream", label: "流式" },
  { key: "json", label: "非流式" },
] as const;

export function SessionFilters({
  view,
  onChange,
  dates,
  refreshing,
  onRefresh,
  action,
}: {
  view: SessionView;
  onChange: (patch: Partial<SessionView>) => void;
  /** 可选日期（倒序，新→旧）；少于 2 天时不显示日期筛选 */
  dates: string[];
  refreshing: boolean;
  onRefresh: () => void;
  /** 右侧操作区（查看全部 / 新页面打开等） */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chips
        options={GROUP_OPTIONS}
        value={view.group}
        onChange={(group) => onChange({ group })}
        label="列表粒度"
      />
      <span className="mx-1 h-4 w-px bg-border" />
      <Chips
        options={STREAM_OPTIONS}
        value={view.stream}
        onChange={(stream) => onChange({ stream })}
        label="请求形态"
      />
      <Button
        type="button"
        size="sm"
        variant={view.failedOnly ? "secondary" : "ghost"}
        aria-pressed={view.failedOnly}
        onClick={() => onChange({ failedOnly: !view.failedOnly })}
      >
        仅错误
      </Button>

      {dates.length < 2 ? null : (
        <AuditDatePicker
          value={view.date}
          onChange={(date) => onChange({ date })}
          min={dates.at(-1) ?? dates[0]}
          max={dates[0]}
        />
      )}

      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground"
        onClick={onRefresh}
        aria-label="刷新会话列表"
        title="刷新"
      >
        <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
      </Button>
      {action}
    </div>
  );
}
