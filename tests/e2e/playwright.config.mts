/**
 * e2e 配置。目标环境全部来自环境变量（见 .env.e2e.example / README.md），不写死地址。
 * 预检（缺 Chromium / 缺凭据 / 目标不可达）在 global-setup.ts 中明确报错并停止。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

// 与 seed.mjs 同源读取 .env.e2e（存在才加载；环境变量优先，此处只补缺）
try {
  const raw = readFileSync(join(here, "..", "..", ".env.e2e"), "utf8");
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match === null) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) process.env[key] = value.replace(/^["']|["']$/g, "");
  }
} catch {
  // .env.e2e 不存在：直接用进程环境变量
}

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3088";

export default defineConfig({
  testDir: here,
  testMatch: /smoke\.spec\.mts$/,
  globalSetup: join(here, "global-setup.ts"),
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  outputDir: join(here, "test-results"),
  use: {
    baseURL: E2E_BASE_URL,
    viewport: { width: 1280, height: 720 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
