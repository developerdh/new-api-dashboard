/**
 * 进程内缓存基座：lru-cache 单例 + 分级 TTL + key 规范化 + 防慢泄漏。
 *
 * 口径来源：`docs/方案.md` §6.1–§6.5、§9.3。
 * 红线：不引入 Redis；容量上限 1GB；每条缓存必须带 TTL（禁止永不过期）。
 *
 * §6.3 五措施与本文件对应关系：
 * 1. 强制 TTL 生效 → `ttlAutopurge: true`、`updateAgeOnGet: false`、`getOrCache` 校验 TTL > 0；
 * 2. 严格控制 key 数量 → `cacheKey()` 确定性生成 + 参数白名单/长度校验（`CacheKeyError`）；
 * 3. 按维度分级 TTL → `CACHE_TTL_MS`（overview 60s / usersRanking 120s / userTrend 30s /
 *    modelDist 30s / realtime 10s / historyMonth 3600s）；
 * 4. 定期监控 → `startCacheMetrics()` 每 5 分钟输出 `{ entries, calculatedSize, maxSize }`，
 *    定时器 `unref()` 不阻塞进程退出；
 * 5. 慢泄漏兜底 → `registerCacheShutdown()`（SIGTERM/SIGINT 清空）+ `clearCache()`（管理端点）。
 *
 * 与方案 §6.3(5) 的 API 差异：方案示例写 `cache.purge()`，lru-cache v11 已无 `purge()`，
 * 等价语义为 `clear()`（清空全部条目并触发 dispose）；本文件按 `clear()` 实现，不改变行为口径。
 */
import { LRUCache } from "lru-cache";

/** 容量上限 1GB（方案 §6.1/§6.2）。 */
export const CACHE_MAX_SIZE_BYTES = 1024 * 1024 * 1024;

/** 统计日志周期：5 分钟（方案 §6.3(4)）。 */
export const CACHE_METRICS_INTERVAL_MS = 5 * 60 * 1000;

/** 单条 key 长度上限（防 key 无限增长的最后一道闸）。 */
export const CACHE_KEY_MAX_LENGTH = 512;

/** 分级 TTL（方案 §6.3(3)，单位毫秒）。 */
export const CACHE_TTL_MS = {
  overview: 60_000,
  usersRanking: 120_000,
  userTrend: 30_000,
  modelDist: 30_000,
  realtime: 10_000,
  historyMonth: 3_600_000,
} as const;

export type CacheScope = keyof typeof CACHE_TTL_MS;

export type CacheGranularity = "day" | "week" | "month";

export const CACHE_SCOPES = Object.keys(CACHE_TTL_MS) as readonly CacheScope[];

export const CACHE_GRANULARITIES: readonly CacheGranularity[] = ["day", "week", "month"];

/** 未指定参数时写入 key 的占位值（与方案 §6.3(2) 的 `?? 'all'` 一致）。 */
const ALL = "all";

/** 允许 2100-01-01 之前的时间戳，挡住误传毫秒/异常大值导致的 key 爆炸。 */
const MAX_EPOCH_SECONDS = 4_102_444_800;

/**
 * modelName 白名单：字母/数字/`.`/`_`/`-`/`/`/`@`（模型名常见形态如 `openai/gpt-4o`），
 * 长度 ≤128；拒绝空白、引号、冒号（key 分隔符）等。
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._@/-]{1,128}$/;

export type CacheErrorCode = "CACHE_KEY_INVALID" | "CACHE_TTL_INVALID";

/** 非法参数：快速失败，不允许把不可控字符串拼进 key。 */
export class CacheError extends Error {
  readonly code: CacheErrorCode;

  constructor(code: CacheErrorCode, message: string) {
    super(message);
    this.name = "CacheError";
    this.code = code;
  }
}

/** key 生成参数：时间戳为 Unix 秒（取整到秒），字符串参数走白名单。 */
export interface CacheKeyParams {
  granularity?: CacheGranularity;
  start: number;
  end: number;
  userId?: number;
  modelName?: string;
}

/** 便于日志排查的错误回显：截断到 32 字符并转义，避免把长输入写进日志。 */
function snippet(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const clipped = text.length > 32 ? `${text.slice(0, 32)}…` : text;
  return JSON.stringify(clipped);
}

function invalidKey(detail: string): never {
  throw new CacheError("CACHE_KEY_INVALID", detail);
}

function toEpochSeconds(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidKey(`${field} 必须是有限数值（当前 ${snippet(value)}）`);
  }
  const seconds = Math.floor(value);
  if (seconds < 0 || seconds > MAX_EPOCH_SECONDS) {
    invalidKey(`${field} 超出允许范围 0–${MAX_EPOCH_SECONDS} 秒（当前 ${snippet(value)}）`);
  }
  return seconds;
}

function assertGranularity(value: string): CacheGranularity {
  if (!CACHE_GRANULARITIES.includes(value as CacheGranularity)) {
    invalidKey(
      `granularity 必须是 ${CACHE_GRANULARITIES.join("/")}（当前 ${snippet(value)}）`,
    );
  }
  return value as CacheGranularity;
}

function assertUserId(value: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidKey(`userId 必须是正整数（当前 ${snippet(value)}）`);
  }
  return value;
}

function assertModelName(value: string): string {
  if (typeof value !== "string" || !MODEL_NAME_PATTERN.test(value)) {
    invalidKey(
      `modelName 只允许字母/数字/._-/@ 且长度 ≤128（当前 ${snippet(value)}）`,
    );
  }
  if (value === ALL) {
    invalidKey("modelName 不能是保留值 all（会与「未指定」冲突）");
  }
  return value;
}

/**
 * 确定性缓存 key（方案 §6.3(2)）：
 * `${scope}:${granularity}:${start}:${end}:${userId ?? 'all'}:${modelName ?? 'all'}`
 *
 * 时间戳向下取整到秒（同一查询不会因毫秒差异产生多个 key）；granularity 未指定渲染为 `all`。
 * 任一参数非法即抛 `CacheError('CACHE_KEY_INVALID')`，不生成 key。
 */
export function cacheKey(scope: CacheScope, params: CacheKeyParams): string {
  if (!CACHE_SCOPES.includes(scope)) {
    invalidKey(`scope 不在分级 TTL 表内（当前 ${snippet(scope)}）`);
  }
  const start = toEpochSeconds(params.start, "start");
  const end = toEpochSeconds(params.end, "end");
  if (start > end) {
    invalidKey(`start 不能大于 end（${start} > ${end}）`);
  }
  const granularity =
    params.granularity === undefined ? ALL : assertGranularity(params.granularity);
  const userId = params.userId === undefined ? ALL : String(assertUserId(params.userId));
  const modelName = params.modelName === undefined ? ALL : assertModelName(params.modelName);

  const key = `${scope}:${granularity}:${start}:${end}:${userId}:${modelName}`;
  if (key.length > CACHE_KEY_MAX_LENGTH) {
    invalidKey(`key 超长（${key.length} > ${CACHE_KEY_MAX_LENGTH}）`);
  }
  return key;
}

/** 以序列化字节数计量（方案 §6.2）；序列化失败时按 1 字节兜底，避免写入把进程打断。 */
function sizeOf(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 1;
    return Math.max(1, Buffer.byteLength(serialized, "utf8"));
  } catch {
    return 1;
  }
}

/**
 * 缓存值：只接收可序列化的聚合结果（对象/数组/标量）。
 * lru-cache v11 要求 `V extends {}`，故不接收 `null`/`undefined`（空值本就不落缓存）。
 */
export type CacheValue = object | string | number | boolean;

export type DashboardCache = LRUCache<string, CacheValue>;

export interface CreateCacheOptions {
  /** 覆盖容量上限（单测用；生产固定 1GB）。 */
  maxSize?: number;
  /** 淘汰日志开关（默认非 production 开启，方案 §6.2 的 dispose 示例）。 */
  devDisposeLogging?: boolean;
  /** 替换 TTL 时钟（单测用，保证过期判定确定性；生产不要设置）。 */
  perf?: { now(): number };
  /** TTL 判定精度（毫秒，0 = 每次检查都取时钟；单测用，生产用默认 1ms）。 */
  ttlResolution?: number;
}

/** 构造缓存实例（单测用可调小 maxSize 验证淘汰边界，不必真跑 1GB）。 */
export function createCache(options: CreateCacheOptions = {}): DashboardCache {
  const devDisposeLogging =
    options.devDisposeLogging ?? process.env.NODE_ENV !== "production";

  return new LRUCache<string, CacheValue>({
    maxSize: options.maxSize ?? CACHE_MAX_SIZE_BYTES,
    ttlAutopurge: true,
    updateAgeOnGet: false,
    sizeCalculation: sizeOf,
    ...(options.perf === undefined ? {} : { perf: options.perf }),
    ...(options.ttlResolution === undefined
      ? {}
      : { ttlResolution: options.ttlResolution }),
    dispose: (_value, key, reason) => {
      if (devDisposeLogging) {
        // 只记 key 与原因，不打印 value（可能很大且含业务数据）
        console.debug(`[cache] dispose key=${key} reason=${reason}`);
      }
    },
  });
}

/** Next dev 热重载会重复执行模块：实例挂 globalThis，保证全进程只有一份缓存。 */
const GLOBAL_CACHE_KEY = "__newApiDashboardCache__";

type GlobalWithCache = typeof globalThis & {
  [GLOBAL_CACHE_KEY]?: DashboardCache;
};

/** 取进程内唯一缓存实例（懒创建）。 */
export function getCache(): DashboardCache {
  const globalCache = globalThis as GlobalWithCache;
  globalCache[GLOBAL_CACHE_KEY] ??= createCache();
  return globalCache[GLOBAL_CACHE_KEY];
}

export interface CacheStats {
  entries: number;
  calculatedSize: number;
  maxSize: number;
}

/** 当前缓存占用（管理端点与周期日志共用）。 */
export function getCacheStats(): CacheStats {
  const cache = getCache();
  return {
    entries: cache.size,
    calculatedSize: cache.calculatedSize,
    maxSize: cache.maxSize,
  };
}

/** 清空全部缓存（管理端点 / SIGTERM 兜底调用）。 */
export function clearCache(): void {
  getCache().clear();
}

/**
 * 取缓存或执行加载函数（方案 §6.3(1)(2)(4)）：
 * - 命中直返；未命中执行 `load` 并写入（异常不写缓存，防污染）；
 * - `undefined` 视为「无关结果」不落缓存，避免把空值固化成命中；
 * - TTL 必须为正整数（禁止永不过期）。
 */
export async function getOrCache<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  if (typeof key !== "string" || key.length === 0 || key.length > CACHE_KEY_MAX_LENGTH) {
    throw new CacheError(
      "CACHE_KEY_INVALID",
      `key 必须是长度 1–${CACHE_KEY_MAX_LENGTH} 的字符串`,
    );
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new CacheError("CACHE_TTL_INVALID", "ttlMs 必须是正整数（禁止 ttl: 0 永不过期）");
  }

  const cache = getCache();
  const cached = cache.get(key);
  if (cached !== undefined) return cached as T;

  const value = await load();
  if (value !== undefined) {
    cache.set(key, value as CacheValue, { ttl: ttlMs });
  }
  return value;
}

let metricsTimer: ReturnType<typeof setInterval> | undefined;

/** 启动周期统计日志（幂等；定时器 unref，不阻塞进程退出）。 */
export function startCacheMetrics(intervalMs: number = CACHE_METRICS_INTERVAL_MS): void {
  if (metricsTimer !== undefined) return;
  metricsTimer = setInterval(() => {
    console.log("[cache]", getCacheStats());
  }, intervalMs);
  metricsTimer.unref?.();
}

/** 停止周期统计日志（测试与优雅退出用）。 */
export function stopCacheMetrics(): void {
  if (metricsTimer === undefined) return;
  clearInterval(metricsTimer);
  metricsTimer = undefined;
}

let shutdownRegistered = false;

/** 幂等注册 SIGTERM/SIGINT 兜底清空（由 `src/instrumentation.ts` 调用）。 */
export function registerCacheShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const purge = (signal: NodeJS.Signals): void => {
    try {
      const stats = getCacheStats();
      clearCache();
      stopCacheMetrics();
      console.log("[cache] purge on", signal, stats);
    } catch (error) {
      console.error("[cache] purge failed", error instanceof Error ? error.message : error);
    }
  };

  process.once("SIGTERM", () => purge("SIGTERM"));
  process.once("SIGINT", () => purge("SIGINT"));
}
