import type { Metadata } from "next";

import "./globals.css";
import { ThemeProvider } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "New API 使用量看板",
    template: "%s · New API 使用量看板",
  },
  description: "New API 用户使用量统计看板：服务端 SQL 聚合，前端可视化与导出。",
};

/**
 * 无闪烁主题注入：在 hydration 前按 localStorage / 系统偏好设置 class 与 data-theme。
 * 必须内联且同步执行；逻辑与 `src/app/providers.tsx` 的 applyTheme 保持一致。
 * 登录页与控制台共用本根布局；控制台 Shell 只挂在 `(console)/layout.tsx`，
 * 因此 /login 不会渲染侧边栏与顶栏。
 */
const THEME_INIT_SCRIPT = `(function () {
  try {
    var stored = window.localStorage.getItem("theme");
    var choice = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    var dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var resolved = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch (error) {
    /* 隐私模式等 localStorage 不可用时保持默认亮色 */
  }
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
