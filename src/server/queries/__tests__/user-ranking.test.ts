/**
 * 单测：§5.7 排行聚合、名称去重、请求数合并、limit 收紧、缓存与路由。
 *
 * 约束：无真实库——SQL 用 `compile()` 断言（不执行），执行层 mock `runUserRankingQuery`。
 * 数值对数待真实库校验。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/queries/user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/user")>();
  return { ...actual, runUserRankingQuery: vi.fn() };
});

import { GET } from "@/app/api/users/ranking/route";
import { clearCache, getCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import type { Database } from "@/server/schema";
import {
  RANKING_MAX_LIMIT,
  assembleUserRanking,
  buildRankingNamesQuery,
  buildRankingRequestsQuery,
  buildRankingTotalsQuery,
  runUserRankingQuery,
  type UserRankingRow,
} from "@/server/queries/user";
import {
  RANKING_SOURCE,
  getUserRanking,
  rankingCacheKey,
  resolveRankingParams,
} from "@/server/services/stats.service";

const DAY = 86_400;
const T0 = 1_794_240_000; // 2026-11-10 00:00 +08
const T1 = T0 + DAY;

const ROW_A: UserRankingRow = {
  userId: 7,
  username: "alice",
  totalQuota: 1_000,
  totalTokens: 5_000,
  requestCount: 12,
};

const ROW_B: UserRankingRow = {
  userId: 8,
  username: "bob",
  totalQuota: 500,
  totalTokens: 2_000,
  requestCount: 4,
};

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

const runner = vi.mocked(runUserRankingQuery);

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

describe("§5.7 排行 SQL 编译口径", () => {
  it("Top N 聚合：按 user_id 分组、消耗降序 + user_id 升序兜底、limit 参数化", () => {
    const compiled = buildRankingTotalsQuery(db, { start: T0, end: T1 }, 20).compile();

    expect(compiled.sql).toContain('from "quota_data"');
    expect(compiled.sql).toContain('COALESCE(SUM(quota), 0)::bigint as "total_quota"');
    expect(compiled.sql).toContain('COALESCE(SUM(token_used), 0)::bigint as "total_tokens"');
    expect(compiled.sql).toMatch(/group by "user_id"/);
    expect(compiled.sql).toMatch(/order by COALESCE\(SUM\(quota\), 0\) desc/i);
    expect(compiled.sql).toMatch(/"user_id" asc/i);
    expect(compiled.sql).toMatch(/limit \$3/);
    expect(compiled.parameters).toEqual([T0, T1, 20]);
  });

  it("名称候选查询：IN 列表参数化，按用户 + 名称消耗降序", () => {
    const compiled = buildRankingNamesQuery(db, { start: T0, end: T1 }, [7, 8]).compile();

    expect(compiled.sql).toMatch(/where .*"user_id" in \(\$3, \$4\)/);
    expect(compiled.sql).toMatch(/group by "user_id", "username"/);
    expect(compiled.sql).toMatch(/order by "user_id" asc/i);
    expect(compiled.parameters).toEqual([T0, T1, 7, 8]);
  });

  it("请求数查询：logs COUNT(*) 按 user_id 聚合，IN 参数化（不做 JOIN）", () => {
    const compiled = buildRankingRequestsQuery(db, { start: T0, end: T1 }, [7, 8]).compile();

    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toContain('COUNT(*)::bigint as "request_count"');
    expect(compiled.sql).not.toMatch(/join/i);
    expect(compiled.sql).toMatch(/group by "user_id"/);
    expect(compiled.sql).toMatch(/"type" = \$1/);
    expect(compiled.parameters).toEqual([2, T0, T1, 7, 8]);
  });
});

describe("assembleUserRanking：名称去重与请求数合并", () => {
  it("同一 user_id 多名称时取消耗最大的名称（names 已排序，取首条）", () => {
    const rows = assembleUserRanking(
      [{ user_id: 7, total_quota: 1_500, total_tokens: 9_000 }],
      [
        { user_id: 7, username: "alice_new", name_quota: 1_000 },
        { user_id: 7, username: "alice_old", name_quota: 500 },
      ],
      [{ user_id: 7, request_count: 12 }],
      20,
    );

    expect(rows).toEqual([
      {
        userId: 7,
        username: "alice_new",
        totalQuota: 1_500,
        totalTokens: 9_000,
        requestCount: 12,
      },
    ]);
  });

  it("请求数缺失记 0；按 totals 顺序输出并应用 limit", () => {
    const rows = assembleUserRanking(
      [
        { user_id: 7, total_quota: 1_000, total_tokens: 5_000 },
        { user_id: 8, total_quota: 500, total_tokens: 2_000 },
      ],
      [{ user_id: 7, username: "alice", name_quota: 1_000 }],
      [],
      1,
    );

    expect(rows).toEqual([{ ...ROW_A, requestCount: 0 }]);
  });

  it("空 totals → 空数组（不发后续查询的语义由此保证）", () => {
    expect(assembleUserRanking([], [], [], 20)).toEqual([]);
  });

  it("数值字符串（numeric 兜底）也能整数化", () => {
    const rows = assembleUserRanking(
      [{ user_id: "7" as unknown as number, total_quota: "1000" as unknown as number, total_tokens: "5000" as unknown as number }],
      [{ user_id: "7" as unknown as number, username: "alice", name_quota: "1000" as unknown as number }],
      [{ user_id: "7" as unknown as number, request_count: "12" as unknown as number }],
      20,
    );
    expect(rows).toEqual([ROW_A]);
  });
});

describe("resolveRankingParams：limit 缺省/上限", () => {
  const url = (query: string): URLSearchParams => new URLSearchParams(query);

  it("limit 缺省 20", () => {
    expect(resolveRankingParams(url("start=2026-11-10&end=2026-11-11"))).toMatchObject({
      start: T0,
      end: T1,
      limit: 20,
    });
  });

  it("limit 上限 100 允许，101 拒绝（issues.path=limit）", () => {
    expect(
      resolveRankingParams(url(`start=2026-11-10&end=2026-11-11&limit=${RANKING_MAX_LIMIT}`)),
    ).toMatchObject({ limit: RANKING_MAX_LIMIT });

    for (const limit of [RANKING_MAX_LIMIT + 1, 500]) {
      try {
        resolveRankingParams(url(`start=2026-11-10&end=2026-11-11&limit=${limit}`));
        throw new Error(`应当抛错：limit=${limit}`);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryValidationError);
        expect((error as QueryValidationError).issues[0]?.path).toBe("limit");
      }
    }
  });

  it("缺 start / 非法 granularity → 公共件报 400 语义", () => {
    expect(() => resolveRankingParams(url("end=2026-11-11"))).toThrow(QueryValidationError);
    expect(() =>
      resolveRankingParams(url("start=2026-11-10&end=2026-11-11&granularity=hour")),
    ).toThrow(QueryValidationError);
  });
});

describe("排行缓存 key 与命中语义", () => {
  it("key 含 limit，不同 limit 不共用缓存", () => {
    const base = { start: T0, end: T1, limit: 20 };
    expect(rankingCacheKey(base)).toBe(`usersRanking:all:${T0}:${T1}:all:all:limit=20`);
    expect(rankingCacheKey({ ...base, limit: 100 })).not.toBe(rankingCacheKey(base));
  });

  it("首次未命中、第二次命中，执行层只调用一次", async () => {
    runner.mockResolvedValue([ROW_A]);
    const params = { start: T0, end: T1, limit: 20 };

    const first = await getUserRanking(params);
    const second = await getUserRanking(params);

    expect(first).toEqual({ data: { rows: [ROW_A] }, cached: false });
    expect(second).toEqual({ data: { rows: [ROW_A] }, cached: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({ start: T0, end: T1 }, 20);
  });

  it("TTL 120s（§6.3(3) usersRanking）落到缓存条目", async () => {
    runner.mockResolvedValue([]);
    const params = { start: T0, end: T1, limit: 20 };
    await getUserRanking(params);

    const ttl = getCache().getRemainingTTL(rankingCacheKey(params));
    expect(ttl).toBeGreaterThan(119_000);
    expect(ttl).toBeLessThanOrEqual(121_000);
  });
});

describe("GET /api/users/ranking：响应与错误格式", () => {
  const url = (query = ""): string =>
    `http://localhost/api/users/ranking${query ? `?${query}` : ""}`;

  it("返回 rows + meta（granularity=null / source / no-store）", async () => {
    runner.mockResolvedValue([ROW_A, ROW_B]);

    const response = await GET(new Request(url("start=2026-11-10&end=2026-11-11")));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: { rows: UserRankingRow[] };
      meta: { granularity: string | null; cached: boolean; source?: string; range: { start: number; end: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.rows).toEqual([ROW_A, ROW_B]);
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.cached).toBe(false);
    expect(body.meta.source).toBe(RANKING_SOURCE);
    expect(body.meta.range).toEqual({ start: T0, end: T1 });
  });

  it("两次相同请求第二次 meta.cached=true", async () => {
    runner.mockResolvedValue([ROW_A]);
    const query = "start=2026-11-10&end=2026-11-11&limit=20";

    const first = (await (await GET(new Request(url(query)))).json()) as { meta: { cached: boolean } };
    const second = (await (await GET(new Request(url(query)))).json()) as { meta: { cached: boolean } };

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("limit 超上限 → 400（issues.path=limit），不触达执行层", async () => {
    const response = await GET(
      new Request(url(`start=2026-11-10&end=2026-11-11&limit=${RANKING_MAX_LIMIT + 1}`)),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; issues?: Array<{ path: string }> };
    };
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.issues?.some((issue) => issue.path === "limit")).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("空结果返回 rows: []（不是 null）", async () => {
    runner.mockResolvedValue([]);
    const body = (await (
      await GET(new Request(url("start=2026-11-10&end=2026-11-11")))
    ).json()) as { data: { rows: UserRankingRow[] } };
    expect(body.data.rows).toEqual([]);
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
