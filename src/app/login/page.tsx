import type { Metadata } from "next";
import { Suspense } from "react";
import { Activity } from "lucide-react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "登录",
};

/** 独立全屏登录页：不在 (console) 路由组内，无侧栏/顶栏，不受 Basic Auth 弹窗影响。 */
export default function LoginPage() {
  return (
    <main className="auth-canvas flex min-h-dvh flex-col">
      <div className="flex h-14 w-full items-center justify-between px-4 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold tracking-tight">New API 看板</span>
        </div>
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pb-16 pt-4">
        <Suspense
          fallback={<div className="h-[420px] w-full max-w-[420px] rounded-2xl border bg-card" />}
        >
          <LoginForm />
        </Suspense>
      </div>

      <footer className="pb-6 text-center text-[11px] text-muted-foreground">
        使用量统计看板 · 只读数据源 · 数据按 Asia/Shanghai 自然日聚合
      </footer>
    </main>
  );
}
