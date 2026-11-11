/**
 * BE-M1-06 单测：模型排行/趋势/交叉的 SQL 口径、models 过滤、平均成本、others 合并、路由与缓存。
 *
 * 约束：无真实库——SQL 用 `compile()` 断言（不执行），执行层 mock 三个 run 函数。
 * 数值对数挂 LH-05；cross 端点回流决议待用户批准。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/queries/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/model")>();
  return {
    ...actual,
    runModelRankingQuery: vi.fn(),
    runModelTrendQuery: vi.fn(),
    runModelCrossQuery: vi.fn(),
  };
});

import { GET as getCross } from "@/app/api/models/cross/route";
import { GET as getRanking } from "@/app/api/models/ranking/route";
import { GET as getTrend } from "@/app/api/models/trend/route";
import { clearCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import type { Database } from "@/server/schema";
import {
  MODEL_FILTER_MAX,
  MODEL_RANKING_MAX_LIMIT,
  MODEL_SOURCE,
  assembleModelCross,
  assembleModelRanking,
  assembleModelTrend,
  buildModelCrossMatrixQuery,
  buildModelRankingRequestsQuery,
  buildModelRankingTotalsQuery,
  buildModelTrendQuotaQuery,
  buildModelTrendRequestQuery,
  buildTopModelsQuery,
  modelTrendKeyPart,
  parseModelFilter,
  runModelCrossQuery,
  runModelRankingQuery,
  runModelTrendQuery,
  type ModelCrossRow,
  type ModelRankingRow,
} from "@/server/queries/model";

const DAY = 86_400;
const T0 = 1_794_240_000; // 2026-11-10 00:00 +08
const T1 = T0 + DAY;

const ROW_A: ModelRankingRow = {
  modelName: "gpt-4o",
  totalQuota: 1_000,
  totalTokens: 5_000,
  requestCount: 10,
  avgCost: 100,
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

const rankingRunner = vi.mocked(runModelRankingQuery);
const trendRunner = vi.mocked(runModelTrendQuery);
const crossRunner = vi.mocked(runModelCrossQuery);

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  rankingRunner.mockReset();
  trendRunner.mockReset();
  crossRunner.mockReset();
});

describe("模型统计 SQL 编译口径", () => {
  it("ranking：按 model_name 聚合，消耗降序 + 名称兜底 + limit 参数化", () => {
    const compiled = buildModelRankingTotalsQuery(db, { start: T0, end: T1 }, 20).compile();

    expect(compiled.sql).toMatch(/group by "model_name"/);
    expect(compiled.sql).toMatch(/order by COALESCE\(SUM\(quota\), 0\) desc/i);
    expect(compiled.sql).toMatch(/"model_name" asc/i);
    expect(compiled.sql).toMatch(/limit \$3/);
    expect(compiled.parameters).toEqual([T0, T1, 20]);
  });

  it("ranking 请求数：logs 按 model_name 聚合，IN 列表参数化", () => {
    const compiled = buildModelRankingRequestsQuery(db, { start: T0, end: T1 }, [
      "gpt-4o",
      "claude",
    ]).compile();

    expect(compiled.sql).toContain('from "logs"');
    expect(compiled.sql).toContain('COUNT(*)::bigint as "request_count"');
    expect(compiled.sql).toMatch(/"model_name" in \(\$3, \$4\)/);
    expect(compiled.parameters).toEqual([T0, T1, "gpt-4o", "claude"]);
  });

  it("趋势：桶 × model_name 分组，IN 参数化，空桶由 JS 补齐", () => {
    const quota = buildModelTrendQuotaQuery(db, { start: T0, end: T1 }, "day", [
      "gpt-4o",
    ]).compile();
    const logs = buildModelTrendRequestQuery(db, { start: T0, end: T1 }, "day", [
      "gpt-4o",
    ]).compile();

    for (const compiled of [quota, logs]) {
      expect(compiled.sql).toContain("DATE_TRUNC('day'");
      expect(compiled.sql).toMatch(/"model_name" in \(\$3\)/);
      expect(compiled.sql).toMatch(/group by .*"model_name"/);
      expect(compiled.parameters).toEqual([T0, T1, "gpt-4o"]);
    }
  });

  it("Top 模型默认维度：limit 固定参数化", () => {
    const compiled = buildTopModelsQuery(db, { start: T0, end: T1 }, 10).compile();
    expect(compiled.sql).toMatch(/limit \$3/);
    expect(compiled.parameters).toEqual([T0, T1, 10]);
  });

  it("cross 矩阵：user_id × model_name 双 IN + 分组", () => {
    const compiled = buildModelCrossMatrixQuery(
      db,
      { start: T0, end: T1 },
      [7, 8],
      ["gpt-4o", "claude"],
    ).compile();

    expect(compiled.sql).toMatch(/"user_id" in \(\$3, \$4\)/);
    expect(compiled.sql).toMatch(/"model_name" in \(\$5, \$6\)/);
    expect(compiled.sql).toMatch(/group by "user_id", "model_name"/);
    expect(compiled.parameters).toEqual([T0, T1, 7, 8, "gpt-4o", "claude"]);
  });
});

describe("parseModelFilter：models 过滤参数", () => {
  it("未给/空串 → undefined（走默认 Top 10）", () => {
    expect(parseModelFilter(null)).toBeUndefined();
    expect(parseModelFilter(undefined)).toBeUndefined();
    expect(parseModelFilter("")).toBeUndefined();
    expect(parseModelFilter(" , , ")).toBeUndefined();
  });

  it("逗号分隔、trim、去重", () => {
    expect(parseModelFilter(" gpt-4o , claude ,gpt-4o")).toEqual(["gpt-4o", "claude"]);
    expect(parseModelFilter("openai/gpt-4o")).toEqual(["openai/gpt-4o"]);
  });

  it("超过上限 → 400 语义（issues.path=models）", () => {
    const many = Array.from({ length: MODEL_FILTER_MAX + 1 }, (_, i) => `m${i}`).join(",");
    expect(() => parseModelFilter(many)).toThrow(QueryValidationError);
    try {
      parseModelFilter(many);
    } catch (error) {
      expect((error as QueryValidationError).issues[0]?.path).toBe("models");
    }
  });

  it("非法模型名（空格/冒号/保留值 all）→ 400", () => {
    for (const raw of ["gpt 4o", "a:b", "all", "a'b"]) {
      try {
        parseModelFilter(raw);
        throw new Error(`应当抛错：${raw}`);
      } catch (error) {
        expect(error, raw).toBeInstanceOf(QueryValidationError);
        expect((error as QueryValidationError).issues[0]?.path).toBe("models");
      }
    }
  });
});

describe("modelTrendKeyPart：缓存 key 的模型维度", () => {
  it("默认 Top N 固定为 top10；列表顺序无关且长度可控", () => {
    expect(modelTrendKeyPart(undefined)).toBe("top10");
    expect(modelTrendKeyPart([])).toBe("top10");

    const a = modelTrendKeyPart(["gpt-4o", "claude"]);
    const b = modelTrendKeyPart(["claude", "gpt-4o"]);
    expect(a).toBe(b);
    expect(a.length).toBeLessThan(32);
    expect(modelTrendKeyPart(["gpt-4o"])).not.toBe(a);
  });
});

describe("装配：平均成本 / 序列 / 交叉 others", () => {
  it("ranking 平均成本：请求数 0 记 0，保留 4 位", () => {
    const rows = assembleModelRanking(
      [
        { model_name: "gpt-4o", total_quota: 1_000, total_tokens: 5_000 },
        { model_name: "idle", total_quota: 7, total_tokens: 0 },
      ],
      [
        { model_name: "gpt-4o", request_count: 10 },
        { model_name: "idle", request_count: 0 },
      ],
      20,
    );

    expect(rows).toEqual([ROW_A, {
      modelName: "idle",
      totalQuota: 7,
      totalTokens: 0,
      requestCount: 0,
      avgCost: 0,
    }]);
  });

  it("trend：每个模型一条等长序列，空桶补 0", () => {
    const result = assembleModelTrend(
      ["gpt-4o"],
      [T0, T1],
      "day",
      [
        {
          bucket_start: T1,
          model_name: "gpt-4o",
          total_quota: 100,
          total_tokens: 200,
          prompt_tokens: 120,
          completion_tokens: 80,
        },
      ],
      [{ bucket_start: T1, model_name: "gpt-4o", request_count: 3 }],
    );

    expect(result.series).toHaveLength(1);
    const points = result.series[0]?.points ?? [];
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ bucketStart: T0, totalQuota: 0, requestCount: 0 });
    expect(points[1]).toMatchObject({ bucketStart: T1, totalQuota: 100, requestCount: 3 });
    expect(points.map((point) => point.label)).toEqual(["2026-11-10", "2026-11-11"]);
  });

  it("cross：cells 稀疏 + others = 用户总消耗 − Top 模型消耗（≥0）", () => {
    const rows: ModelCrossRow[] = [
      { user_id: 7, model_name: "gpt-4o", total_quota: 100 },
      { user_id: 7, model_name: "claude", total_quota: 50 },
      { user_id: 8, model_name: "gpt-4o", total_quota: 30 },
    ];
    const result = assembleModelCross(
      [
        { userId: 7, username: "alice", totalQuota: 200 },
        { userId: 8, username: "bob", totalQuota: 30 },
      ],
      ["gpt-4o", "claude"],
      rows,
    );

    expect(result.users).toEqual([
      { userId: 7, username: "alice" },
      { userId: 8, username: "bob" },
    ]);
    expect(result.models).toEqual(["gpt-4o", "claude"]);
    expect(result.cells).toHaveLength(3);
    expect(result.others).toEqual([
      { userId: 7, totalQuota: 50 }, // 200 - 150
      { userId: 8, totalQuota: 0 }, // 30 - 30
    ]);
  });

  it("cross：空数据返回空结构（不返回 null）", () => {
    expect(assembleModelCross([], [], [])).toEqual({
      users: [],
      models: [],
      cells: [],
      others: [],
    });
  });
});

describe("GET /api/models/ranking", () => {
  const url = (query = "start=2026-11-10&end=2026-11-11") =>
    `http://localhost/api/models/ranking?${query}`;

  it("返回 rows + meta（granularity=null / source / no-store），第二次命中缓存", async () => {
    rankingRunner.mockResolvedValue([ROW_A]);

    const first = await getRanking(new Request(url()));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");

    const body = (await first.json()) as {
      data: { rows: ModelRankingRow[] };
      meta: { granularity: string | null; cached: boolean; source?: string };
    };
    expect(body.data.rows).toEqual([ROW_A]);
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.cached).toBe(false);
    expect(body.meta.source).toBe(MODEL_SOURCE);

    const second = (await (await getRanking(new Request(url()))).json()) as {
      meta: { cached: boolean };
    };
    expect(second.meta.cached).toBe(true);
    expect(rankingRunner).toHaveBeenCalledTimes(1);
  });

  it("limit 超限 → 400（不触达执行层）", async () => {
    const response = await getRanking(
      new Request(url(`start=2026-11-10&end=2026-11-11&limit=${MODEL_RANKING_MAX_LIMIT + 1}`)),
    );
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { issues?: Array<{ path: string }> } }).error.issues?.some(
        (issue) => issue.path === "limit",
      ),
    ).toBe(true);
    expect(rankingRunner).not.toHaveBeenCalled();
  });

  it("执行层异常 → 500，无 SQL/连接串泄漏", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rankingRunner.mockRejectedValue(
      new Error("connect postgres://readonly:secret@db-host:5432/new_api select 1"),
    );
    const response = await getRanking(new Request(url()));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("GET /api/models/trend", () => {
  const url = (query: string) => `http://localhost/api/models/trend?${query}`;

  it("默认 Top10 维度 + granularity=day：每模型等长序列", async () => {
    trendRunner.mockResolvedValue({
      series: [
        {
          modelName: "gpt-4o",
          points: [
            { bucketStart: T0, label: "2026-11-10", totalQuota: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, requestCount: 0 },
            { bucketStart: T1, label: "2026-11-11", totalQuota: 5, totalTokens: 9, promptTokens: 4, completionTokens: 5, requestCount: 1 },
          ],
        },
      ],
    });

    const response = await getTrend(new Request(url("start=2026-11-10&end=2026-11-12")));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { series: Array<{ modelName: string; points: unknown[] }> };
      meta: { granularity: string | null; cached: boolean };
    };
    expect(body.data.series[0]?.modelName).toBe("gpt-4o");
    expect(body.data.series[0]?.points).toHaveLength(2);
    expect(body.meta.granularity).toBe("day");
    expect(trendRunner).toHaveBeenCalledWith({ start: T0, end: T0 + 2 * DAY }, "day", undefined);
  });

  it("models 过滤生效（逗号分隔 → 数组）", async () => {
    trendRunner.mockResolvedValue({ series: [] });
    await getTrend(
      new Request(url("start=2026-11-10&end=2026-11-11&models=gpt-4o,claude")),
    );
    expect(trendRunner).toHaveBeenCalledWith({ start: T0, end: T1 }, "day", [
      "gpt-4o",
      "claude",
    ]);
  });

  it("models 非法/超限 → 400；桶数超限 → 400", async () => {
    const badModels = await getTrend(
      new Request(url("start=2026-11-10&end=2026-11-11&models=gpt%204o")),
    );
    expect(badModels.status).toBe(400);
    expect(
      ((await badModels.json()) as { error: { issues?: Array<{ path: string }> } }).error.issues?.some(
        (issue) => issue.path === "models",
      ),
    ).toBe(true);

    const tooMany = await getTrend(
      new Request(
        url(`start=2026-11-10&end=2026-11-11&models=${Array.from({ length: 11 }, (_, i) => `m${i}`).join(",")}`),
      ),
    );
    expect(tooMany.status).toBe(400);

    const end = T0 + 1_001 * DAY;
    const tooLong = await getTrend(new Request(url(`start=2026-11-10&end=${end}&granularity=day`)));
    expect(tooLong.status).toBe(400);
    expect(trendRunner).not.toHaveBeenCalled();
  });
});

describe("GET /api/models/cross", () => {
  const url = (query = "start=2026-11-10&end=2026-11-11") =>
    `http://localhost/api/models/cross?${query}`;

  it("返回 users/models/cells/others 与 meta；第二次命中缓存", async () => {
    crossRunner.mockResolvedValue({
      users: [{ userId: 7, username: "alice" }],
      models: ["gpt-4o"],
      cells: [{ userId: 7, modelName: "gpt-4o", totalQuota: 10 }],
      others: [{ userId: 7, totalQuota: 5 }],
    });

    const response = await getCross(new Request(url()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { users: unknown[]; models: string[]; cells: unknown[]; others: unknown[] };
      meta: { granularity: string | null; cached: boolean; source?: string };
    };
    expect(body.data.models).toEqual(["gpt-4o"]);
    expect(body.data.cells).toHaveLength(1);
    expect(body.data.others).toHaveLength(1);
    expect(body.meta.granularity).toBeNull();
    expect(body.meta.source).toBe(MODEL_SOURCE);

    const second = (await (await getCross(new Request(url()))).json()) as {
      meta: { cached: boolean };
    };
    expect(second.meta.cached).toBe(true);
    expect(crossRunner).toHaveBeenCalledTimes(1);
  });

  it("空数据返回空结构仍 200；limit 超限 → 400", async () => {
    crossRunner.mockResolvedValue({ users: [], models: [], cells: [], others: [] });
    const empty = await getCross(new Request(url()));
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toEqual({
      users: [],
      models: [],
      cells: [],
      others: [],
    });

    const over = await getCross(
      new Request(url(`start=2026-11-10&end=2026-11-11&limit=${MODEL_RANKING_MAX_LIMIT + 1}`)),
    );
    expect(over.status).toBe(400);
  });
});
