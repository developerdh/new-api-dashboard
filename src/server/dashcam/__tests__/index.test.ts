import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCache } from "@/server/cache";
import {
  decodeCursor,
  encodeCursor,
  groupConversations,
  parseIndexLine,
  parseIndexText,
  scanConversations,
  scanSessions,
  scanThread,
} from "@/server/dashcam/index";
import type { DashcamSessionRow } from "@/server/dashcam/types";

const FP_A = "dbbbf1891a47";
const FP_B = "aaaaaaaaaaaa";
const T1 = "0123456789abcdef0123456789abcdef";
const T2 = "fedcba9876543210fedcba9876543210";
const T3 = "11111111111111111111111111111111";
/** 会话键哈希（16 位十六进制） */
const S1 = "0123456789abcdef";
const S2 = "fedcba9876543210";

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
  dir = await mkdtemp(join(tmpdir(), "dashcam-index-"));
  await mkdir(join(dir, "index"), { recursive: true });
  const lines = [
    entry(T1, FP_A, "2026-11-13T09:00:00+08:00", { k: S1 }),
    entry(T2, FP_A, "2026-11-13T10:00:00+08:00", { st: true, s: 503, m: "gpt-4o", k: S1 }),
    entry(T3, FP_B, "2026-11-13T11:00:00+08:00", { k: S2 }),
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

  it("offset 翻页：跳过的条数不重复出现在下一页", async () => {
    const first = await scan({ limit: 1 });
    expect(first.rows.map((r) => r.traceId)).toEqual([T2]);
    expect(first.skipped).toBe(0);

    const second = await scan({ limit: 1, offset: 1 });
    expect(second.rows.map((r) => r.traceId)).toEqual([T1]);
    expect(second.skipped).toBe(1);
    expect(second.hasMore).toBe(false);
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

describe("会话聚合", () => {
  it("同指纹同会话键合并，缺键的请求独立成行", () => {
    const rows: DashcamSessionRow[] = [
      { traceId: T2, fp: FP_A, date: "2026-11-13", sessionKey: S1, startedAtEpoch: 200, model: "gpt-4o" },
      { traceId: T1, fp: FP_A, date: "2026-11-13", sessionKey: S1, startedAtEpoch: 100, model: "gpt-4o-mini" },
      { traceId: T3, fp: FP_B, date: "2026-11-13", model: "gemini", startedAtEpoch: 150 },
    ].map((item) => ({
      path: "/v1/chat/completions",
      protocol: "openai-chat" as const,
      status: 200,
      stream: false,
      durationMs: 1,
      firstTokenMs: 1,
      requestBytes: 10,
      responseBytes: 20,
      requestTruncated: false,
      responseTruncated: false,
      gzip: { request: false, response: false },
      startedAt: "",
      ...item,
    }));

    const groups = groupConversations(rows);
    expect(groups).toHaveLength(2);

    const merged = groups.find((group) => group.sessionKey === S1);
    expect(merged?.requestCount).toBe(2);
    expect(merged?.last.traceId).toBe(T2); // 输入已按倒序，首条即最新
    expect(merged?.models.sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(merged?.firstEpoch).toBe(100);

    const single = groups.find((group) => group.sessionKey === undefined);
    expect(single?.requestCount).toBe(1);
    expect(single?.fingerprint).toBe(FP_B);
  });

  it("scanConversations 全量分组后切片，能给出准确的会话总数", async () => {
    const result = await scanConversations({
      dir,
      start: START,
      end: END,
      maxDays: 31,
      fingerprints: new Set([FP_A]),
      knownFingerprints: new Set([FP_A, FP_B]),
      limit: 5,
    });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.requestCount).toBe(2);
    expect(result.conversations[0]?.last.traceId).toBe(T2);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.partial).toBe(false);
  });

  it("scanConversations 用 offset 翻页：第二页为空而不是重复第一页", async () => {
    const first = await scanConversations({
      dir,
      start: START,
      end: END,
      maxDays: 31,
      fingerprints: new Set([FP_A]),
      knownFingerprints: new Set([FP_A, FP_B]),
      limit: 1,
    });
    expect(first.conversations).toHaveLength(1);
    expect(first.hasMore).toBe(false);

    const second = await scanConversations({
      dir,
      start: START,
      end: END,
      maxDays: 31,
      fingerprints: new Set([FP_A]),
      knownFingerprints: new Set([FP_A, FP_B]),
      limit: 1,
      offset: 1,
    });
    expect(second.conversations).toHaveLength(0);
    expect(second.total).toBe(1);
  });
});

describe("scanThread", () => {
  // 必须是函数：`dir` 由 beforeEach 每次重建，describe 体里取值会拿到空串
  const base = () => ({
    dir,
    sessionKey: S1,
    fingerprints: new Set([FP_A]),
    start: START,
    end: END,
    maxDays: 31,
  });

  it("按时间升序返回，并串上上一轮定位", async () => {
    const thread = await scanThread(base());
    expect(thread.turns.map((turn) => turn.traceId)).toEqual([T1, T2]);
    expect(thread.turns[0]?.prev).toBeNull();
    expect(thread.turns[1]?.prev).toEqual({ traceId: T1, date: "2026-11-13" });
    expect(thread.turns[1]?.index).toBe(2);
    expect(thread.total).toBe(2);
    expect(thread.truncated).toBe(false);
    expect(thread.fingerprints).toEqual([FP_A]);
  });

  it("会话键必须配合指纹，否则读不到别人的会话", async () => {
    const thread = await scanThread({ ...base(), fingerprints: new Set([FP_B]) });
    expect(thread.turns).toEqual([]);
  });

  it("非法会话键直接拒绝", async () => {
    await expect(scanThread({ ...base(), sessionKey: "NOT-A-KEY" })).rejects.toThrow();
  });
});
