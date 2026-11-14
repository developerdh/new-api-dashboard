/**
 * .env.e2e 加载（存在才读，进程环境变量优先——同一条规则，供 seed.mjs 与
 * playwright.config.ts 两侧共用；config 侧为 TS 内联实现，口径与此处一致）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadE2eEnv() {
  let raw;
  try {
    raw = readFileSync(join(here, "..", "..", ".env.e2e"), "utf8");
  } catch {
    return; // .env.e2e 不存在：直接用进程环境变量
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match === null) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) process.env[key] = value.replace(/^["']|["']$/g, "");
  }
}
