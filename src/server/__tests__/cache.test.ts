/**
 * BE-M0-04 单测：缓存基座（实例配置 / TTL / key 规范 / 淘汰 / 监控 / 守卫）。
 *
 * 约束：不依赖真库与网络；maxSize 相关用例用调小实例，不真跑 1GB。
 * TTL 用例通过注入 `perf.now` 做确定性时钟，不依赖真实 sleep。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route Handler 单测跑在 Next 请求上下文之外，`connection()` 会因缺少 request store 抛错；
// 这里替换为 no-op。「是否真的转为动态渲染」由 `pnpm build` 的路由标记（ƒ）验证。
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

import { GET as getStatsRoute } from "@/app/api/admin/cache/stats/route";
import { POST as postClearRoute } from "@/app/api/admin/cache/clear/route";
import {
  ADMIN_DISABLED_CODE,
  ADMIN_UNAUTHORIZED_CODE,
  isAdminEnabled,
  requireAdmin,
} from "@/server/admin-auth";
import {
  CACHE_GRANULARITIES,
  CACHE_KEY_MAX_LENGTH,
  CACHE_MAX_SIZE_BYTES,
  CACHE_METRICS_INTERVAL_MS,
  CACHE_SCOPES,
  CACHE_TTL_MS,
  CacheError,
  cacheKey,
  clearCache,
  createCache,
  getCache,
  getCacheStats,
  getOrCache,
  registerCacheShutdown,
  startCacheMetrics,
  stopCacheMetrics,
  type CacheScope,
} from "@/server/cache";

const ADMIN_TOKEN = "test-admin-token";

function authHeader(token: string = ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(() => {
  clearCache();
  stopCacheMetrics();
  delete process.env.ADMIN_TOKEN;
  vi.restoreAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  stopCacheMetrics();
  vi.useRealTimers();
  clearCache();
  delete process.env.ADMIN_TOKEN;
  vi.restoreAllMocks();
});

describe("实例配置：1GB 上限与分级 TTL（方案 §6.2/§6.3）", () => {
  it("容量上限固定 1GB", () => {
    expect(CACHE_MAX_SIZE_BYTES).toBe(1024 * 1024 * 1024);
    expect(getCacheStats().maxSize).toBe(CACHE_MAX_SIZE_BYTES);
  });

  it("分级 TTL 表与方案 §6.3(3) 一致", () => {
    expect(CACHE_TTL_MS.overview).toBe(60_000);
    expect(CACHE_TTL_MS.usersRanking).toBe(120_000);
    expect(CACHE_TTL_MS.userTrend).toBe(30_000);
    expect(CACHE_TTL_MS.modelDist).toBe(30_000);
    expect(CACHE_TTL_MS.realtime).toBe(10_000);
    expect(CACHE_TTL_MS.historyMonth).toBe(3_600_000);
    expect(CACHE_METRICS_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("scope 清单与 TTL 表同源，granularity 白名单为 day/week/month", () => {
    expect([...CACHE_SCOPES].sort()).toEqual(Object.keys(CACHE_TTL_MS).sort());
    expect(CACHE_GRANULARITIES).toEqual(["day", "week", "month"]);
  });

  it("实例按字节计量并保留调用方给定的 maxSize（单测可调小）", () => {
    const value = { value: "x".repeat(10) };
    const cache = createCache({ maxSize: 40, devDisposeLogging: false });
    cache.set("k", value);
    expect(cache.calculatedSize).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(cache.maxSize).toBe(40);
  });

  it("单例跨调用复用（dev 热重载不重建缓存）", () => {
    expect(getCache()).toBe(getCache());
  });

  it("dev 淘汰日志只记 key 与原因，不打印 value", () => {
    const debug = vi.mocked(console.debug);
    debug.mockClear();

    const cache = createCache({ maxSize: 64, devDisposeLogging: true });
    cache.set("quota:overview", "sensitive-payload");
    cache.delete("quota:overview");

    const logged = debug.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("key=quota:overview");
    expect(logged).toContain("reason=delete");
    expect(logged).not.toContain("sensitive-payload");
  });
});

describe("cacheKey：确定性生成与参数校验（方案 §6.3(2)）", () => {
  it("按 scope:granularity:start:end:userId:modelName 生成", () => {
    expect(
      cacheKey("overview", { granularity: "day", start: 1_760_000_000, end: 1_760_086_400 }),
    ).toBe("overview:day:1760000000:1760086400:all:all");
  });

  it("时间戳向下取整到秒（毫秒差异不产生新 key）", () => {
    const a = cacheKey("overview", { start: 1_760_000_000.1, end: 1_760_086_400.9 });
    const b = cacheKey("overview", { start: 1_760_000_000, end: 1_760_086_400 });
    expect(a).toBe(b);
    expect(a).toContain(":1760000000:1760086400:");
  });

  it("userId / modelName 参与 key，未指定时渲染为 all", () => {
    expect(
      cacheKey("userTrend", {
        granularity: "week",
        start: 1,
        end: 2,
        userId: 42,
        modelName: "openai/gpt-4o",
      }),
    ).toBe("userTrend:week:1:2:42:openai/gpt-4o");
    expect(cacheKey("modelDist", { start: 1, end: 2 })).toBe("modelDist:all:1:2:all:all");
  });

  it("modelName 允许 128 字符上限内的白名单字符", () => {
    const name = "a".repeat(128);
    expect(cacheKey("modelDist", { start: 1, end: 2, modelName: name })).toContain(name);
  });

  it("非法参数抛 CacheError('CACHE_KEY_INVALID')，不生成 key", () => {
    const cases: Array<[string, () => unknown]> = [
      ["start 非数值", () => cacheKey("overview", { start: Number.NaN, end: 2 })],
      ["start 负值", () => cacheKey("overview", { start: -1, end: 2 })],
      ["start 超范围（毫秒误传）", () => cacheKey("overview", { start: 1_760_000_000_000, end: 2 })],
      ["start > end", () => cacheKey("overview", { start: 10, end: 9 })],
      ["granularity 非法", () => cacheKey("overview", { granularity: "hour" as never, start: 1, end: 2 })],
      ["userId 非正整数", () => cacheKey("userTrend", { start: 1, end: 2, userId: 0 })],
      ["userId 小数", () => cacheKey("userTrend", { start: 1, end: 2, userId: 1.5 })],
      ["modelName 为保留值 all", () => cacheKey("modelDist", { start: 1, end: 2, modelName: "all" })],
      ["modelName 含空格", () => cacheKey("modelDist", { start: 1, end: 2, modelName: "gpt 4o" })],
      ["modelName 含冒号", () => cacheKey("modelDist", { start: 1, end: 2, modelName: "a:b" })],
      ["modelName 超长", () => cacheKey("modelDist", { start: 1, end: 2, modelName: "a".repeat(129) })],
      ["modelName 含引号", () => cacheKey("modelDist", { start: 1, end: 2, modelName: "a'b" })],
      ["scope 非法", () => cacheKey("nope" as CacheScope, { start: 1, end: 2 })],
    ];

    for (const [label, run] of cases) {
      try {
        run();
        throw new Error(`应当抛错：${label}`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(CacheError);
        expect((error as CacheError).code, label).toBe("CACHE_KEY_INVALID");
      }
    }
  });

  it("key 长度上限常量生效（直接构造超长 key 由 getOrCache 拦下）", async () => {
    await expect(
      getOrCache("k".repeat(CACHE_KEY_MAX_LENGTH + 1), 60_000, async () => 1),
    ).rejects.toMatchObject({ code: "CACHE_KEY_INVALID" });
  });
});

describe("createCache：maxSize 淘汰与超限条目不写入", () => {
  it("超出容量按 LRU 淘汰最旧条目", () => {
    const cache = createCache({ maxSize: 40, devDisposeLogging: false });
    for (const key of ["a", "b", "c"]) {
      cache.set(key, "x".repeat(10)); // 每条 12 字节
    }
    expect(cache.size).toBe(3);

    cache.set("d", "x".repeat(10));
    expect(cache.has("a")).toBe(false);
    expect([...cache.keys()].sort()).toEqual(["b", "c", "d"]);
  });

  it("单条超过 maxSize 的条目不写入（防大结果集撑爆缓存）", () => {
    const cache = createCache({ maxSize: 16, devDisposeLogging: false });
    cache.set("huge", "x".repeat(100));
    expect(cache.has("huge")).toBe(false);
    expect(cache.size).toBe(0);
  });
});

describe("TTL 与 updateAgeOnGet=false（方案 §6.3(1)）", () => {
  function createClock(startMs = 1_000): { cache: ReturnType<typeof createCache>; advance: (ms: number) => void } {
    let now = startMs;
    const cache = createCache({
      maxSize: 10_000,
      devDisposeLogging: false,
      // ttlResolution=0：每次过期判定都取注入时钟（默认 1ms 会缓存 1ms 内的 now）
      ttlResolution: 0,
      perf: { now: () => now },
    });
    return { cache, advance: (ms: number) => { now += ms; } };
  }

  it("超过 TTL 后按未命中处理并删除条目", () => {
    const { cache, advance } = createClock();
    cache.set("k", { ok: true }, { ttl: 100 });
    // 每条缓存都带 TTL（不存在 ttl: 0 的永不过期项）
    expect(cache.getRemainingTTL("k")).toBe(100);
    expect(cache.get("k")).toEqual({ ok: true });

    advance(150);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.has("k")).toBe(false);
  });

  it("读取不刷新 TTL：热点条目到点仍过期，不会永不过期", () => {
    const { cache, advance } = createClock();
    cache.set("hot", { ok: true }, { ttl: 100 });

    advance(60);
    expect(cache.get("hot")).toEqual({ ok: true }); // 读取一次，不应续期
    advance(60);
    expect(cache.get("hot")).toBeUndefined();
  });
});

describe("getOrCache：命中/异常不缓存/空值不缓存", () => {
  it("首次执行加载函数，第二次命中缓存（行为验收判据）", async () => {
    const load = vi.fn(async () => ({ total: 42 }));
    const key = cacheKey("overview", { granularity: "day", start: 1, end: 2 });

    const first = await getOrCache(key, CACHE_TTL_MS.overview, load);
    const second = await getOrCache(key, CACHE_TTL_MS.overview, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ total: 42 });
    expect(second).toBe(first); // 同一引用直出
    expect(getCacheStats().entries).toBe(1);
  });

  it("加载异常不写缓存，下次调用重新加载", async () => {
    const key = "userTrend:day:1:2:all:all";
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("db down");
      return { ok: true };
    };

    await expect(getOrCache(key, CACHE_TTL_MS.userTrend, flaky)).rejects.toThrow("db down");
    expect(getCacheStats().entries).toBe(0);

    await expect(getOrCache(key, CACHE_TTL_MS.userTrend, flaky)).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("加载结果为 undefined 时不落缓存（避免把空值固化）", async () => {
    const key = "modelDist:all:1:2:all:all";
    const load = vi.fn(async () => undefined);

    await getOrCache(key, CACHE_TTL_MS.modelDist, load);
    await getOrCache(key, CACHE_TTL_MS.modelDist, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(getCacheStats().entries).toBe(0);
  });

  it("拒绝非正 TTL（禁止 ttl: 0 永不过期）", async () => {
    for (const ttl of [0, -1, 1.5, Number.NaN]) {
      await expect(getOrCache("k", ttl, async () => 1)).rejects.toMatchObject({
        code: "CACHE_TTL_INVALID",
      });
    }
  });
});

describe("统计与清空（§6.3(4)(5)）", () => {
  it("stats 反映条目数与字节数，clear 后归零", () => {
    getCache().set("a", { value: "x".repeat(10) });
    getCache().set("b", { value: "y".repeat(10) });

    const stats = getCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.calculatedSize).toBeGreaterThan(0);

    clearCache();
    expect(getCacheStats()).toEqual({ entries: 0, calculatedSize: 0, maxSize: CACHE_MAX_SIZE_BYTES });
  });

  it("周期日志每 5 分钟输出一次且定时器幂等", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    startCacheMetrics();
    startCacheMetrics(); // 幂等：不叠加定时器
    vi.advanceTimersByTime(CACHE_METRICS_INTERVAL_MS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[cache]", expect.objectContaining({ maxSize: CACHE_MAX_SIZE_BYTES }));

    stopCacheMetrics();
    vi.advanceTimersByTime(CACHE_METRICS_INTERVAL_MS * 2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("退出兜底注册幂等（SIGTERM/SIGINT 各一次）", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");

    registerCacheShutdown();
    registerCacheShutdown();

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
  });

  it("SIGTERM 处理清空缓存（Windows 无真实信号，直接调用已注册监听器）", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    getCache().set("k", { ok: true });

    registerCacheShutdown();
    const listeners = process.listeners("SIGTERM");
    expect(listeners.length).toBeGreaterThan(0);

    const handler = listeners[listeners.length - 1] as () => void;
    handler();

    expect(getCacheStats().entries).toBe(0);
    expect(log).toHaveBeenCalledWith("[cache] purge on", "SIGTERM", expect.any(Object));
  });
});

describe("管理端点守卫（Admin Token）", () => {
  it("未配置 ADMIN_TOKEN 时端点禁用（404），isAdminEnabled=false", async () => {
    expect(isAdminEnabled({})).toBe(false);
    expect(isAdminEnabled({ ADMIN_TOKEN: "   " })).toBe(false);
    expect(isAdminEnabled({ ADMIN_TOKEN: "x" })).toBe(true);

    const stats = await getStatsRoute(new Request("http://localhost/api/admin/cache/stats"));
    const clear = await postClearRoute(
      new Request("http://localhost/api/admin/cache/clear", { method: "POST" }),
    );

    for (const response of [stats, clear]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(ADMIN_DISABLED_CODE);
    }
  });

  it("已配置但缺失/错误 token 返回 401 + WWW-Authenticate", () => {
    const env = { ADMIN_TOKEN };
    const missing = requireAdmin(new Request("http://localhost/x"), env);
    const wrong = requireAdmin(
      new Request("http://localhost/x", { headers: authHeader("wrong") }),
      env,
    );

    expect(missing).not.toBeNull();
    expect(wrong).not.toBeNull();
    for (const response of [missing, wrong]) {
      expect(response?.status).toBe(401);
      expect(response?.headers.get("www-authenticate")).toContain("Bearer");
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("正确 token 放行（scheme 大小写不敏感），错误 token 拒绝", () => {
    const env = { ADMIN_TOKEN };
    expect(requireAdmin(new Request("http://localhost/x"), env)).not.toBeNull();
    expect(requireAdmin(new Request("http://localhost/x", { headers: authHeader() }), env)).toBeNull();
    expect(
      requireAdmin(
        new Request("http://localhost/x", { headers: { authorization: `bearer   ${ADMIN_TOKEN}` } }),
        env,
      ),
    ).toBeNull();

    const unauthorized = requireAdmin(
      new Request("http://localhost/x", { headers: authHeader("nope") }),
      env,
    );
    expect(unauthorized?.status).toBe(401);
  });
});

describe("管理端点：stats / clear", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  });

  it("GET stats 返回占用与 TTL 表，且带 no-store", async () => {
    getCache().set("k", { ok: true });
    const response = await getStatsRoute(
      new Request("http://localhost/api/admin/cache/stats", { headers: authHeader() }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      ok: boolean;
      cache: { entries: number; calculatedSize: number; maxSize: number };
      metricsIntervalMs: number;
      ttlMs: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.cache.entries).toBe(1);
    expect(body.cache.maxSize).toBe(CACHE_MAX_SIZE_BYTES);
    expect(body.metricsIntervalMs).toBe(CACHE_METRICS_INTERVAL_MS);
    expect(body.ttlMs.overview).toBe(60_000);
  });

  it("POST clear 清空缓存并返回清空后的占用", async () => {
    getCache().set("k", { ok: true });
    const response = await postClearRoute(
      new Request("http://localhost/api/admin/cache/clear", {
        method: "POST",
        headers: authHeader(),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      clearedAt: string;
      cache: { entries: number; calculatedSize: number };
    };
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.clearedAt))).toBe(false);
    expect(body.cache.entries).toBe(0);
    expect(body.cache.calculatedSize).toBe(0);
  });

  it("错误 token 的 clear 不产生副作用（仍 401）", async () => {
    getCache().set("k", { ok: true });
    const response = await postClearRoute(
      new Request("http://localhost/api/admin/cache/clear", {
        method: "POST",
        headers: authHeader("wrong"),
      }),
    );

    expect(response.status).toBe(401);
    expect(getCacheStats().entries).toBe(1);
    expect((await response.json()).ok ?? false).toBe(false);
  });

  it("未携带 token 的 stats 返回 401", async () => {
    const response = await getStatsRoute(new Request("http://localhost/api/admin/cache/stats"));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ADMIN_UNAUTHORIZED_CODE,
    );
  });
});
