/**
 * Next.js instrumentation 入口（BE-M0-04）：服务端启动时初始化缓存监控与退出兜底。
 *
 * - 仅在 nodejs runtime 执行（edge 不加载 lru-cache）；
 * - `startCacheMetrics()`：每 5 分钟输出缓存占用（方案 §6.3(4)）；
 * - `registerCacheShutdown()`：SIGTERM/SIGINT 时清空缓存（方案 §6.3(5)）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerCacheShutdown, startCacheMetrics } = await import("./server/cache");
  startCacheMetrics();
  registerCacheShutdown();
}
