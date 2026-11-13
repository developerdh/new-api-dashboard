import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCache } from "@/server/cache";
import {
  decodeCursor,
  encodeCursor,
  parseIndexLine,
  parseIndexText,
  scanSessions,
} from "@/server/audit/index";

const FP_A = "dbbbf1891a47";
const FP_B = "aaaaaaaaaaaa";
const T1 = "0123456789abcdef0123456789abcdef";
const T2 = "fedcba9876543210fedcba9876543210";
const T3 = "11111111111111111111111111111111";

function entry(trace: string, fp: string, iso: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: trace,
    u: fp,
    d: iso,
    p: "/v1/chat/completions",
    m: "gpt-4o-mini",
    s: 200,
    st: false,
    ms: 12,
    ft: 10,
    rq: 100,
    rs: 200,
    qz: false,
    rz: false,
    tr: 0,
    ip: "127.0.0.1",
    ...extra,
  });
}

let dir = "";

beforeEach(async () => {
  clearCache();
  dir = await mkdtemp(join(tmpdir(), "audit-index-"));
  await mkdir(join(dir, "index"), { recursive: true });
  const lines = [
    entry(T1, FP_A, "2026-11-13T09:00:00+08:00"),
    entry(T2, FP_A, "2026-11-13T10:00:00+08:00", { st: true, s: 503, m: "gpt-4o" }),
    entry(T3, FP_B, "2026-11-13T11:00:00+08:00"),
    "{broken json",
    // 末尾半行：模拟正在追加
    '{"t":"22222222222222222222222222222222","u":"'+FP_A+'","d":"2026-11-13T12:00:00+08:00"',
  ];
  await writeFile(join(dir, "index", "2026-11-13.ndjson"), lines.join("\n"), "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  clearCache();
});

const START = Math.floor(Date.parse("2026-11-13T00:00:00+08:00") / 1000);
const END = Math.floor(Date.parse("2026-11-14T00:00:00+08:00") / 1000);

function scan(overrides: Partial<Parameters<typeof scanSessions>[0]> = {}) {
  return scanSessions({
    dir,
    start: START,
    end: END,
    maxDays: 31,
    fingerprints: new Set([FP_A]),
    knownFingerprints: new Set([FP_A, FP_B]),
    limit: 50,
    ...overrides,
  });
}

describe("索引解析", () => {
  it("单行解析：合法行保留，坏行返回 null", () => {
    const parsed = parseIndexLine(entry(T1, FP_A, "2026-11-13T09:00:00+08:00"));
    expect(parsed?.t).toBe(T1);
    expect(parsed?.tr).toBe(0);
    expect(parseIndexLine("{oops")).toBeNull();
    expect(parseIndexLine(JSON.stringify({ t: "short", u: FP_A, d: "x" }))).toBeNull();
  });

  it("整份文本：坏行计数、末尾半行丢弃", () => {
    const result = parseIndexText(
      [entry(T1, FP_A, "2026-11-13T09:00:00+08:00"), "{bad", '{"t":"abc"'].join("\n"),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.badLines).toBe(1);
    expect(result.partialTail).toBe(true);
  });
});

describe("scanSessions", () => {
  it("只返回目标用户的条目，按时间倒序", async () => {
    const result = await scan();
    expect(result.rows.map((row) => row.traceId)).toEqual([T2, T1]);
    expect(result.scannedDates).toEqual(["2026-11-13"]);
  });

  it("统计无法归属任何用户的指纹", async () => {
    const result = await scan({ knownFingerprints: new Set([FP_A]) });
    expect(result.unmatched).toBe(1);
  });

  it("按形态 / 状态 / 模型过滤", async () => {
    expect((await scan({ stream: true })).rows.map((r) => r.traceId)).toEqual([T2]);
    expect((await scan({ failedOnly: true })).rows.map((r) => r.traceId)).toEqual([T2]);
    expect((await scan({ status: 200 })).rows.map((r) => r.traceId)).toEqual([T1]);
    expect((await scan({ model: "gpt-4o" })).rows.map((r) => r.traceId)).toEqual([T2]);
  });

  it("cursor 翻页不重复、不丢行", async () => {
    const first = await scan({ limit: 1 });
    expect(first.rows.map((r) => r.traceId)).toEqual([T2]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.hasMore).toBe(true);

    const second = await scan({ limit: 1, cursor: decodeCursor(first.nextCursor ?? "") });
    expect(second.rows.map((r) => r.traceId)).toEqual([T1]);
    expect(second.nextCursor).toBeNull();
  });

  it("cursor 编解码稳定（毫秒精度）", () => {
    const at = Date.parse("2026-11-13T10:00:00.123+08:00");
    const encoded = encodeCursor({ at, trace: T1, fp: FP_A });
    expect(decodeCursor(encoded)).toEqual({ at, trace: T1, fp: FP_A });
    expect(() => decodeCursor("!!!")).toThrow();
  });

  it("日索引缺失时返回空结果而不报错", async () => {
    const result = await scan({
      start: Math.floor(Date.parse("2026-11-10T00:00:00+08:00") / 1000),
      end: Math.floor(Date.parse("2026-11-11T00:00:00+08:00") / 1000),
    });
    expect(result.rows).toEqual([]);
    expect(result.scannedDates).toEqual([]);
  });
});
