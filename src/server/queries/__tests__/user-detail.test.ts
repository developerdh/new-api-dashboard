/**
 * 单测：单用户 overview/trend/models 的 SQL 口径、活跃天数、占比、最近记录、路由与缓存。
 *
 * 约束：无真实库——SQL 用 `compile()` 断言（不执行），执行层 mock `user.ts` 的三个 run/load 函数。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/queries/user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/user")>();
  return {
    ...actual,
    runUserOverviewQuery: vi.fn(),
    loadUserTrendSeries: vi.fn(),
    runUserModelsQuery: vi.fn(),
  };
});

import { GET as getUserModels } from "@/app/api/users/[id]/models/route";
import { GET as getUserOverview } from "@/app/api/users/[id]/overview/route";
import { GET as getUserTrend } from "@/app/api/users/[id]/trend/route";
import { clearCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import type { Database } from "@/server/schema";
import {
  USER_DETAIL_SOURCE,
  USER_RECENT_LIMIT,
  buildUserModelsQuery,
  buildUserOverviewQuery,
  buildUserRecentQuery,
  buildUserRequestCountQuery,
  loadUserTrendSeries,
  parseUserId,
  runUserModelsQuery,
  runUserOverviewQuery,
  toUserModels,
  toUserOverviewSnapshot,
  toUserRecent,
  type UserModelAggregateRow,
  type UserOverviewSnapshot,
} from "@/server/queries/user";
import { buildTrendQuotaQuery, buildTrendRequestQuery } from "@/server/queries/trend";

const DAY = 86_400;
const T0 = 1_794_240_000; // 2026-11-10 00:00 +08
const T1 = T0 + DAY;
const USER_ID = 7;

const OVERVIEW: UserOverviewSnapshot = {
  totalQuota: 1_234,
  totalTokens: 5_678,
  promptTokens: 4_000,
  completionTokens: 1_678,
  requestCount: 9,
  activeDays: 3,
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

const overviewRunner = vi.mocked(runUserOverviewQuery);
const trendRunner = vi.mocked(loadUserTrendSeries);
const modelsRunner = vi.mocked(runUserModelsQuery);

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  overviewRunner.mockReset();
  trendRunner.mockReset();
  modelsRunner.mockReset();
});

describe("单用户 SQL 编译口径", () => {
  it("overview：区间聚合 + 东八区自然日活跃天数，user_id 参数化", () => {
    const compiled = buildUserOverviewQuery(db, USER_ID, { start: T0, end: T1 }).compile();

    expect(compiled.sql).toContain('from "quota_data"');
    expect(compiled.sql).toContain('COALESCE(SUM(quota), 0)::bigint as "total_quota"');
    expect(compiled.sql).toContain(
      'COUNT(DISTINCT (created_at + 28800) / 86400)::bigint as "active_days"',
    );
    expect(compiled.sql).toMatch(/"user_id" = \$1/);
    expect(compiled.sql).toMatch(/"created_at" >= \$2/);
    expect(compiled.sql).toMatch(/"created_at" < \$3/);
    expect(compiled.parameters).toEqual([USER_ID, T0, T1]);
  });

  it("overview 请求数：logs 消费流水（type=2）COUNT(*) + Token 拆分，限定用户 + 区间", () => {
    const compiled = buildUserRequestCountQuery(db, USER_ID, { start: T0, end: T1 }).compile();
    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toContain('COUNT(*)::bigint as "request_count"');
    expect(compiled.sql).toMatch(/"type" = \$1/);
    expect(compiled.parameters).toEqual([2, USER_ID, T0, T1]);
  });

  it("models：按 model_name 聚合，消耗降序 + model_name 兜底", () => {
    const compiled = buildUserModelsQuery(db, USER_ID, { start: T0, end: T1 }).compile();
    expect(compiled.sql).toMatch(/group by "model_name"/);
    expect(compiled.sql).toMatch(/order by COALESCE\(SUM\(quota\), 0\) desc/i);
    expect(compiled.sql).toMatch(/"model_name" asc/i);
    expect(compiled.parameters).toEqual([USER_ID, T0, T1]);
  });

  it("recent：logs 消费流水按 created_at DESC + 固定 limit（参数化）", () => {
    const compiled = buildUserRecentQuery(db, USER_ID).compile();
    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toMatch(/"type" = \$1/);
    expect(compiled.sql).toMatch(/order by "created_at" desc/i);
    expect(compiled.sql).toMatch(/limit \$3/);
    expect(compiled.parameters).toEqual([2, USER_ID, USER_RECENT_LIMIT]);
  });

  it("trend 复用：带 userId 过滤的桶 SQL（logs 为 $4 = user_id，含 type=2）", () => {
    const quota = buildTrendQuotaQuery(db, { start: T0, end: T1 }, "day", USER_ID).compile();
    const logs = buildTrendRequestQuery(db, { start: T0, end: T1 }, "day", USER_ID).compile();

    expect(quota.sql).toMatch(/"user_id" = \$3/);
    expect(logs.sql).toMatch(/"user_id" = \$4/);
    expect(quota.parameters).toEqual([T0, T1, USER_ID]);
    expect(logs.parameters).toEqual([2, T0, T1, USER_ID]);
  });
});

describe("映射与占比", () => {
  it("overview 空结果全 0（不返回 null）", () => {
    expect(toUserOverviewSnapshot(undefined, undefined)).toEqual({
      totalQuota: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
      activeDays: 0,
    });
  });

  it("overview 字段一一对应", () => {
    expect(
      toUserOverviewSnapshot(
        {
          total_quota: 1_234,
          total_tokens: 5_678,
          active_days: 3,
        },
        { request_count: 9, prompt_tokens: 4_000, completion_tokens: 1_678 },
      ),
    ).toEqual(OVERVIEW);
  });

  it("models 占比保留 4 位，分母为 0 记 0", () => {
    const rows: UserModelAggregateRow[] = [
      {
        model_name: "gpt-4o",
        total_quota: 10,
        total_tokens: 300,
        prompt_tokens: 100,
        completion_tokens: 200,
      },
      {
        model_name: "empty",
        total_quota: 0,
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      },
    ];

    const mapped = toUserModels(rows);
    expect(mapped[0]).toMatchObject({
      modelName: "gpt-4o",
      promptShare: 0.3333,
      completionShare: 0.6667,
    });
    expect(mapped[1]).toMatchObject({ promptShare: 0, completionShare: 0 });
    expect(Number.isNaN(mapped[1]?.promptShare)).toBe(false);
  });

  it("recent 映射：字段改名 + 整数化", () => {
    expect(
      toUserRecent([
        {
          created_at: T0,
          model_name: "gpt-4o",
          quota: 12,
          prompt_tokens: 30,
          completion_tokens: 40,
        },
      ]),
    ).toEqual([
      {
        createdAt: T0,
        modelName: "gpt-4o",
        quota: 12,
        promptTokens: 30,
        completionTokens: 40,
      },
    ]);
  });
});

describe("parseUserId", () => {
  it("接受十进制正整数", () => {
    expect(parseUserId("7")).toBe(7);
    expect(parseUserId("007")).toBe(7);
    expect(parseUserId(" 42 ")).toBe(42);
  });

  it("非法 id → 400 语义（issues.path=id）", () => {
    for (const raw of ["", "0", "-1", "1.5", "abc", "1e3", "1,000", "9007199254740993"]) {
      try {
        parseUserId(raw);
        throw new Error(`应当抛错：${raw}`);
      } catch (error) {
        expect(error, raw).toBeInstanceOf(QueryValidationError);
        expect((error as QueryValidationError).issues[0]?.path).toBe("id");
      }
    }
  });
});

describe("GET /api/users/[id]/overview", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (query = "start=2026-11-10&end=2026-11-11") =>
    `http://localhost/api/users/7/overview?${query}`;

  it("返回总览 + meta（granularity=null / source / no-store）", async () => {
    overviewRunner.mockResolvedValue(OVERVIEW);

    const response = await getUserOverview(new Request(url()), ctx("7"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: UserOverviewSnapshot;
      meta: { granularity: string | null; cached: boolean; source?: string; range: { start: number; end: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(OVERVIEW);
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.cached).toBe(false);
    expect(body.meta.source).toBe(USER_DETAIL_SOURCE);
    expect(body.meta.range).toEqual({ start: T0, end: T1 });
    expect(overviewRunner).toHaveBeenCalledWith(USER_ID, { start: T0, end: T1 });
  });

  it("第二次相同请求 meta.cached=true", async () => {
    overviewRunner.mockResolvedValue(OVERVIEW);
    const first = (await (await getUserOverview(new Request(url()), ctx("7"))).json()) as {
      meta: { cached: boolean };
    };
    const second = (await (await getUserOverview(new Request(url()), ctx("7"))).json()) as {
      meta: { cached: boolean };
    };
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(overviewRunner).toHaveBeenCalledTimes(1);
  });

  it("非法 id → 400（不触达查询层）；缺 start → 400", async () => {
    const badId = await getUserOverview(new Request(url()), ctx("abc"));
    expect(badId.status).toBe(400);
    expect(
      ((await badId.json()) as { error: { issues?: Array<{ path: string }> } }).error.issues?.some(
        (issue) => issue.path === "id",
      ),
    ).toBe(true);

    const missing = await getUserOverview(new Request("http://localhost/api/users/7/overview"), ctx("7"));
    expect(missing.status).toBe(400);
    expect(overviewRunner).not.toHaveBeenCalled();
  });

  it("执行层异常 → 500 query_failed，不回显 SQL/连接串", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    overviewRunner.mockRejectedValue(
      new Error("connect postgres://readonly:secret@db-host:5432/new_api select 1"),
    );

    const response = await getUserOverview(new Request(url()), ctx("7"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("GET /api/users/[id]/trend", () => {
  const ctx = () => ({ params: Promise.resolve({ id: "7" }) });
  const url = (query: string) => `http://localhost/api/users/7/trend?${query}`;

  it("缺省 granularity=day，桶数=自然日数，带 userId 调用执行层", async () => {
    trendRunner.mockResolvedValue(new Map());

    const response = await getUserTrend(new Request(url("start=2026-11-10&end=2026-11-13")), ctx());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { points: Array<{ bucketStart: number; totalQuota: number }> };
      meta: { granularity: string | null; cached: boolean };
    };
    expect(body.data.points).toHaveLength(3);
    expect(body.data.points.map((point) => point.bucketStart)).toEqual([T0, T1, T0 + 2 * DAY]);
    expect(body.data.points.every((point) => point.totalQuota === 0)).toBe(true);
    expect(body.meta.granularity).toBe("day");
    expect(trendRunner).toHaveBeenCalledWith({ start: T0, end: T0 + 3 * DAY }, "day", USER_ID);
  });

  it("显式 granularity=week 生效，第二次命中缓存", async () => {
    trendRunner.mockResolvedValue(new Map());
    const query = "start=2026-11-09&end=2026-11-24&granularity=week";

    const first = (await (await getUserTrend(new Request(url(query)), ctx())).json()) as {
      data: { points: Array<{ bucketStart: number }> };
      meta: { granularity: string | null; cached: boolean };
    };
    const second = (await (await getUserTrend(new Request(url(query)), ctx())).json()) as {
      meta: { cached: boolean };
    };

    expect(first.data.points).toHaveLength(3);
    expect(first.meta.granularity).toBe("week");
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(trendRunner).toHaveBeenCalledTimes(1);
  });

  it("桶数超限 → 400（不触达执行层）；非法 granularity → 400", async () => {
    const end = T0 + 1_001 * DAY;
    const tooMany = await getUserTrend(
      new Request(url(`start=2026-11-10&end=${end}&granularity=day`)),
      ctx(),
    );
    expect(tooMany.status).toBe(400);
    expect(
      ((await tooMany.json()) as { error: { issues?: Array<{ path: string }> } }).error.issues?.some(
        (issue) => issue.path === "range",
      ),
    ).toBe(true);

    const badGranularity = await getUserTrend(
      new Request(url("start=2026-11-10&end=2026-11-11&granularity=hour")),
      ctx(),
    );
    expect(badGranularity.status).toBe(400);
    expect(trendRunner).not.toHaveBeenCalled();
  });
});

describe("GET /api/users/[id]/models", () => {
  const ctx = () => ({ params: Promise.resolve({ id: "7" }) });
  const url = "http://localhost/api/users/7/models?start=2026-11-10&end=2026-11-11";

  it("返回 models + recent，meta.granularity=null；第二次命中缓存", async () => {
    modelsRunner.mockResolvedValue({
      models: [
        {
          modelName: "gpt-4o",
          totalQuota: 10,
          totalTokens: 300,
          promptTokens: 100,
          completionTokens: 200,
          promptShare: 0.3333,
          completionShare: 0.6667,
        },
      ],
      recent: [
        {
          createdAt: T0,
          modelName: "gpt-4o",
          quota: 12,
          promptTokens: 30,
          completionTokens: 40,
        },
      ],
    });

    const response = await getUserModels(new Request(url), ctx());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { models: unknown[]; recent: unknown[] };
      meta: { granularity: string | null; cached: boolean; source?: string };
    };
    expect(body.data.models).toHaveLength(1);
    expect(body.data.recent).toHaveLength(1);
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.source).toBe(USER_DETAIL_SOURCE);

    const second = (await (await getUserModels(new Request(url), ctx())).json()) as {
      meta: { cached: boolean };
    };
    expect(second.meta.cached).toBe(true);
    expect(modelsRunner).toHaveBeenCalledTimes(1);
  });

  it("用户无数据 → models/recent 空数组仍 200", async () => {
    modelsRunner.mockResolvedValue({ models: [], recent: [] });
    const response = await getUserModels(new Request(url), ctx());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { models: unknown[]; recent: unknown[] } };
    expect(body.data).toEqual({ models: [], recent: [] });
  });

  it("非法 id → 400（不触达执行层）", async () => {
    const response = await getUserModels(new Request(url), { params: Promise.resolve({ id: "0" }) });
    expect(response.status).toBe(400);
    expect(modelsRunner).not.toHaveBeenCalled();
  });
});
