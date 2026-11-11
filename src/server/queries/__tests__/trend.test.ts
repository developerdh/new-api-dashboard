/**
 * BE-M1-03 单测：桶序列、三粒度 SQL 编译、空桶补 0、compare 对齐、动态 TTL、路由响应/错误。
 *
 * 约束：无真实数据库——SQL 层用 `compile()` 断言（不执行），执行层 mock `loadTrendSeries`。
 * 数值对数挂 LH-05（真实/demo 库就绪时补）。
 *
 * 时间基准（Asia/Shanghai）：2026-11-10 00:00 = 1794240000；2026-11-09（周一）= 1794153600；
 * 2026-11-01 = 1793462400；2026-12-01 = 1796054400；2025-11-10（周一）= 1762704000。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/queries/trend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/trend")>();
  return { ...actual, loadTrendSeries: vi.fn() };
});

import { GET } from "@/app/api/trend/route";
import { clearCache, getCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import type { Database } from "@/server/schema";
import {
  MAX_TREND_BUCKETS,
  alignCompareSeries,
  bucketLabel,
  buildTrendQuotaQuery,
  buildTrendRequestQuery,
  compareBucketRange,
  loadTrendSeries,
  mergeTrendRows,
  shiftBucket,
  toTrendPoints,
  trendBuckets,
  type TrendBucketData,
  type TrendPoint,
} from "@/server/queries/trend";
import {
  TREND_SOURCE,
  getTrend,
  resolveTrendParams,
  trendBucketList,
  trendCacheKey,
  trendTtlMs,
} from "@/server/services/stats.service";

const DAY = 86_400;
const T0 = 1_794_240_000; // 2026-11-10 00:00 +08（周二）
const T1 = T0 + DAY;
const T2 = T0 + 2 * DAY;
const NOV1 = 1_793_462_400;
const NOV9 = 1_794_153_600; // 2026-11-09（周一）
const NOV16 = NOV9 + 7 * DAY;
const NOV23 = NOV9 + 14 * DAY;
const NOV24 = NOV23 + DAY;
const DEC1 = 1_796_054_400;
const JAN1_2027 = 1_798_732_800;

const emptyRow: TrendBucketData = {
  totalQuota: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  requestCount: 0,
  activeUsers: 0,
};

function point(bucketStart: number, granularity: "day" | "week" | "month" = "day"): TrendPoint {
  return {
    bucketStart,
    label: bucketLabel(bucketStart, granularity),
    ...emptyRow,
  };
}

let db: Kysely<Database>;

beforeAll(() => {
  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: "postgres://test:pw@127.0.0.1:5432/test" }),
    }),
  });
});

afterAll(async () => {
  await db.destroy();
});

const runner = vi.mocked(loadTrendSeries);

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  // clearCache 触发 dispose 日志，必须在恢复 console spy 之前
  clearCache();
  vi.restoreAllMocks();
  runner.mockReset();
});

describe("桶序列（Asia/Shanghai 边界）", () => {
  it("day：按自然日枚举，首桶对齐 start、末桶包含 end-1", () => {
    expect(trendBuckets(T0, T0 + 3 * DAY, "day")).toEqual([T0, T1, T2]);
  });

  it("day：start 落在日中间也从当日 00:00 起算；end 落在日中间仍包含该日", () => {
    const start = T0 + 12 * 3600;
    const end = T1 + 12 * 3600;
    expect(trendBuckets(start, end, "day")).toEqual([T0, T1]);
  });

  it("week：以周一为桶起点（对齐 DATE_TRUNC('week')）", () => {
    // 2026-11-10 是周二 → 首桶为 11-09（周一）
    expect(trendBuckets(T0, NOV24, "week")).toEqual([NOV9, NOV16, NOV23]);
  });

  it("month：自然月枚举，桶起点为每月 1 日", () => {
    expect(trendBuckets(NOV1, JAN1_2027, "month")).toEqual([NOV1, DEC1]);
  });

  it("空区间返回空数组", () => {
    expect(trendBuckets(T0, T0, "day")).toEqual([]);
    expect(trendBuckets(T1, T0, "day")).toEqual([]);
  });

  it("桶标签：日/周为 YYYY-MM-DD，月为 YYYY-MM", () => {
    expect(bucketLabel(T0, "day")).toBe("2026-11-10");
    expect(bucketLabel(NOV9, "week")).toBe("2026-11-09");
    expect(bucketLabel(NOV1, "month")).toBe("2026-11");
  });

  it("shiftBucket 按粒度平移", () => {
    expect(shiftBucket(T0, "day", 1)).toBe(T1);
    expect(shiftBucket(T0, "week", 1)).toBe(T0 + 7 * DAY);
    expect(bucketLabel(shiftBucket(NOV1, "month", 1), "month")).toBe("2026-12");
  });
});

describe("三粒度 SQL 编译（§5.2–§5.4）", () => {
  for (const granularity of ["day", "week", "month"] as const) {
    it(`${granularity}：DATE_TRUNC + 东八区 + 按桶分组，区间参数化`, () => {
      const quota = buildTrendQuotaQuery(db, { start: T0, end: T1 }, granularity).compile();
      const logs = buildTrendRequestQuery(db, { start: T0, end: T1 }, granularity).compile();

      for (const compiled of [quota, logs]) {
        expect(compiled.sql).toContain(`DATE_TRUNC('${granularity}'`);
        expect(compiled.sql).toContain("to_timestamp(created_at) AT TIME ZONE 'Asia/Shanghai'");
        expect(compiled.sql).toMatch(/group by/i);
        expect(compiled.sql).toMatch(/"created_at"\s*>=\s*\$1/);
        expect(compiled.sql).toMatch(/"created_at"\s*<\s*\$2/);
        expect(compiled.parameters).toEqual([T0, T1]);
        expect(compiled.sql).not.toContain(String(T0));
      }

      expect(quota.sql).toContain('from "quota_data"');
      expect(quota.sql).toContain("COALESCE(SUM(quota), 0)::bigint");
      expect(quota.sql).toContain('COUNT(DISTINCT user_id)::bigint as "active_users"');
      expect(logs.sql).toContain('from "logs"');
      expect(logs.sql).toContain('COUNT(*)::bigint as "request_count"');
    });
  }
});

describe("行合并与空桶补 0", () => {
  it("quota 与 logs 按桶合并；logs 缺失记 0", () => {
    const merged = mergeTrendRows(
      [
        {
          bucket_start: T0,
          total_quota: 100,
          total_tokens: 200,
          prompt_tokens: 120,
          completion_tokens: 80,
          active_users: 3,
        },
      ],
      [{ bucket_start: T0, request_count: 7 }],
    );
    expect(merged.get(T0)).toEqual({
      totalQuota: 100,
      totalTokens: 200,
      promptTokens: 120,
      completionTokens: 80,
      requestCount: 7,
      activeUsers: 3,
    });
  });

  it("只有 logs 的桶：quota 侧记 0（保留请求数）", () => {
    const merged = mergeTrendRows([], [{ bucket_start: T0, request_count: 5 }]);
    expect(merged.get(T0)).toEqual({ ...emptyRow, requestCount: 5 });
  });

  it("toTrendPoints：空桶补 0，顺序以桶序列为准", () => {
    const data = new Map<number, TrendBucketData>([
      [T1, { ...emptyRow, totalQuota: 42, requestCount: 3 }],
    ]);
    const points = toTrendPoints([T0, T1, T2], data, "day");

    expect(points.map((item) => item.bucketStart)).toEqual([T0, T1, T2]);
    expect(points.map((item) => item.totalQuota)).toEqual([0, 42, 0]);
    expect(points.map((item) => item.requestCount)).toEqual([0, 3, 0]);
    expect(points.map((item) => item.label)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
  });
});

describe("compare 对照区间与对齐", () => {
  const buckets = [T0, T1, T2];

  it("prev：等长前移 n 个桶（day）", () => {
    expect(compareBucketRange(buckets, "day", "prev")).toEqual({
      start: T0 - 3 * DAY,
      end: T0,
    });
  });

  it("prev：week / month 也保持相同桶数", () => {
    expect(compareBucketRange([NOV9, NOV16], "week", "prev")).toEqual({
      start: NOV9 - 14 * DAY,
      end: NOV9,
    });
    expect(compareBucketRange([NOV1, DEC1], "month", "prev")).toEqual({
      start: 1_788_192_000, // 2026-09-01 00:00 +08（前移 2 个自然月）
      end: NOV1,
    });
  });

  it("yoy：day 按日历前移 12 个月", () => {
    expect(compareBucketRange([T0, T1], "day", "yoy")).toEqual({
      start: 1_762_704_000, // 2025-11-10
      end: 1_762_876_800, // 2025-11-12
    });
  });

  it("yoy：week 前移 52 周（仍是周一）", () => {
    const range = compareBucketRange([NOV9], "week", "yoy");
    expect(range.start).toBe(1_762_704_000); // 2025-11-10（周一）
    expect(trendBuckets(range.start, range.end, "week")).toHaveLength(1);
  });

  it("yoy：month 按自然月前移 12 个月", () => {
    const range = compareBucketRange([NOV1, DEC1], "month", "yoy");
    expect(bucketLabel(range.start, "month")).toBe("2025-11");
    expect(bucketLabel(range.end, "month")).toBe("2026-01");
    expect(trendBuckets(range.start, range.end, "month")).toHaveLength(2);
  });

  it("alignCompareSeries：长度不足补 null，多余截断", () => {
    const main = [point(T0), point(T1)];
    const compare = [point(T0 - DAY), point(T1 - DAY), point(T2 - DAY)];
    const aligned = alignCompareSeries(main, compare);

    expect(aligned).toHaveLength(2);
    expect(aligned[0]?.bucketStart).toBe(T0 - DAY);
    expect(aligned[1]?.bucketStart).toBe(T1 - DAY);
    expect(alignCompareSeries(main, [point(T0 - DAY)])).toEqual([point(T0 - DAY), null]);
  });
});

describe("trend 参数解析与上限", () => {
  const url = (query: string): URLSearchParams => new URLSearchParams(query);

  it("granularity 缺省 day、compare 缺省 none", () => {
    expect(resolveTrendParams(url("start=2026-11-10&end=2026-11-13"))).toEqual({
      params: { start: T0, end: T0 + 3 * DAY, limit: 20, granularity: "day" },
      compare: "none",
    });
  });

  it("显式 granularity / compare 生效", () => {
    const resolved = resolveTrendParams(
      url("start=2026-11-09&end=2026-11-24&granularity=week&compare=prev"),
    );
    expect(resolved.params.granularity).toBe("week");
    expect(resolved.compare).toBe("prev");
  });

  it("compare 非法 → 400 语义（issues.path=compare）", () => {
    try {
      resolveTrendParams(url("start=2026-11-10&end=2026-11-11&compare=lastweek"));
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryValidationError);
      expect((error as QueryValidationError).issues[0]?.path).toBe("compare");
    }
  });

  it("granularity 非法 → QueryValidationError（公共件校验）", () => {
    expect(() =>
      resolveTrendParams(url("start=2026-11-10&end=2026-11-11&granularity=hour")),
    ).toThrow(QueryValidationError);
  });

  it("缺 start → QueryValidationError", () => {
    expect(() => resolveTrendParams(url("end=2026-11-11"))).toThrow(QueryValidationError);
  });

  it("桶数超过上限 → QueryValidationError（issues.path=range）", () => {
    const params = {
      start: T0,
      end: T0 + (MAX_TREND_BUCKETS + 1) * DAY,
      limit: 20,
      granularity: "day" as const,
    };
    try {
      trendBucketList(params);
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryValidationError);
      expect((error as QueryValidationError).issues[0]?.path).toBe("range");
    }
  });
});

describe("动态 TTL（当前桶 60s / 完整历史 1h）", () => {
  it("覆盖当前桶 → 60s；完全历史 → 3600s", () => {
    const now = T0 + 3600; // 2026-11-10 01:00
    expect(trendTtlMs(T1, "day", now)).toBe(60_000);
    expect(trendTtlMs(T0, "day", now)).toBe(3_600_000);
    expect(trendTtlMs(NOV16, "week", now)).toBe(60_000);
    expect(trendTtlMs(NOV9, "week", now)).toBe(3_600_000);
  });

  it("TTL 实际写入缓存条目（历史 1h / 当前桶 60s）", async () => {
    runner.mockResolvedValue(new Map());

    const historical = {
      params: { start: NOV1, end: DEC1, limit: 20, granularity: "month" as const },
      compare: "none" as const,
    };
    await getTrend(historical, DEC1 + DAY); // now 已在区间之后
    const historicalTtl = getCache().getRemainingTTL(trendCacheKey(historical.params, "none"));
    // 1h 档（lru-cache 的 ttlResolution 会带来 ~1ms 级抖动，给容差）
    expect(historicalTtl).toBeGreaterThan(3_590_000);
    expect(historicalTtl).toBeLessThanOrEqual(3_610_000);

    const current = {
      params: { start: T0, end: T1, limit: 20, granularity: "day" as const },
      compare: "none" as const,
    };
    await getTrend(current, T0 + 3600);
    const currentTtl = getCache().getRemainingTTL(trendCacheKey(current.params, "none"));
    // 60s 档
    expect(currentTtl).toBeGreaterThan(59_000);
    expect(currentTtl).toBeLessThanOrEqual(61_000);
  });

  it("day 粒度桶数 = 覆盖的自然日数", () => {
    for (const days of [1, 7, 30]) {
      const buckets = trendBuckets(T0, T0 + days * DAY, "day");
      expect(buckets).toHaveLength(days);
      expect(buckets[0]).toBe(T0);
      expect(buckets[buckets.length - 1]).toBe(T0 + (days - 1) * DAY);
    }
  });
});

describe("getTrend：缓存与 compare 序列", () => {
  const params = { start: T0, end: T0 + 3 * DAY, limit: 20, granularity: "day" as const };

  it("无 compare：空桶补 0，只查一次，第二次命中缓存", async () => {
    runner.mockResolvedValue(
      new Map<number, TrendBucketData>([[T1, { ...emptyRow, totalQuota: 99 }]]),
    );

    const first = await getTrend({ params, compare: "none" });
    const second = await getTrend({ params, compare: "none" });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(first.data.points.map((item) => item.totalQuota)).toEqual([0, 99, 0]);
    expect(first.data.compareSeries).toBeUndefined();
  });

  it("compare=prev：查主序列 + 对照区间，compareSeries 等长", async () => {
    runner.mockImplementation(async (range) => {
      const bucket = range.start;
      return new Map<number, TrendBucketData>([[bucket, { ...emptyRow, totalQuota: 1 }]]);
    });

    const result = await getTrend({ params, compare: "prev" });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]).toEqual(compareBucketRange([T0, T1, T2], "day", "prev"));
    expect(result.data.compareSeries).toHaveLength(3);
    expect(result.data.compareSeries?.every((item) => item !== null)).toBe(true);
  });

  it("compare=yoy 与 compare=none 使用不同缓存 key", () => {
    expect(trendCacheKey(params, "prev")).not.toBe(trendCacheKey(params, "none"));
    expect(trendCacheKey(params, "yoy")).toContain(":cmp=yoy");
    expect(trendCacheKey(params, "none")).toBe(`overview:day:${T0}:${T0 + 3 * DAY}:all:all:cmp=none`);
  });
});

describe("GET /api/trend：响应与错误格式", () => {
  const url = (query: string): string => `http://localhost/api/trend?${query}`;

  it("返回 points + meta（granularity/source/no-store）", async () => {
    runner.mockResolvedValue(new Map());

    const response = await GET(new Request(url("start=2026-11-10&end=2026-11-12&granularity=day")));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: { points: TrendPoint[]; compareSeries?: unknown };
      meta: { granularity: string | null; cached: boolean; source?: string; range: { start: number; end: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.points).toHaveLength(2);
    expect(body.data.compareSeries).toBeUndefined();
    expect(body.meta.granularity).toBe("day");
    expect(body.meta.cached).toBe(false);
    expect(body.meta.source).toBe(TREND_SOURCE);
    expect(body.meta.range).toEqual({ start: T0, end: T0 + 2 * DAY });
  });

  it("compare=prev 返回等长 compareSeries，第二次请求命中缓存", async () => {
    runner.mockResolvedValue(new Map());
    const query = "start=2026-11-10&end=2026-11-13&granularity=day&compare=prev";

    const first = (await (await GET(new Request(url(query)))).json()) as {
      data: { compareSeries: Array<TrendPoint | null> };
      meta: { cached: boolean };
    };
    const second = (await (await GET(new Request(url(query)))).json()) as {
      meta: { cached: boolean };
    };

    expect(first.data.compareSeries).toHaveLength(3);
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2); // 主 + 对照各一次，第二次请求全命中
  });

  it("compare 非法 → 400 invalid_query", async () => {
    const response = await GET(
      new Request(url("start=2026-11-10&end=2026-11-11&compare=lastweek")),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; issues?: Array<{ path: string }> };
    };
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.issues?.some((issue) => issue.path === "compare")).toBe(true);
  });

  it("桶数超限 → 400（不触达执行层）", async () => {
    const end = T0 + (MAX_TREND_BUCKETS + 1) * DAY;
    const response = await GET(
      new Request(url(`start=2026-11-10&end=${end}&granularity=day`)),
    );
    expect(response.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("执行层异常 → 500 query_failed，不回显 SQL/连接串", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runner.mockRejectedValue(
      new Error('connect postgres://readonly:secret@db-host:5432/new_api select * from logs'),
    );

    const response = await GET(new Request(url("start=2026-11-10&end=2026-11-11")));
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});
