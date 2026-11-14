/**
 * e2e 全局预检：按约定「缺什么就明确报告并停止」，绝不在运行时自动安装/下载。
 *
 * 检查项（顺序即排查顺序）：
 * 1. Chromium 浏览器二进制是否存在 —— 缺失时提示一次性安装命令后退出（不自动下载）；
 * 2. E2E_TOKEN 是否提供 —— 造数（seed.mjs）必需；
 * 3. 目标看板 /api/health 是否可达 —— 排除地址配错/服务未启动。
 */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

export default async function globalSetup(): Promise<void> {
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(
      `[e2e] 缺少 Chromium 浏览器（期望路径：${executable}）。\n` +
        "执行一次性安装后重试：pnpm exec playwright install chromium\n" +
        "（约定：e2e 运行时缺浏览器只报告，不自动下载。）",
    );
  }

  const token = process.env.E2E_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error(
      "[e2e] 缺少 E2E_TOKEN（造数用完整 Authorization 头值，如 Bearer sk-…）。\n" +
        "复制 tests/e2e/.env.e2e.example 为 .env.e2e 并填写，见 tests/e2e/README.md。",
    );
  }

  const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3088";
  try {
    const response = await fetch(`${base}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `[e2e] 无法连接看板 ${base}/api/health（${error instanceof Error ? error.message : String(error)}）。\n` +
        "确认 E2E_BASE_URL 指向已部署环境，或先按 README 启动。",
    );
  }
}
