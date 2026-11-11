/**
 * BE-M1-01 单测：参数归一化、Asia/Shanghai 时间边界、环比/同比、响应格式、缓存接入。
 *
 * 时间基准（东八区）：
 * - 2026-11-10 00:00:00 +08 = 1794240000；23:59:59 +08 = 1794326399
 * - 2026-11-10 是周二 → 本周一 2026-11-09 00:00 +08 = 1794153600
 * - 2026-11-01 00:00 +08 = 1793462400；2026-10-10 00:00 +08 = 1791561600
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCache } from "@/server/cache";
import {
  invalidQuery,
  ok,
  queryFailed,
  toQueryIssues,
  type ApiMeta,
} from "@/server/http";
import {
  DEFAULT_LIMIT,
  MAX_EPOCH_SECONDS,
  MODEL_NAME_PATTERN,
  QueryValidationError,
  SCOPE_TTL_MS,
  addShanghaiDays,
  addShanghaiMonths,
  bucketStart,
  cachedQuery,
  metaFromParams,
  normalizeQueryParams,
  parseTimeInput,
  prevRange,
  queryCacheKey,
  queryParamsSchema,
  shanghaiDate,
  shanghaiDayStart,
  shanghaiMonthStart,
  shanghaiOffsetSeconds,
  shanghaiWeekStart,
  yoyRange,
} from "@/server/queries/common";

const DAY = 86_400;
const T_DAY = 1_794_240_000; // 2026-11-10 00:00 +08
const T_DAY_END = 1_794_326_399; // 2026-11-10 23:59:59 +08
const T_NEXT_DAY = 1_794_326_400; // 2026-11-11 00:00 +08
const T_MONDAY = 1_794_153_600; // 2026-11-09 00:00 +08（周一）
const T_MONTH_START = 1_793_462_400; // 2026-11-01 00:00 +08

beforeEach(() => {
  clearCache();
  vi.restoreAllMocks();
  // 缓存 dispose 在非 production 会打 debug 日志，测试里静音
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
});

describe("parseTimeInput：ISO / Unix 双格式", () => {
  it("带时区 ISO、UTC ISO、纯日期、Unix 秒都归一为同一整数秒", () => {
    expect(parseTimeInput("2026-11-10T00:00:00+08:00")).toBe(T_DAY);
    expect(parseTimeInput("2026-11-09T16:00:00Z")).toBe(T_DAY);
    expect(parseTimeInput("2026-11-10")).toBe(T_DAY); // 无时区 → Asia/Shanghai
    expect(parseTimeInput(1_760_000_000)).toBe(1_760_000_000);
    expect(parseTimeInput("1760000000")).toBe(1_760_000_000);
  });

  it("小数秒向下取整到秒", () => {
    expect(parseTimeInput(T_DAY + 0.9)).toBe(T_DAY);
    expect(parseTimeInput("2026-11-10T00:00:00.950+08:00")).toBe(T_DAY);
  });

  it("无时区 ISO 不跟随运行环境时区（按 +08:00 解释）", () => {
    const shanghaiMidnight = parseTimeInput("2026-11-10T00:00:00");
    expect(shanghaiMidnight).toBe(T_DAY);
    // 若被当成 UTC，会得到 T_DAY + 8h —— 明确排除
    expect(shanghaiMidnight).not.toBe(T_DAY + 8 * 3600);
  });

  it("非法输入返回 null", () => {
    for (const value of ["", "   ", "abc", "2026-13-01", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseTimeInput(value), String(value)).toBeNull();
    }
  });
});

describe("normalizeQueryParams：归一化与校验", () => {
  it("缺省 limit=20，区间原样保留（左闭右开由调用方语义保证）", () => {
    const params = normalizeQueryParams({
      start: "2026-11-10",
      end: "2026-11-11",
      granularity: "day",
    });
    expect(params).toMatchObject({ start: T_DAY, end: T_NEXT_DAY, granularity: "day" });
    expect(params.limit).toBe(DEFAULT_LIMIT);
    expect(params.userId).toBeUndefined();
    expect(params.modelName).toBeUndefined();
  });

  it("接受 URLSearchParams 与普通对象两种入口", () => {
    const fromSearch = normalizeQueryParams(
      new URLSearchParams("start=2026-11-10&end=2026-11-11&granularity=week&limit=50"),
    );
    expect(fromSearch).toMatchObject({ start: T_DAY, end: T_NEXT_DAY, granularity: "week", limit: 50 });

    const fromObject = normalizeQueryParams({
      start: String(T_DAY),
      end: String(T_NEXT_DAY),
      limit: "500",
      userId: "42",
      modelName: "openai/gpt-4o",
      unknown: "ignored",
    });
    expect(fromObject).toMatchObject({ limit: 500, userId: 42, modelName: "openai/gpt-4o" });
    expect("unknown" in fromObject).toBe(false);
  });

  it("金额/时间上界：Unix 秒超过 2100 年上限被拒", () => {
    expect(() =>
      normalizeQueryParams({ start: MAX_EPOCH_SECONDS + 1, end: MAX_EPOCH_SECONDS + 2 }),
    ).toThrow(QueryValidationError);
  });

  it("非法参数抛 QueryValidationError，issues 带字段路径", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["缺 start", { end: T_NEXT_DAY }, "start"],
      ["缺 end", { start: T_DAY }, "end"],
      ["时间格式非法", { start: "abc", end: T_NEXT_DAY }, "start"],
      ["end <= start", { start: T_NEXT_DAY, end: T_DAY }, "end"],
      ["end == start", { start: T_DAY, end: T_DAY }, "end"],
      ["granularity 非法", { start: T_DAY, end: T_NEXT_DAY, granularity: "hour" }, "granularity"],
      ["userId 非数字", { start: T_DAY, end: T_NEXT_DAY, userId: "abc" }, "userId"],
      ["userId 为 0", { start: T_DAY, end: T_NEXT_DAY, userId: 0 }, "userId"],
      ["userId 小数", { start: T_DAY, end: T_NEXT_DAY, userId: 1.5 }, "userId"],
      ["modelName 含冒号", { start: T_DAY, end: T_NEXT_DAY, modelName: "a:b" }, "modelName"],
      ["modelName 含空格", { start: T_DAY, end: T_NEXT_DAY, modelName: "gpt 4o" }, "modelName"],
      ["modelName 保留值 all", { start: T_DAY, end: T_NEXT_DAY, modelName: "all" }, "modelName"],
      ["modelName 超长", { start: T_DAY, end: T_NEXT_DAY, modelName: "a".repeat(129) }, "modelName"],
      ["limit 0", { start: T_DAY, end: T_NEXT_DAY, limit: 0 }, "limit"],
      ["limit 501", { start: T_DAY, end: T_NEXT_DAY, limit: 501 }, "limit"],
      ["limit 非数字", { start: T_DAY, end: T_NEXT_DAY, limit: "abc" }, "limit"],
    ];

    for (const [label, input, path] of cases) {
      try {
        normalizeQueryParams(input);
        throw new Error(`应当抛错：${label}`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(QueryValidationError);
        const issues = (error as QueryValidationError).issues;
        expect(issues.some((issue) => issue.path === path), `${label} 的 issues 应含 path=${path}`).toBe(
          true,
        );
        expect((error as QueryValidationError).code).toBe("invalid_query");
      }
    }
  });

  it("modelName 白名单与缓存 key 侧同规则", () => {
    expect(MODEL_NAME_PATTERN.test("openai/gpt-4o")).toBe(true);
    expect(MODEL_NAME_PATTERN.test("deepseek-reasoner")).toBe(true);
    expect(MODEL_NAME_PATTERN.test("a".repeat(128))).toBe(true);
    expect(MODEL_NAME_PATTERN.test("a".repeat(129))).toBe(false);
    expect(MODEL_NAME_PATTERN.test("gpt 4o")).toBe(false);
    expect(MODEL_NAME_PATTERN.test("a:b")).toBe(false);
  });
});

describe("缓存 key 确定性：ISO 与 Unix 等价", () => {
  it("同语义参数（ISO vs Unix、对象 vs URLSearchParams）生成同一 key", () => {
    const fromIso = normalizeQueryParams({
      start: "2026-11-10T00:00:00+08:00",
      end: "2026-11-11",
      granularity: "day",
    });
    const fromUnix = normalizeQueryParams({
      start: T_DAY,
      end: T_NEXT_DAY,
      granularity: "day",
    });
    const fromSearch = normalizeQueryParams(
      new URLSearchParams("start=1794240000&end=1794326400&granularity=day"),
    );

    const key = queryCacheKey("overview", fromIso);
    expect(key).toBe("overview:day:1794240000:1794326400:all:all");
    expect(queryCacheKey("overview", fromUnix)).toBe(key);
    expect(queryCacheKey("overview", fromSearch)).toBe(key);
  });

  it("userId / modelName 进入 key，缺失渲染为 all", () => {
    const params = normalizeQueryParams({
      start: T_DAY,
      end: T_NEXT_DAY,
      granularity: "week",
      userId: 42,
      modelName: "openai/gpt-4o",
    });
    expect(queryCacheKey("userTrend", params)).toBe(
      `userTrend:week:${T_DAY}:${T_NEXT_DAY}:42:openai/gpt-4o`,
    );
  });
});

describe("Asia/Shanghai 时间边界（方案 §5 口径）", () => {
  it("偏移为 +8 小时", () => {
    expect(shanghaiOffsetSeconds(T_DAY)).toBe(8 * 3600);
  });

  it("00:00 归当日、23:59:59 不串日", () => {
    expect(shanghaiDate(T_DAY)).toBe("2026-11-10");
    expect(shanghaiDate(T_DAY_END)).toBe("2026-11-10");
    expect(shanghaiDate(T_DAY - 1)).toBe("2026-11-09");
    expect(shanghaiDayStart(T_DAY)).toBe(T_DAY);
    expect(shanghaiDayStart(T_DAY_END)).toBe(T_DAY);
    expect(shanghaiDayStart(T_DAY - 1)).toBe(T_DAY - DAY);
  });

  it("周起点为周一（对齐 DATE_TRUNC('week')），月起点为当月 1 日", () => {
    expect(shanghaiWeekStart(T_DAY)).toBe(T_MONDAY);
    expect(shanghaiWeekStart(T_MONDAY)).toBe(T_MONDAY);
    expect(shanghaiMonthStart(T_DAY)).toBe(T_MONTH_START);
    expect(shanghaiMonthStart(T_DAY_END)).toBe(T_MONTH_START);
  });

  it("bucketStart 按粒度分派", () => {
    expect(bucketStart(T_DAY_END, "day")).toBe(T_DAY);
    expect(bucketStart(T_DAY_END, "week")).toBe(T_MONDAY);
    expect(bucketStart(T_DAY_END, "month")).toBe(T_MONTH_START);
  });

  it("自然日 / 自然月平移（含月末钳制）", () => {
    expect(addShanghaiDays(T_DAY, 1)).toBe(T_NEXT_DAY);
    expect(addShanghaiDays(T_DAY, -1)).toBe(T_MONDAY);
    expect(shanghaiDate(addShanghaiMonths(T_DAY, -1))).toBe("2026-10-10");
    expect(shanghaiDate(addShanghaiMonths(T_DAY, 12))).toBe("2027-11-10");

    const jan31 = parseTimeInput("2026-01-31T00:00:00+08:00") as number;
    expect(shanghaiDate(addShanghaiMonths(jan31, 1))).toBe("2026-02-28"); // 2026 非闰年
  });
});

describe("环比 / 同比区间（§3.2）", () => {
  it("day 平移 1 天、week 平移 7 天", () => {
    expect(prevRange(T_DAY, T_NEXT_DAY, "day")).toEqual({ start: T_DAY - DAY, end: T_DAY });
    expect(prevRange(T_DAY, T_NEXT_DAY, "week")).toEqual({ start: T_DAY - 7 * DAY, end: T_NEXT_DAY - 7 * DAY });
  });

  it("month 按自然月平移（11 月 → 10 月）", () => {
    const prev = prevRange(T_MONTH_START, T_NEXT_DAY, "month"); // 近似 [11-01, 11-11)
    expect(shanghaiDate(prev.start)).toBe("2026-10-01");
    expect(shanghaiDate(prev.end)).toBe("2026-10-11");
  });

  it("同比前移 12 个月", () => {
    const yoy = yoyRange(T_DAY, T_NEXT_DAY);
    expect(shanghaiDate(yoy.start)).toBe("2025-11-10");
    expect(shanghaiDate(yoy.end)).toBe("2025-11-11");
    expect(yoy.start).toBe(1_762_704_000);
  });
});

describe("响应格式（http.ts）", () => {
  const meta: ApiMeta = { range: { start: T_DAY, end: T_NEXT_DAY }, granularity: "day", cached: false };

  it("ok：200 + { ok, data, meta } + no-store", async () => {
    const response = ok({ total: 1 }, meta);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, data: { total: 1 }, meta });
  });

  it("invalidQuery：400 + invalid_query + issues", async () => {
    const issues = [{ path: "start", message: "时间格式不合法" }];
    const response = invalidQuery(issues);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string; issues: typeof issues };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.issues).toEqual(issues);
  });

  it("queryFailed：500 + query_failed，且不回显 SQL/连接串", async () => {
    const response = queryFailed();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("query_failed");
    expect(text).not.toMatch(/select|postgres:\/\/|db-host|quota_data/i);
  });

  it("toQueryIssues 输出字段路径（表单级错误 path 为空串）", () => {
    const parsed = queryParamsSchema.safeParse({ start: "abc", end: "2026-11-10" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = toQueryIssues(parsed.error);
    expect(issues.some((issue) => issue.path === "start")).toBe(true);
    expect(issues.every((issue) => typeof issue.message === "string" && issue.message.length > 0)).toBe(
      true,
    );
  });

  it("metaFromParams：无粒度时 granularity=null", () => {
    const params = normalizeQueryParams({ start: T_DAY, end: T_NEXT_DAY });
    expect(metaFromParams(params, true)).toEqual({
      range: { start: T_DAY, end: T_NEXT_DAY },
      granularity: null,
      cached: true,
    });
  });
});

describe("缓存接入约定", () => {
  it("SCOPE_TTL_MS 与缓存层 TTL 表同源", () => {
    expect(SCOPE_TTL_MS.overview).toBe(60_000);
    expect(SCOPE_TTL_MS.usersRanking).toBe(120_000);
    expect(SCOPE_TTL_MS.userTrend).toBe(30_000);
    expect(SCOPE_TTL_MS.modelDist).toBe(30_000);
    expect(SCOPE_TTL_MS.realtime).toBe(10_000);
    expect(SCOPE_TTL_MS.historyMonth).toBe(3_600_000);
  });

  it("cachedQuery：首次未命中、第二次命中且只加载一次", async () => {
    const params = normalizeQueryParams({
      start: T_DAY,
      end: T_NEXT_DAY,
      granularity: "day",
    });
    const key = queryCacheKey("overview", params);
    const load = vi.fn(async () => ({ total: 7 }));

    const first = await cachedQuery(key, SCOPE_TTL_MS.overview, load);
    const second = await cachedQuery(key, SCOPE_TTL_MS.overview, load);

    expect(first).toEqual({ data: { total: 7 }, cached: false });
    expect(second).toEqual({ data: { total: 7 }, cached: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cachedQuery：加载异常不上报为命中，且下次重试", async () => {
    const key = "userTrend:day:1:2:all:all";
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("db down");
      return { ok: true };
    };

    await expect(cachedQuery(key, SCOPE_TTL_MS.userTrend, flaky)).rejects.toThrow("db down");
    const retry = await cachedQuery(key, SCOPE_TTL_MS.userTrend, flaky);
    expect(retry).toEqual({ data: { ok: true }, cached: false });
    expect(attempts).toBe(2);
  });
});
