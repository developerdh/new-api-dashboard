"use client";

/** 控制台顶栏：面包屑 + 数据源状态 + 主题切换 + 退出登录（高度对齐新版 new-api 的 3rem）。 */
import { ChevronRight, LogOut, Menu } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";

export interface AppHeaderProps {
  title: string;
  onMenuClick: () => void;
}

export function AppHeader({ title, onMenuClick }: AppHeaderProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } finally {
      // Cookie 已清除，替换到公开登录页并刷新路由树
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <header className="sticky top-0 z-30 h-[var(--app-header-height)] border-b border-border bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-full w-full items-center gap-2 px-4 sm:px-6 lg:px-8">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 lg:hidden"
          onClick={onMenuClick}
          aria-label="打开导航菜单"
        >
          <Menu className="size-4" />
        </Button>

        <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="hidden text-muted-foreground sm:inline">控制台</span>
          <ChevronRight className="hidden size-3.5 text-muted-foreground sm:inline" aria-hidden="true" />
          <span className="truncate font-medium">{title}</span>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={signOut}
            disabled={signingOut}
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
