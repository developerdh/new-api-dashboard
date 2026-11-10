import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "New API 使用量看板",
    template: "%s · New API 使用量看板",
  },
  description: "New API 用户使用量统计看板：服务端 SQL 聚合，前端可视化与导出。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}