"use client";

/** 图表统计维度切换（消耗额度 / 请求数 / Token），卡片标题栏内使用。 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface MetricSwitchOption<T extends string> {
  key: T;
  label: string;
}

export interface MetricSwitchProps<T extends string> {
  options: ReadonlyArray<MetricSwitchOption<T>>;
  value: T;
  onChange: (key: T) => void;
  label: string;
}

export function MetricSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
}: MetricSwitchProps<T>) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <Button
          key={option.key}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
          className={cn(
            "h-7 px-2.5 text-xs",
            value === option.key
              ? "bg-background text-primary shadow-xs hover:bg-background hover:text-primary"
              : "text-muted-foreground",
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
