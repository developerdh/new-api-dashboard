/**
 * 索引读取与列表扫描（`index/<date>.ndjson`）。
 *
 * 只读索引、不打开任何 blob：列表页的成本是「按天顺序扫描一个约 1.1 MB 的文件」。
 *
 * 韧性设计：
 * - 单行容错：坏行只计数，不影响其余行（`O_APPEND` 追加，进程崩溃可能留半行）；
 * - 末尾半行：文件不以 `\n` 结尾时丢弃最后一段（正在写入中）；
 * - 早停：命中 `limit + 1` 条即停，避免把整月索引读完；
 * - cursor 而非 offset：索引按天追加，offset 会因新数据漂移。
 */
import { readFile } from "node:fs/promises";

import { getCache } from "@/server/cache";

import { detectProtocol } from "./normalize";
import {
  AUDIT_DATE_PATTERN,
  AuditQueryError,
  FINGERPRINT_PATTERN,
  TRACE_PATTERN,
  auditIndexPath,
  listIndexDates,
} from "./paths";
import type { AuditIndexEntry, AuditSessionRow } from "./types";

/** 单日索引缓存上限：超过则不缓存，避免大日文件把进程内 LRU 撑爆。 */
export const DEFAULT_INDEX_CACHE_MAX_ENTRIES = 20_000;
/** 单次请求最多扫描的索引行数（防御性上限，正常一天约 5.6k 行）。 */
export const MAX_SCAN_ENTRIES = 200_000;
/** 索引解析结果缓存 TTL 下限/上限（毫秒）。 */
const MIN_CACHE_TTL_MS = 1_000;
const MAX_CACHE_TTL_MS = 300_000;

export interface ReadIndexResult {
  entries: AuditIndexEntry[];
  /** 解析失败的行数 */
  badLines: number;
  /** 是否丢弃了未写完的末尾半行 */
  partialTail: boolean;
  /** 文件是否存在（日目录缺失属正常情况） */
  exists: boolean;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function auditCacheTtlMs(): number {
  return envInt("AUDIT_CACHE_TTL_MS", 30_000, MIN_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
}

export function auditIndexCacheMaxEntries(): number {
  return envInt(
    "AUDIT_INDEX_CACHE_MAX_ENTRIES",
    DEFAULT_INDEX_CACHE_MAX_ENTRIES,
    0,
    1_000_000,
  );
}

function toInt(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 行 → 索引条目。字段缺失/类型异常的行直接丢弃（返回 null），
 * 因为一条坏行不值得让整个列表 500。
 */
export function parseIndexLine(line: string): AuditIndexEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const trace = toText(record.t);
  const fp = toText(record.u);
  const startedAt = toText(record.d);
  if (!TRACE_PATTERN.test(trace)) return null;
  if (!FINGERPRINT_PATTERN.test(fp)) return null;
  if (startedAt === "" || Number.isNaN(Date.parse(startedAt))) return null;

  return {
    t: trace,
    u: fp,
    d: startedAt,
    p: toText(record.p),
    m: toText(record.m),
    s: toInt(record.s),
    st: record.st === true,
    ms: toInt(record.ms),
    ft: toInt(record.ft),
    rq: toInt(record.rq),
    rs: toInt(record.rs),
    qz: record.qz === true,
    rz: record.rz === true,
    tr: toInt(record.tr),
    ...(toText(record.e) === "" ? {} : { e: toText(record.e) }),
    ...(toText(record.ip) === "" ? {} : { ip: toText(record.ip) }),
  };
}

/** 解析整份 NDJSON；末尾半行丢弃并标记，坏行计数。 */
export function parseIndexText(text: string): Omit<ReadIndexResult, "exists"> {
  const entries: AuditIndexEntry[] = [];
  let badLines = 0;
  let partialTail = false;

  const chunks = text.split("\n");
  const lastChunk = chunks.pop() ?? "";
  if (lastChunk !== "") partialTail = true; // 未以换行结尾 → 正在写入，丢弃

  for (const chunk of chunks) {
    const line = chunk.trim();
    if (line === "") continue;
    const entry = parseIndexLine(line);
    if (entry === null) {
      badLines += 1;
      continue;
    }
    entries.push(entry);
  }

  return { entries, badLines, partialTail };
}

/** 读某天的索引（带进程内短 TTL 缓存；文件不存在返回空结果而不报错）。 */
export async function readIndexDay(dir: string, date: string): Promise<ReadIndexResult> {
  if (!AUDIT_DATE_PATTERN.test(date)) throw new AuditQueryError("非法索引日期");
  const cache = getCache();
  // key 里带 dir：同一进程内切换 AUDIT_DIR（测试、灰度副本）不会互相串数据
  const cacheKey = `audit:index:${dir}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached as ReadIndexResult;

  let text: string;
  try {
    text = await readFile(auditIndexPath(dir, date), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const empty: ReadIndexResult = {
        entries: [],
        badLines: 0,
        partialTail: false,
        exists: false,
      };
      cache.set(cacheKey, empty, { ttl: auditCacheTtlMs() });
      return empty;
    }
    throw error;
  }

  const result: ReadIndexResult = { ...parseIndexText(text), exists: true };
  if (result.entries.length <= auditIndexCacheMaxEntries()) {
    cache.set(cacheKey, result, { ttl: auditCacheTtlMs() });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* cursor                                                              */
/* ------------------------------------------------------------------ */

export interface AuditCursor {
  /** 毫秒时间戳（索引 `d` 为 RFC3339Nano，秒级会把同一秒的多条压成并列） */
  at: number;
  trace: string;
  fp: string;
}

/** cursor：`base64url(JSON)`，不需要客户端理解。 */
export function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(
    JSON.stringify({ a: cursor.at, t: cursor.trace, u: cursor.fp }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(raw: string): AuditCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AuditQueryError("游标不合法", [{ path: "cursor", message: "无法解析游标" }]);
  }
  if (typeof value !== "object" || value === null) {
    throw new AuditQueryError("游标不合法", [{ path: "cursor", message: "无法解析游标" }]);
  }
  const record = value as Record<string, unknown>;
  const at = toInt(record.a, -1);
  const trace = toText(record.t);
  const fp = toText(record.u);
  if (at < 0 || !TRACE_PATTERN.test(trace) || !FINGERPRINT_PATTERN.test(fp)) {
    throw new AuditQueryError("游标不合法", [{ path: "cursor", message: "游标字段非法" }]);
  }
  return { at, trace, fp };
}

function isAfterCursor(at: number, trace: string, fp: string, cursor: AuditCursor): boolean {
  if (at !== cursor.at) return at < cursor.at;
  if (trace !== cursor.trace) return trace > cursor.trace;
  return fp > cursor.fp;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

export function entryEpochMillis(entry: AuditIndexEntry): number {
  const parsed = Date.parse(entry.d);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function entryEpochSeconds(entry: AuditIndexEntry): number {
  return Math.floor(entryEpochMillis(entry) / 1000);
}

export function toSessionRow(entry: AuditIndexEntry, date: string): AuditSessionRow {
  return {
    traceId: entry.t,
    fp: entry.u,
    date,
    startedAt: entry.d,
    startedAtEpoch: entryEpochSeconds(entry),
    path: entry.p,
    protocol: detectProtocol(entry.p),
    model: entry.m,
    status: entry.s,
    stream: entry.st,
    durationMs: entry.ms,
    firstTokenMs: entry.ft,
    requestBytes: entry.rq,
    responseBytes: entry.rs,
    requestTruncated: (entry.tr & 1) === 1,
    responseTruncated: (entry.tr & 2) === 2,
    gzip: { request: entry.qz, response: entry.rz },
    ...(entry.e === undefined ? {} : { error: entry.e }),
    ...(entry.ip === undefined ? {} : { ip: entry.ip }),
  };
}

export interface ScanInput {
  dir: string;
  start: number;
  end: number;
  maxDays: number;
  /** 该用户的指纹集合（命中即归属） */
  fingerprints: ReadonlySet<string>;
  /** 全部可归属指纹（用于统计"无法归属"的条数） */
  knownFingerprints: ReadonlySet<string>;
  model?: string;
  status?: number;
  failedOnly?: boolean;
  stream?: boolean;
  limit: number;
  cursor?: AuditCursor;
}

export interface ScanResult {
  rows: AuditSessionRow[];
  nextCursor: string | null;
  scannedDates: string[];
  /** 已扫描日期内、指纹无法归属任何用户的条数（不受分页早停影响） */
  unmatched: number;
  /** 是否还有更多（命中 limit+1、或触达扫描上限） */
  hasMore: boolean;
}

function compareDesc(
  a: { entry: AuditIndexEntry; at: number },
  b: { entry: AuditIndexEntry; at: number },
): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.entry.t !== b.entry.t) return a.entry.t < b.entry.t ? -1 : 1;
  if (a.entry.u !== b.entry.u) return a.entry.u < b.entry.u ? -1 : 1;
  return 0;
}

function matchesFilters(entry: AuditIndexEntry, input: ScanInput): boolean {
  if (input.model !== undefined && entry.m !== input.model) return false;
  if (input.status !== undefined && entry.s !== input.status) return false;
  if (input.failedOnly === true && entry.s < 400) return false;
  if (input.stream !== undefined && entry.st !== input.stream) return false;
  return true;
}

/**
 * 跨日扫描：日期倒序、日内按 `d` 倒序 + `t` 升序。
 * 返回 `limit + 1` 条用于判断"是否还有更多"，实际返回 `limit` 条。
 */
export async function scanSessions(input: ScanInput): Promise<ScanResult> {
  const dates = listIndexDates(input.start, input.end, input.maxDays);
  const rows: AuditSessionRow[] = [];
  const scannedDates: string[] = [];
  let unmatched = 0;
  let scanned = 0;
  let hitScanCap = false;

  outer: for (const date of dates) {
    const day = await readIndexDay(input.dir, date);
    if (!day.exists) continue;
    scannedDates.push(date);

    const ordered = day.entries
      .map((entry) => ({ entry, at: entryEpochMillis(entry) }))
      .filter(({ at }) => at >= input.start * 1000 && at < input.end * 1000)
      .sort(compareDesc);

    // 整日统计"无法归属"的条数：不受分页早停影响，避免小页时永远显示 0
    for (const { entry } of ordered) {
      if (!input.knownFingerprints.has(entry.u)) unmatched += 1;
    }

    for (const { entry, at } of ordered) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) {
        hitScanCap = true;
        break outer;
      }
      if (!input.fingerprints.has(entry.u)) continue;
      if (!matchesFilters(entry, input)) continue;
      if (input.cursor !== undefined && !isAfterCursor(at, entry.t, entry.u, input.cursor)) {
        continue;
      }
      rows.push(toSessionRow(entry, date));
      if (rows.length > input.limit) break outer;
    }
  }

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  const hasMore = rows.length > input.limit || hitScanCap;
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ at: Date.parse(last.startedAt), trace: last.traceId, fp: last.fp })
      : null;

  return { rows: page, nextCursor, scannedDates, unmatched, hasMore };
}
