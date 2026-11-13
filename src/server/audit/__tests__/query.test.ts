import { describe, expect, it } from "vitest";

import { parseSessionsQuery, parseThreadQuery } from "@/server/audit/query";

const DAY_START = Math.floor(Date.parse("2026-11-13T00:00:00+08:00") / 1000);

function q(record: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams({ userId: "7" });
  for (const [key, value] of Object.entries(record)) params.set(key, value);
  return params;
}

describe("parseSessionsQuery 分页", () => {
  it("默认第一页、每页 20 条", () => {
    const parsed = parseSessionsQuery(
      q({ start: String(DAY_START), end: String(DAY_START + 86_400) }),
    );
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(20);
    expect(parsed.group).toBe("request");
  });

  it("页码与每页条数来自参数，50/100 都允许", () => {
    const parsed = parseSessionsQuery(
      q({ start: String(DAY_START), end: String(DAY_START + 86_400), page: "3", limit: "100" }),
    );
    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(100);
  });

  it("每页条数超上限、页码非法都拒绝", () => {
    const base = { start: String(DAY_START), end: String(DAY_START + 86_400) };
    expect(() => parseSessionsQuery(q({ ...base, limit: "101" }))).toThrow();
    expect(() => parseSessionsQuery(q({ ...base, limit: "0" }))).toThrow();
    expect(() => parseSessionsQuery(q({ ...base, page: "0" }))).toThrow();
    expect(() => parseSessionsQuery(q({ ...base, page: "abc" }))).toThrow();
    expect(() => parseSessionsQuery(q({ ...base, page: "2000001" }))).toThrow();
  });
});

describe("parseSessionsQuery 按日期过滤", () => {
  it("date 覆盖 start/end 为东八区整日", () => {
    const parsed = parseSessionsQuery(q({ date: "2026-11-13" }));
    expect(parsed.date).toBe("2026-11-13");
    expect(parsed.start).toBe(DAY_START);
    expect(parsed.end).toBe(DAY_START + 86_400);
  });

  it("给了 date 就不再要求 start/end", () => {
    expect(() => parseSessionsQuery(q({ date: "2026-11-13" }))).not.toThrow();
  });

  it("date 非法拒绝；没 date 也没区间也拒绝", () => {
    expect(() => parseSessionsQuery(q({ date: "2026-11-31" }))).toThrow();
    expect(() => parseSessionsQuery(q({ date: "2026/11/13" }))).toThrow();
    expect(() => parseSessionsQuery(q({}))).toThrow();
  });
});

describe("parseThreadQuery", () => {
  it("会话键必须 16 位小写十六进制", () => {
    const params = q({ start: String(DAY_START), end: String(DAY_START + 86_400) });
    expect(parseThreadQuery("0123456789abcdef", params).sessionKey).toBe("0123456789abcdef");
    expect(() => parseThreadQuery("XYZ", params)).toThrow();
  });

  it("与列表接口同口径：也支持 date 单独指定某一天", () => {
    const parsed = parseThreadQuery("0123456789abcdef", q({ date: "2026-11-13" }));
    expect(parsed.date).toBe("2026-11-13");
    expect(parsed.start).toBe(DAY_START);
    expect(parsed.end).toBe(DAY_START + 86_400);
    expect(() => parseThreadQuery("0123456789abcdef", q({ date: "2026-11-31" }))).toThrow();
  });
});
