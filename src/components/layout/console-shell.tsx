"use client";

/**
 * 控制台 Shell（新版 new-api 布局骨架）：248px 左侧导航 + 3rem 顶栏 + 自适应全宽内容容器。
 * 侧栏只保留品牌与主导航；数据源状态、主题切换、退出登录统一由顶栏承担。
 */
import { Activity, Boxes, LayoutDashboard, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { BackToTop } from "@/components/layout/back-to-top";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV_GROUPS = [
  {
    label: "分析",
    items: [
      { href: "/dashboard", label: "全局总览", icon: LayoutDashboard },
      { href: "/models", label: "模型分析", icon: Boxes },
    ],
  },
] as const;

/**
）* 当前页的全局筛选区间（`start`/`end`/`granularity` → query 串。
 * 侧栏导航据此透传区间：从总览进个人详情、从个人详情回总览都保持用户选定的区间，
 * 避免「点侧栏回到 /dashboard」把区间重置成默认近 30 天。
 */
function useRangeQuery(): string {
  const searchParams = useSearchParams();
  const params = new URLSearchParams();
  for (const key of ["start", "end", "granularity"]) {
    const value = searchParams.get(key);
    if (value !== null && value !== "") params.set(key, value);
  }
  return params.toString();
}

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/models")) return "模型分析";
  if (pathname.startsWith("/users/")) return "用户详情";
  if (pathname.startsWith("/dashboard")) return "全局总览";
  return "控制台";
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors duration-150",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
    >
      {active ? (
        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />
      ) : null}
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

function SidebarContent({
  onNavigate,
  username,
}: {
  onNavigate?: () => void;
  username: string | null;
}) {
  const pathname = usePathname();
  const rangeQuery = useRangeQuery();
  const hrefFor = (path: string): string =>
    rangeQuery === "" ? path : `${path}?${rangeQuery}`;

  return (
    <>
      <Link
        href={hrefFor("/dashboard")}
        onClick={onNavigate}
        className="flex h-[var(--app-header-height)] shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Activity className="size-4" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold tracking-tight">New API 看板</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Usage Console
          </span>
        </span>
      </Link>

      <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => (
              <NavItem
                key={item.href}
                href={hrefFor(item.href)}
                label={item.label}
                icon={item.icon}
                active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-2 animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {username ?? "未登录"} · 在线
        </div>
      </div>
    </>
  );
}

export function ConsoleShell({
  children,
  username,
}: {
  children: ReactNode;
  username: string | null;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 路由变化（外部状态）→ 收起移动端抽屉
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-dvh bg-canvas">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        跳到主内容
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <SidebarContent username={username} />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航菜单"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[272px] flex-col border-r border-sidebar-border bg-sidebar shadow-xl">
            <div className="absolute right-2 top-2 z-10">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setMobileOpen(false)}
                aria-label="关闭导航菜单"
              >
                <X className="size-4" />
              </Button>
            </div>
            <SidebarContent
              username={username}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-[248px]">
        <AppHeader title={pageTitle(pathname)} onMenuClick={() => setMobileOpen(true)} />
        <main
          id="main-content"
          className="w-full px-4 py-6 sm:px-6 lg:px-8"
        >
          {children}
        </main>
      </div>
      <BackToTop />
    </div>
  );
}
