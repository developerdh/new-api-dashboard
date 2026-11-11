/**
 * Next.js instrumentation 入口（BE-M0-04 / BE-M4-02）：启动时初始化缓存监控、退出兜底与访问控制 fail-fast。
 *
 * - 仅在 nodejs runtime 执行（edge 不加载 lru-cache）；
 * - `startCacheMetrics()`：每 5 分钟输出缓存占用（方案 §6.3(4)）；
 * - `registerCacheShutdown()`：SIGTERM/SIGINT 时清空缓存（方案 §6.3(5)）；
 * - 生产环境缺少 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 时拒绝启动（防裸奔上线）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  assertAuthConfigured();

  const { registerCacheShutdown, startCacheMetrics } = await import("./server/cache");
  startCacheMetrics();
  registerCacheShutdown();
}

/** 生产环境访问控制凭据必须显式配置（fail-fast；开发环境允许缺失，由中间件 fail-closed 兜底）。 */
function assertAuthConfigured(): void {
  if (process.env.NODE_ENV !== "production") return;
  const user = process.env.DASHBOARD_AUTH_USER?.trim() ?? "";
  const pass = process.env.DASHBOARD_AUTH_PASS ?? "";
  if (user === "" || pass === "") {
    throw new Error(
      "生产环境必须配置 DASHBOARD_AUTH_USER / DASHBOARD_AUTH_PASS（BE-M4-02 访问控制 fail-fast）",
    );
  }
}
