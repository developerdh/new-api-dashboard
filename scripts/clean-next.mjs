/**
 * 构建前置清理：删除 `.next` 目录。
 *
 * 背景：`next dev` 产生的 `.next/dev` 与 `.next/cache` 可累积至数百 MB；
 * 在此状态下执行 `next build` 可能长时间无进展（实测超过 20 分钟未完成），
 * 清空后冷构建约 1 分钟。
 *
 * 约束：`pnpm dev` 运行期间执行会破坏开发服务器缓存，需先停止开发服务。
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".next");

rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log("[clean] .next removed");
