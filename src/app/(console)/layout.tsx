import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";

import { ConsoleShell } from "@/components/layout/console-shell";
import { SESSION_COOKIE_NAME, readSessionConfig, readSessionUsername } from "@/server/session";

/**
 * 受保护控制台布局：侧栏 + 顶栏 + 统一容器。登录页不在本路由组内，故不渲染 Shell。
 * 用户名取自已校验的签名会话，供侧栏底部展示；cookies() 与 usePathname 都要求 Suspense 边界。
 *
 * `connection()` 显式声明请求时渲染：会话校验要用当前时间判断过期，
 * 仅靠 `cookies()` 时 Next 会在预取/预渲染阶段报 `blocking-prerender-current-time`。
 */
async function ConsoleLayoutContent({ children }: { children: React.ReactNode }) {
  await connection();
  const cookieStore = await cookies();
  const config = readSessionConfig();
  const username =
    config === null
      ? null
      : await readSessionUsername(cookieStore.get(SESSION_COOKIE_NAME)?.value, config);

  return <ConsoleShell username={username}>{children}</ConsoleShell>;
}

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-canvas">
          <div className="h-[var(--app-header-height)] border-b border-border" />
        </div>
      }
    >
      <ConsoleLayoutContent>{children}</ConsoleLayoutContent>
    </Suspense>
  );
}
