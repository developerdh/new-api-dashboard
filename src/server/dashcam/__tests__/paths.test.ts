import { describe, expect, it } from "vitest";

import {
  DASHCAM_DATE_PATTERN,
  DashcamQueryError,
  FINGERPRINT_PATTERN,
  TRACE_PATTERN,
  dashcamBlobPath,
  dashcamDateOf,
  dashcamIndexPath,
  assertInsideRoot,
  listIndexDates,
} from "@/server/dashcam/paths";
import { resolve } from "node:path";

const ROOT = resolve("D:/tmp/dashcam-root");

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

describe("路径白名单", () => {
  it("trace 允许 71 位（64 + 冲突后缀 6 + 连字符）", () => {
    const conflict = `${"a".repeat(64)}-abcdef`;
    expect(conflict).toHaveLength(71);
    expect(TRACE_PATTERN.test(conflict)).toBe(true);
    expect(TRACE_PATTERN.test(`${conflict}a`)).toBe(false);
  });

  it("拒绝路径穿越与非法字符", () => {
    expect(TRACE_PATTERN.test("../../etc/passwd")).toBe(false);
    expect(TRACE_PATTERN.test("abc/def/ghi")).toBe(false);
    expect(FINGERPRINT_PATTERN.test("dbbbf1891a47")).toBe(true);
    expect(FINGERPRINT_PATTERN.test("_anon")).toBe(true);
    expect(FINGERPRINT_PATTERN.test("DBBBF1891A47")).toBe(false);
    expect(DASHCAM_DATE_PATTERN.test("2026-11-13")).toBe(true);
    expect(DASHCAM_DATE_PATTERN.test("2026-11-13/../x")).toBe(false);
  });

  it("assertInsideRoot 只放行根目录内的路径", () => {
    expect(assertInsideRoot(ROOT, `${ROOT}/index/2026-11-13.ndjson`)).toContain("index");
    expect(() => assertInsideRoot(ROOT, `${ROOT}/../evil`)).toThrow(/越界/);
    expect(() => assertInsideRoot(ROOT, `${ROOT}-evil/x`)).toThrow(/越界/);
  });

  it("索引与 blob 路径由校验后的字段拼装", () => {
    expect(dashcamIndexPath(ROOT, "2026-11-13")).toContain("index");
    expect(() => dashcamIndexPath(ROOT, "../2026-11-13")).toThrow();

    expect(
      dashcamBlobPath(ROOT, {
        date: "2026-11-13",
        fp: "dbbbf1891a47",
        trace: "0123456789abcdef0123456789abcdef",
        kind: "req",
        gz: true,
      }),
    ).toMatch(/\.req\.gz$/);
    expect(() =>
      dashcamBlobPath(ROOT, {
        date: "2026-11-13",
        fp: "dbbbf1891a47",
        trace: "../../etc/passwd",
        kind: "res",
        gz: false,
      }),
    ).toThrow();
    expect(() =>
      dashcamBlobPath(ROOT, {
        date: "2026-11-13",
        fp: "../x",
        trace: "0123456789abcdef",
        kind: "res",
        gz: false,
      }),
    ).toThrow();
  });
});

describe("日期枚举", () => {
  it("按东八区自然日、倒序返回", () => {
    const start = epoch("2026-11-11T00:00:00+08:00");
    const end = epoch("2026-11-14T00:00:00+08:00");
    expect(listIndexDates(start, end, 31)).toEqual(["2026-11-13", "2026-11-12", "2026-11-11"]);
  });

  it("左闭右开：end 当天 00:00 不计入", () => {
    const start = epoch("2026-11-12T23:00:00+08:00");
    const end = epoch("2026-11-13T00:00:00+08:00");
    expect(listIndexDates(start, end, 31)).toEqual(["2026-11-12"]);
  });

  it("超过窗口上限直接报错，不静默截断", () => {
    const start = epoch("2026-11-01T00:00:00+08:00");
    const end = epoch("2026-11-10T00:00:00+08:00");
    expect(() => listIndexDates(start, end, 5)).toThrow(DashcamQueryError);
  });

  it("dashcamDateOf 使用东八区", () => {
    expect(dashcamDateOf(epoch("2026-11-13T00:30:00+08:00"))).toBe("2026-11-13");
    expect(dashcamDateOf(epoch("2026-11-12T23:30:00+08:00"))).toBe("2026-11-12");
  });
});
