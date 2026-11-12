/**
 * 单测：CSV 转义/BOM/流式、数据集参数校验、滑动窗口限流、路由响应与 429。
 *
 * 无真实库：数据层（stats.service / model / user query）全部 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

vi.mock("@/server/services/stats.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/stats.service")>();
  return { ...actual, getTrend: vi.fn(), getUserRanking: vi.fn() };
});

vi.mock("@/server/queries/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/model")>();
  return { ...actual, runModelRankingQuery: vi.fn() };
});

vi.mock("@/server/queries/user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/queries/user")>();
  return { ...actual, runUserModelsQuery: vi.fn() };
});

import { GET } from "@/app/api/export/csv/route";
import { clearCache } from "@/server/cache";
import { QueryValidationError } from "@/server/queries/common";
import { runModelRankingQuery } from "@/server/queries/model";
import { runUserModelsQuery } from "@/server/queries/user";
import { getTrend, getUserRanking } from "@/server/services/stats.service";
import {
  CSV_BOM,
  EXPORT_DATASETS,
  csvStream,
  escapeCsvField,
  exportFilename,
  resolveExportRequest,
  rowsForModelsRanking,
  rowsForTrend,
  rowsForUserModels,
  rowsForUsersRanking,
  toCsvLine,
} from "@/server/services/export.service";
import {
  EXPORT_RATE_LIMIT,
  createRateLimiter,
  exportRateLimiter,
} from "@/lib/rate-limit";

const T0 = 1_794_240_000;
const T1 = T0 + 86_400;

const trendUser = vi.mocked(getUserRanking);
const trendLoader = vi.mocked(getTrend);
const modelRankingLoader = vi.mocked(runModelRankingQuery);
const userModelsLoader = vi.mocked(runUserModelsQuery);

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  // ignoreBOM: true —— 保留 BOM 字符，便于断言 Excel 兼容前缀
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** 读取 CSV 响应：同时返回原始字节（断言 BOM）与保留 BOM 的文本。 */
async function readCsvResponse(
  response: Response,
): Promise<{ text: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { text, bytes };
}

function request(query: string, ip = "203.0.113.9"): Request {
  return new Request(`http://localhost/api/export/csv?${query}`, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  clearCache();
  exportRateLimiter.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  exportRateLimiter.reset();
  clearCache();
  vi.restoreAllMocks();
  trendUser.mockReset();
  trendLoader.mockReset();
  modelRankingLoader.mockReset();
  userModelsLoader.mockReset();
});

describe("CSV 转义与流式输出", () => {
  it("逗号/引号/换行转义，普通值原样", () => {
    expect(escapeCsvField("alice")).toBe("alice");
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
    expect(escapeCsvField(42)).toBe("42");
  });

  it("行拼接使用逗号，含逗号字段被引号包裹", () => {
    expect(toCsvLine([7, "a,b", 100])).toBe('7,"a,b",100');
  });

  it("流以 BOM + 表头开头，CRLF 换行，行数完整", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => [index, `u${index}`]);
    const text = await readStream(csvStream(["id", "name"], rows));

    expect(text.startsWith(`${CSV_BOM}id,name\r\n`)).toBe(true);
    expect(text.split("\r\n").filter((line) => line !== "")).toHaveLength(251);
    expect(text.endsWith("249,u249\r\n")).toBe(true);
  });

  it("空数据只输出表头", async () => {
    const text = await readStream(csvStream(["id"], []));
    expect(text).toBe(`${CSV_BOM}id\r\n`);
  });
});

describe("行映射与文件名", () => {
  it("四类数据集行顺序与 API 字段一致", () => {
    expect(
      rowsForUsersRanking([
        {
          userId: 7,
          username: "alice",
          displayName: "爱丽丝",
          totalQuota: 100,
          totalTokens: 300,
          requestCount: 9,
        },
      ]),
    ).toEqual([[7, "爱丽丝", "alice", 100, 300, 9]]);

    expect(
      rowsForUsersRanking([
        { userId: 8, username: "bob", totalQuota: 1, totalTokens: 2, requestCount: 3 },
      ]),
    ).toEqual([[8, "", "bob", 1, 2, 3]]);

    expect(
      rowsForTrend([
        {
          bucketStart: T0,
          label: "2026-11-10",
          totalQuota: 1,
          totalTokens: 2,
          promptTokens: 3,
          completionTokens: 4,
          requestCount: 5,
          activeUsers: 1,
        },
      ]),
    ).toEqual([[T0, "2026-11-10", 1, 2, 3, 4, 5]]);

    expect(
      rowsForModelsRanking([
        {
          modelName: "gpt-4o",
          totalQuota: 10,
          totalTokens: 20,
          requestCount: 4,
          avgCost: 2.5,
        },
      ]),
    ).toEqual([["gpt-4o", 10, 20, 4, 2.5]]);

    expect(
      rowsForUserModels([
        {
          modelName: "gpt-4o",
          totalQuota: 10,
          totalTokens: 300,
          promptTokens: 100,
          completionTokens: 200,
          promptShare: 0.3333,
          completionShare: 0.6667,
        },
      ]),
    ).toEqual([["gpt-4o", 10, 300, 100, 200, 0.3333, 0.6667]]);
  });

  it("文件名含 dataset 与区间", () => {
    expect(exportFilename("trend", T0, T1)).toBe(`dashboard-trend-${T0}-${T1}.csv`);
  });
});

describe("resolveExportRequest：数据集与参数校验", () => {
  it("dataset 必填且在枚举内", () => {
    expect(EXPORT_DATASETS).toEqual(["usersRanking", "trend", "modelsRanking", "userModels"]);

    for (const query of [
      `start=${T0}&end=${T1}`,
      `dataset=nope&start=${T0}&end=${T1}`,
    ]) {
      try {
        resolveExportRequest(new URLSearchParams(query));
        throw new Error(`应当抛错：${query}`);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryValidationError);
        expect((error as QueryValidationError).issues[0]?.path).toBe("dataset");
      }
    }
  });

  it("userModels 必须带 userId；trend 粒度缺省 day", () => {
    try {
      resolveExportRequest(new URLSearchParams(`dataset=userModels&start=${T0}&end=${T1}`));
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as QueryValidationError).issues[0]?.path).toBe("userId");
    }

    const trend = resolveExportRequest(
      new URLSearchParams(`dataset=trend&start=${T0}&end=${T1}`),
    );
    expect(trend.granularity).toBe("day");

    const weekly = resolveExportRequest(
      new URLSearchParams(`dataset=trend&start=${T0}&end=${T1}&granularity=week`),
    );
    expect(weekly.granularity).toBe("week");
  });

  it("排行类 limit 超过 100 → 400（issues.path=limit）", () => {
    for (const dataset of ["usersRanking", "modelsRanking"]) {
      try {
        resolveExportRequest(
          new URLSearchParams(`dataset=${dataset}&start=${T0}&end=${T1}&limit=101`),
        );
        throw new Error(`应当抛错：${dataset}`);
      } catch (error) {
        expect((error as QueryValidationError).issues[0]?.path).toBe("limit");
      }
    }
  });
});

describe("滑动窗口限流", () => {
  it("窗口内 10 次放行、第 11 次拒绝；窗口滚动后恢复", () => {
    expect(EXPORT_RATE_LIMIT).toEqual({ limit: 10, windowMs: 60_000 });
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });

    expect(limiter.check("ip", 0).allowed).toBe(true);
    expect(limiter.check("ip", 100).allowed).toBe(true);

    const denied = limiter.check("ip", 200);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAt).toBe(1_000);

    expect(limiter.check("ip", 1_001).allowed).toBe(true);
  });

  it("不同 key 互不影响；reset 清空计数", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(false);
    expect(limiter.check("b", 1).allowed).toBe(true);

    limiter.reset();
    expect(limiter.check("a", 2).allowed).toBe(true);
  });
});

describe("GET /api/export/csv", () => {
  it("usersRanking：返回 CSV 附件，含逗号用户名转义与 BOM", async () => {
    trendUser.mockResolvedValue({
      data: {
        rows: [
          {
            userId: 7,
            username: "a,b",
            displayName: "爱丽丝",
            totalQuota: 100,
            totalTokens: 300,
            requestCount: 9,
          },
        ],
      },
      cached: false,
    });

    const response = await GET(
      request(`dataset=usersRanking&start=${T0}&end=${T1}&limit=20`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      `filename="dashboard-usersRanking-${T0}-${T1}.csv"`,
    );

    const { text, bytes } = await readCsvResponse(response);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(
      text.startsWith(
        `${CSV_BOM}user_id,display_name,username,total_quota,total_tokens,request_count`,
      ),
    ).toBe(true);
    expect(text).toContain('7,爱丽丝,"a,b",100,300,9');
  });

  it("trend：走既有趋势 service（默认粒度 day），输出桶列", async () => {
    trendLoader.mockResolvedValue({
      data: {
        points: [
          {
            bucketStart: T0,
            label: "2026-11-10",
            totalQuota: 1,
            totalTokens: 2,
            promptTokens: 3,
            completionTokens: 4,
            requestCount: 5,
            activeUsers: 1,
          },
        ],
      },
      cached: false,
    });

    const response = await GET(request(`dataset=trend&start=${T0}&end=${T1}`, "198.51.100.1"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("bucket_start,bucket_label");
    expect(text).toContain(`${T0},2026-11-10,1,2,3,4,5`);
    expect(trendLoader).toHaveBeenCalledWith(
      expect.objectContaining({ compare: "none", params: expect.objectContaining({ granularity: "day" }) }),
    );
  });

  it("modelsRanking / userModels：使用对应查询与缓存 key 口径", async () => {
    modelRankingLoader.mockResolvedValue([
      { modelName: "gpt-4o", totalQuota: 10, totalTokens: 20, requestCount: 4, avgCost: 2.5 },
    ]);
    userModelsLoader.mockResolvedValue({
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
      recent: [],
    });

    const models = await GET(
      request(`dataset=modelsRanking&start=${T0}&end=${T1}&limit=20`, "198.51.100.2"),
    );
    expect(models.status).toBe(200);
    expect(await models.text()).toContain("gpt-4o,10,20,4,2.5");

    const userModels = await GET(
      request(`dataset=userModels&userId=7&start=${T0}&end=${T1}`, "198.51.100.3"),
    );
    expect(userModels.status).toBe(200);
    expect(await userModels.text()).toContain("gpt-4o,10,300,100,200,0.3333,0.6667");
    expect(userModelsLoader).toHaveBeenCalledWith(7, { start: T0, end: T1 });
  });

  it("第 11 次请求（同 IP / 60s 窗口）返回 429 rate_limited", async () => {
    trendUser.mockResolvedValue({ data: { rows: [] }, cached: false });
    const ip = "192.0.2.55";
    const query = `dataset=usersRanking&start=${T0}&end=${T1}`;

    for (let i = 0; i < 10; i += 1) {
      const response = await GET(request(query, ip));
      expect(response.status, `第 ${i + 1} 次`).toBe(200);
      await response.text();
    }

    const limited = await GET(request(query, ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    const body = (await limited.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("rate_limited");
  });

  it("参数错误 → 400；执行层异常 → 500 且无 SQL/连接串泄漏", async () => {
    const bad = await GET(request(`dataset=nope&start=${T0}&end=${T1}`, "198.51.100.4"));
    expect(bad.status).toBe(400);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    trendUser.mockRejectedValue(
      new Error("connect postgres://readonly:secret@db-host:5432/new_api select 1"),
    );
    const failed = await GET(
      request(`dataset=usersRanking&start=${T0}&end=${T1}`, "198.51.100.5"),
    );
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|secret/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});
