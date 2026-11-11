"use client";

/** 主题切换（FE-M2-01）：亮色 → 暗色 → 跟随系统 循环。 */
import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type ThemeChoice } from "@/app/providers";
import { Button } from "@/components/ui/button";

const NEXT_HINT: Record<ThemeChoice, string> = {
  light: "当前亮色，点击切换为暗色",
  dark: "当前暗色，点击切换为跟随系统",
  system: "当前跟随系统，点击切换为亮色",
};

export function ThemeToggle() {
  const { theme, resolvedTheme, cycleTheme } = useTheme();
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = `主题：${NEXT_HINT[theme]}（系统偏好为${resolvedTheme === "dark" ? "暗色" : "亮色"}）`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      aria-label={label}
      title={label}
    >
      <Icon className="size-4" />
    </Button>
  );
}
