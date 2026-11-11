/**
 * BE-M1-02 单测：§5.1 SQL 口径（编译断言）、overview 参数缺省、缓存命中、路由响应/错误格式。
 *
 * 约束：无真实数据库——SQL 层用 Kysely `compile()` 断言（不执行），业务层 mock `runOverviewQuery`。
 * 数值对数（demo 库 / 真实库）见执行报告「未执行项」，并入 LH-04。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route Handler 单测不在 Next 请求上下文内：connection() 需要 mock（动态/静态由 pnpm build 验证）
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

// 只替换执行层，SQL 构造器等保持真实，供编译断言使用
vi.mock("@/server/queries/overview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/overview")>();
  return { ...actual, runOverviewQuery: vi.fn() };
});

import { GET } from "@/app/api/overview/route";
import { clearCache } from "@/server/cache";
import type { Database } from "@/server/schema";
import {
  buildQuotaAggregateQuery,
  buildRequestCountQuery,
  runOverviewQuery,
  toOverviewSnapshot,
  type OverviewSnapshot,
} from "@/server/queries/overview";
import { QueryValidationError } from "@/server/queries/common";
import {
  OVERVIEW_SOURCE,
  getOverview,
  overviewCacheKey,
  resolveOverviewParams,
} from "@/server/services/stats.service";

/** 2026-11-11 09:00:00 +08 = 1794358800（默认区间 = 11-11 当日）。 */
const NOW = 1_794_358_800;
const TODAY_START = 1_794_326_400; // 2026-11-11 00:00 +08
const TODAY_END = 1_794_412_800; // 2026-11-12 00:00 +08
const RANGE_START = 1_794_240_000; // 2026-11-10 00:00 +08
const RANGE_END = 1_794_326_400; // 2026-11-11 00:00 +08

const SNAPSHOT: OverviewSnapshot = {
  totalQuota: 123_456,
  requestCount: 789,
  totalTokens: 1_000_000,
  promptTokens: 700_000,
  completionTokens: 300_000,
  activeUsers: 12,
  modelCount: 5,
};

let db: Kysely<Database>;

beforeAll(() => {
  // 只用于 compile()，不发起任何连接
  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: "postgres://test:pw@127.0.0.1:5432/test" }),
    }),
  });
});

afterAll(async () => {
  await db.destroy();
});

const runner = vi.mocked(runOverviewQuery);

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  // clearCache 会触发 dispose 日志：必须在恢复 console spy 之前执行
  clearCache();
  vi.restoreAllMocks();
  runner.mockReset();
});

describe("§5.1 SQL 编译口径（只读 + 参数化）", () => {
  it("quota_data 聚合：COALESCE(SUM(...))::bigint + DISTINCT 统计", () => {
    const compiled = buildQuotaAggregateQuery(db, { start: RANGE_START, end: RANGE_END }).compile();

    expect(compiled.sql).toContain('from "quota_data"');
    expect(compiled.sql).toContain("COALESCE(SUM(quota), 0)::bigint as \"total_quota\"");
    expect(compiled.sql).toContain("COALESCE(SUM(token_used), 0)::bigint as \"total_tokens\"");
    expect(compiled.sql).toContain("COALESCE(SUM(prompt_tokens), 0)::bigint as \"prompt_tokens\"");
    expect(compiled.sql).toContain(
      'COALESCE(SUM(completion_tokens), 0)::bigint as "completion_tokens"',
    );
    expect(compiled.sql).toContain('COUNT(DISTINCT user_id)::bigint as "active_users"');
    expect(compiled.sql).toContain('COUNT(DISTINCT model_name)::bigint as "model_count"');
    expect(compiled.sql).toMatch(/"created_at"\s*>=\s*\$1/);
    expect(compiled.sql).toMatch(/"created_at"\s*<\s*\$2/);
  });

  it("请求数走 logs 的 COUNT(*)，与 quota_data 聚合分离", () => {
    const compiled = buildRequestCountQuery(db, { start: RANGE_START, end: RANGE_END }).compile();

    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toContain('COUNT(*)::bigint as "request_count"');
    expect(compiled.sql).toMatch(/"created_at"\s*>=\s*\$1/);
    expect(compiled.sql).toMatch(/"created_at"\s*<\s*\$2/);
  });

  it("区间以参数下发，不拼接进 SQL（注入面为零）", () => {
    const compiled = buildQuotaAggregateQuery(db, { start: RANGE_START, end: RANGE_END }).compile();
    expect(compiled.parameters).toEqual([RANGE_START, RANGE_END]);
    expect(compiled.sql).not.toContain(String(RANGE_START));
    expect(compiled.sql).not.toContain(String(RANGE_END));
  });

  it("聚合行映射：空结果全 0（不是 null / NaN）", () => {
    expect(toOverviewSnapshot(undefined, undefined)).toEqual({
      totalQuota: 0,
      requestCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      activeUsers: 0,
      modelCount: 0,
    });
  });

  it("聚合行映射：字段一一对应，字符串数值（numeric）也能兜底成整数", () => {
    expect(
      toOverviewSnapshot(
        {
          total_quota: 123_456,
          total_tokens: 1_000_000,
          prompt_tokens: 700_000,
          completion_tokens: 300_000,
          active_users: 12,
          model_count: 5,
        },
        { request_count: 789 },
      ),
    ).toEqual(SNAPSHOT);

    expect(
      toOverviewSnapshot(
        {
          total_quota: "10" as unknown as number,
          total_tokens: "20" as unknown as number,
          prompt_tokens: "30" as unknown as number,
          completion_tokens: "40" as unknown as number,
          active_users: "50" as unknown as number,
          model_count: "60" as unknown as number,
        },
        { request_count: "70" as unknown as number },
      ),
    ).toEqual({
      totalQuota: 10,
      requestCount: 70,
      totalTokens: 20,
      promptTokens: 30,
      completionTokens: 40,
      activeUsers: 50,
      modelCount: 60,
    });
  });
});

describe("resolveOverviewParams：缺省今日（Asia/Shanghai）", () => {
  it("start/end 都缺省 → 今日 00:00 至次日 00:00", () => {
    const params = resolveOverviewParams(new URLSearchParams(""), NOW);
    expect(params).toEqual({ start: TODAY_START, end: TODAY_END, limit: 20 });
  });

  it("显式参数按公共件归一（ISO → 整数秒）", () => {
    const params = resolveOverviewParams(
      new URLSearchParams("start=2026-11-10&end=2026-11-11&granularity=day&limit=50"),
      NOW,
    );
    expect(params).toEqual({
      start: RANGE_START,
      end: RANGE_END,
      granularity: "day",
      limit: 50,
    });
  });

  it("只给 start / 只给 end → 400 缺参（不做半默认区间）", () => {
    for (const query of ["start=2026-11-10", "end=2026-11-11"]) {
      try {
        resolveOverviewParams(new URLSearchParams(query), NOW);
        throw new Error(`应当抛错：${query}`);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryValidationError);
        const issues = (error as QueryValidationError).issues;
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.some((issue) => issue.path === "start" || issue.path === "end")).toBe(true);
      }
    }
  });

  it("缺省时忽略无关参数（overview 无粒度/limit 语义）", () => {
    const params = resolveOverviewParams(new URLSearchParams("limit=5&granularity=week"), NOW);
    expect(params).toEqual({ start: TODAY_START, end: TODAY_END, limit: 20 });
  });
});

describe("overviewCacheKey：只含区间", () => {
  it("标准 key 形态", () => {
    expect(overviewCacheKey({ start: TODAY_START, end: TODAY_END, limit: 20 })).toBe(
      `overview:all:${TODAY_START}:${TODAY_END}:all:all`,
    );
  });

  it("粒度/用户/模型参数不影响总览 key（避免重复缓存）", () => {
    const base = { start: TODAY_START, end: TODAY_END, limit: 20 };
    const variants = [
      { ...base, granularity: "week" as const },
      { ...base, userId: 7 },
      { ...base, modelName: "gpt-4o" },
      { ...base, limit: 500 },
    ];
    for (const params of variants) {
      expect(overviewCacheKey(params)).toBe(overviewCacheKey(base));
    }
  });
});

describe("getOverview：60s 缓存命中语义", () => {
  it("首次未命中、第二次命中，执行层只调用一次", async () => {
    runner.mockResolvedValue(SNAPSHOT);
    const params = { start: RANGE_START, end: RANGE_END, limit: 20 };

    const first = await getOverview(params);
    const second = await getOverview(params);

    expect(first).toEqual({ data: SNAPSHOT, cached: false });
    expect(second).toEqual({ data: SNAPSHOT, cached: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({ start: RANGE_START, end: RANGE_END });
  });

  it("执行层异常不写缓存，下次重试", async () => {
    runner.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(SNAPSHOT);
    const params = { start: RANGE_START, end: RANGE_END, limit: 20 };

    await expect(getOverview(params)).rejects.toThrow("db down");
    await expect(getOverview(params)).resolves.toEqual({ data: SNAPSHOT, cached: false });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/overview：响应与错误格式", () => {
  const url = (query = ""): string => `http://localhost/api/overview${query ? `?${query}` : ""}`;

  it("缺省区间返回今日，meta 含 source/cached/granularity=null", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    runner.mockResolvedValue(SNAPSHOT);

    const response = await GET(new Request(url()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: OverviewSnapshot;
      meta: { range: { start: number; end: number }; granularity: string | null; cached: boolean; source?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(SNAPSHOT);
    expect(body.meta.range).toEqual({ start: TODAY_START, end: TODAY_END });
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.cached).toBe(false);
    expect(body.meta.source).toBe(OVERVIEW_SOURCE);
  });

  it("两次相同请求第二次 meta.cached=true，且执行层只跑一次", async () => {
    runner.mockResolvedValue(SNAPSHOT);
    const query = `start=2026-11-10&end=2026-11-11`;

    const first = (await (await GET(new Request(url(query)))).json()) as {
      meta: { cached: boolean; range: { start: number; end: number } };
      data: OverviewSnapshot;
    };
    const second = (await (await GET(new Request(url(query)))).json()) as {
      meta: { cached: boolean };
      data: OverviewSnapshot;
    };

    expect(first.meta.range).toEqual({ start: RANGE_START, end: RANGE_END });
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.data).toEqual(SNAPSHOT);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("非法参数 → 400 invalid_query（含字段 issues），不触达执行层", async () => {
    const response = await GET(new Request(url("start=abc&end=2026-11-11")));
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; issues?: Array<{ path: string }> };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.issues?.some((issue) => issue.path === "start")).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("执行层异常 → 500 query_failed，且不回显 SQL/连接串", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runner.mockRejectedValue(
      new Error('connect failed postgres://readonly:secret@db-host:5432/new_api select * from logs'),
    );

    const response = await GET(new Request(url("start=2026-11-10&end=2026-11-11")));
    expect(response.status).toBe(500);

    const text = await response.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});
