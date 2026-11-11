/**
 * 进程内滑动窗口限流（BE-M3-01 / 方案 §9.2）。
 *
 * 用途：导出接口按 IP 限流（60s / 10 次）。计数只在本进程内有效（多实例不共享），
 * 属已知边界；异常增长的 key 由 LRUCache 的 max 上限兜底（默认 10k）。
 */
import { LRUCache } from "lru-cache";

export interface RateLimitOptions {
  /** 窗口内允许的最大次数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 最多跟踪多少个 key（防 key 膨胀）。 */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 本次放行后窗口内剩余次数（被拒时为 0）。 */
  remaining: number;
  /** 窗口恢复时间（毫秒时间戳，被拒时用于 Retry-After）。 */
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class SlidingWindowRateLimiter {
  private readonly hits: LRUCache<string, number[]>;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.hits = new LRUCache<string, number[]>({
      max: options.maxKeys ?? DEFAULT_MAX_KEYS,
    });
  }

  /** 记录一次请求并判断是否放行（`now` 可注入，便于单测推进时钟）。 */
  check(key: string, now: number = Date.now()): RateLimitResult {
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    const allowed = recent.length < this.limit;

    if (allowed) recent.push(now);
    this.hits.set(key, recent, { ttl: this.windowMs * 2 });

    const oldest = recent[0] ?? now;
    return {
      allowed,
      remaining: allowed ? Math.max(0, this.limit - recent.length) : 0,
      resetAt: oldest + this.windowMs,
    };
  }

  /** 清空计数（测试与运维重置用）。 */
  reset(): void {
    this.hits.clear();
  }
}

/** 导出接口限流：60s / 10 次（方案 §9.2）。 */
export const EXPORT_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 60_000 };

/** 导出接口限流器单例（进程内）。 */
export const exportRateLimiter = new SlidingWindowRateLimiter(EXPORT_RATE_LIMIT);

/** 工厂（单测用不同窗口/容量）。 */
export function createRateLimiter(options: RateLimitOptions): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(options);
}
