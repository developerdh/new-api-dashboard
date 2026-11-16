/**
 * 沉默用户单测：上期区间推导、SQL 编译口径、集合差集与名称补齐、缓存与路由。
 *
 * 约束：无真实库——SQL 用 `compile()` 断言（不执行），执行层 mock `runInactiveUsersQuery`。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/queries/inactive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/inactive")>();
  return { ...actual, runInactiveUsersQuery: vi.fn() };
});

import { GET } from "@/app/api/users/inactive/route";
import { clearCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import type { ReadOnlyDatabase } from "@/server/db";
import {
  INACTIVE_MAX_RANGE_SECONDS,
  buildCurrentActiveQuery,
  buildPrevActiveQuery,
  previousPeriod,
  runInactiveUsersQuery,
  selectInactiveCandidates,
  type InactiveUsersSnapshot,
  type PrevActiveRow,
} from "@/server/queries/inactive";

// runInactiveUsersQuery 在本文件被 mock（见上方 vi.mock）；集成用例需要真实实现
const { runInactiveUsersQuery: runInactiveUsersQueryActual } =
  await vi.importActual<typeof import("@/server/queries/inactive")>("@/server/queries/inactive");
import type { Database } from "@/server/schema";
import {
  INACTIVE_SOURCE,
  getInactiveUsers,
  inactiveCacheKey,
  resolveInactiveParams,
} from "@/server/services/inactive.service";

const DAY = 86_400;
const T0 = 1_794_240_000; // 2026-11-10 00:00 +08
const T1 = T0 + 30 * DAY;
const PREV_START = T0 - 30 * DAY;

const PREV_ROWS: PrevActiveRow[] = [
  { user_id: 7, prev_request_count: 100, last_active_at: T0 - 3_600 },
  { user_id: 8, prev_request_count: 5, last_active_at: T0 - 7_200 },
  { user_id: 9, prev_request_count: 50, last_active_at: T0 - 1_800 },
];

const SNAPSHOT: InactiveUsersSnapshot = {
  rows: [
    { userId: 7, username: "alice", lastActiveAt: T0 - 3_600, prevRequestCount: 100 },
    { userId: 9, username: "carol", lastActiveAt: T0 - 1_800, prevRequestCount: 50 },
  ],
  prevRange: { start: PREV_START, end: T0 },
  prevActiveUsers: 3,
  total: 2,
  truncated: false,
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

const runner = vi.mocked(runInactiveUsersQuery);

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  runner.mockReset();
});

describe("previousPeriod：等长紧邻上期", () => {
  it("上期 = [start - (end-start), start)，与本期等长且相邻", () => {
    expect(previousPeriod({ start: T0, end: T1 })).toEqual({
      start: PREV_START,
      end: T0,
    });
    expect(T1 - T0).toBe(T0 - PREV_START);
  });

  it("start 早于一个区间长度时钳到 0", () => {
    expect(previousPeriod({ start: 100, end: 100 + 10 * DAY })).toEqual({
      start: 0,
      end: 100,
    });
  });
});

describe("沉默用户 SQL 编译口径", () => {
  it("上期聚合：logs 消费流水、COUNT/MAX::bigint、group by user_id、参数化", () => {
    const compiled = buildPrevActiveQuery(db, { start: PREV_START, end: T0 }).compile();

    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toContain('COUNT(*)::bigint as "prev_request_count"');
    expect(compiled.sql).toContain('MAX(created_at)::bigint as "last_active_at"');
    expect(compiled.sql).toMatch(/"type" = \$1/);
    expect(compiled.sql).toMatch(/group by "user_id"/);
    expect(compiled.sql).toMatch(/"user_id" is not null/);
    expect(compiled.parameters).toEqual([2, PREV_START, T0]);
  });

  it("本期集合：SELECT DISTINCT user_id，不做聚合", () => {
    const compiled = buildCurrentActiveQuery(db, { start: T0, end: T1 }).compile();

    expect(compiled.sql).toMatch(/select distinct "user_id"/i);
    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).not.toMatch(/group by/i);
    expect(compiled.parameters).toEqual([2, T0, T1]);
  });

  // 用户名/昵称补齐查询复用 user-directory（buildUserDirectoryQuery 编译口径见
  // user-directory.test.ts），此处不重复断言
});

describe("selectInactiveCandidates：集合差集与排序", () => {
  it("排除本期活跃用户，按上期请求数降序、user_id 升序", () => {
    expect(selectInactiveCandidates(PREV_ROWS, [{ user_id: 8 }], 100)).toEqual({
      rows: [
        { userId: 7, lastActiveAt: T0 - 3_600, prevRequestCount: 100 },
        { userId: 9, lastActiveAt: T0 - 1_800, prevRequestCount: 50 },
      ],
      prevActiveUsers: 3,
      total: 2,
      truncated: false,
    });
  });

  it("limit 截断 rows 但 total 保留完整差集数量", () => {
    const selection = selectInactiveCandidates(PREV_ROWS, [], 2);
    expect(selection.rows).toHaveLength(2);
    expect(selection.total).toBe(3);
    expect(selection.truncated).toBe(true);
  });

  it("本期全员活跃 → 空清单；上期为空 → prevActiveUsers=0", () => {
    const allActive = PREV_ROWS.map((row) => ({ user_id: row.user_id }));
    expect(selectInactiveCandidates(PREV_ROWS, allActive, 100).rows).toEqual([]);
    expect(selectInactiveCandidates([], [], 100)).toMatchObject({
      rows: [],
      prevActiveUsers: 0,
      total: 0,
      truncated: false,
    });
  });

  it("numeric 字符串（int8 解析器异常兜底）也能整数化", () => {
    const rows = selectInactiveCandidates(
      [
        {
          user_id: "7" as unknown as number,
          prev_request_count: "100" as unknown as number,
          last_active_at: String(T0 - 3_600) as unknown as number,
        },
      ],
      [],
      100,
    );
    expect(rows.rows[0]).toEqual({
      userId: 7,
      lastActiveAt: T0 - 3_600,
      prevRequestCount: 100,
    });
  });
});

describe("runInactiveUsersQuery：差集入选后补齐账号与昵称", () => {
  /** 按表名分发的最小假库：logs 两次查询分别返回上期/本期行，users 返回名称行。 */
  function fakeInactiveDb(
    prev: PrevActiveRow[],
    current: Array<{ user_id: number }>,
    users: Array<{ id: number; username: string | null; display_name: string | null }>,
  ): ReadOnlyDatabase {
    let logCalls = 0;
    const chain = (table: string): Record<string, unknown> => {
      const self: Record<string, unknown> = {
        select: () => self,
        distinct: () => self,
        groupBy: () => self,
        where: () => self,
        execute: async () => {
          if (table === "users") return users;
          logCalls += 1;
          return logCalls === 1 ? prev : current;
        },
      };
      return self;
    };
    return { selectFrom: (table: string) => chain(table) } as unknown as ReadOnlyDatabase;
  }

  it("users.username / display_name 清洗与空串兜底（经 user-directory）", async () => {
    const snapshot = await runInactiveUsersQueryActual(
      { start: T0, end: T1 },
      100,
      fakeInactiveDb(
        PREV_ROWS,
        [{ user_id: 8 }],
        [
          { id: 7, username: "alice", display_name: " 爱丽丝 " },
          { id: 9, username: null, display_name: null },
        ],
      ),
    );
    expect(snapshot.rows).toEqual([
      {
        userId: 7,
        lastActiveAt: T0 - 3_600,
        prevRequestCount: 100,
        username: "alice",
        displayName: "爱丽丝",
      },
      {
        userId: 9,
        lastActiveAt: T0 - 1_800,
        prevRequestCount: 50,
        username: "",
        displayName: "",
      },
    ]);
    expect(snapshot.prevRange).toEqual({ start: PREV_START, end: T0 });
    expect(snapshot.total).toBe(2);
  });
});

describe("resolveInactiveParams 与缓存 key", () => {
  const url = (query: string): URLSearchParams => new URLSearchParams(query);

  it("limit 缺省 100（不是公共件的 20），显式传值生效", () => {
    expect(resolveInactiveParams(url(`start=${T0}&end=${T1}`)).limit).toBe(100);
    expect(resolveInactiveParams(url(`start=${T0}&end=${T1}&limit=200`)).limit).toBe(200);
  });

  it("区间超过 366 天 → 共享上限 400（公共 schema，path=end）", () => {
    const end = T0 + INACTIVE_MAX_RANGE_SECONDS + DAY;
    try {
      resolveInactiveParams(url(`start=${T0}&end=${end}`));
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryValidationError);
      // 上限统一由 queryParamsSchema 执行（服务层不再重复校验）
      expect((error as QueryValidationError).issues[0]?.path).toBe("end");
    }
  });

  it("缺 start / limit 超上限 → 公共件报 400 语义", () => {
    expect(() => resolveInactiveParams(url(`end=${T1}`))).toThrow(QueryValidationError);
    expect(() => resolveInactiveParams(url(`start=${T0}&end=${T1}&limit=501`))).toThrow(
      QueryValidationError,
    );
  });

  it("key 与排行命名空间隔离，且含 limit", () => {
    const base = { start: T0, end: T1, limit: 100 } as const;
    expect(inactiveCacheKey(base)).toBe(`usersRanking:all:${T0}:${T1}:all:all:inactive:limit=100`);
    expect(inactiveCacheKey({ ...base, limit: 200 })).not.toBe(inactiveCacheKey(base));
  });

  it("首次未命中、第二次命中，执行层只调用一次", async () => {
    runner.mockResolvedValue(SNAPSHOT);
    const params = { start: T0, end: T1, limit: 100 };

    const first = await getInactiveUsers(params);
    const second = await getInactiveUsers(params);

    expect(first).toEqual({ data: SNAPSHOT, cached: false });
    expect(second).toEqual({ data: SNAPSHOT, cached: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({ start: T0, end: T1 }, 100);
  });
});

describe("GET /api/users/inactive：响应与错误格式", () => {
  const url = (query = ""): string =>
    `http://localhost/api/users/inactive${query ? `?${query}` : ""}`;

  it("返回清单 + prevRange + meta（source / no-store）", async () => {
    runner.mockResolvedValue(SNAPSHOT);

    const response = await GET(new Request(url(`start=${T0}&end=${T1}`)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: InactiveUsersSnapshot;
      meta: { source?: string; cached: boolean; range: { start: number; end: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(SNAPSHOT);
    expect(body.data.prevRange).toEqual({ start: PREV_START, end: T0 });
    expect(body.meta.source).toBe(INACTIVE_SOURCE);
    expect(body.meta.cached).toBe(false);
    expect(body.meta.range).toEqual({ start: T0, end: T1 });
  });

  it("区间超限 → 400 invalid_query，不触达执行层", async () => {
    const end = T0 + INACTIVE_MAX_RANGE_SECONDS + DAY;
    const response = await GET(new Request(url(`start=${T0}&end=${end}`)));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; issues?: Array<{ path: string }> };
    };
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.issues?.some((issue) => issue.path === "end")).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("空清单返回 rows: [] 且 total=0（不是 null）", async () => {
    runner.mockResolvedValue({
      rows: [],
      prevRange: { start: PREV_START, end: T0 },
      prevActiveUsers: 0,
      total: 0,
      truncated: false,
    });
    const body = (await (await GET(new Request(url(`start=${T0}&end=${T1}`)))).json()) as {
      data: InactiveUsersSnapshot;
    };
    expect(body.data.rows).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("执行层异常 → 500 query_failed，不回显 SQL/连接串", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runner.mockRejectedValue(
      new Error("connect postgres://readonly:secret@db-host:5432/new_api select * from logs"),
    );

    const response = await GET(new Request(url(`start=${T0}&end=${T1}`)));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});
