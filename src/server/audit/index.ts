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
import type {
  AuditConversationRow,
  AuditIndexEntry,
  AuditSessionRow,
  AuditThreadTurn,
} from "./types";

/** 单日索引缓存上限：超过则不缓存，避免大日文件把进程内 LRU 撑爆。 */
export const DEFAULT_INDEX_CACHE_MAX_ENTRIES = 20_000;
/** 单次请求最多扫描的索引行数（防御性上限，正常一天约 5.6k 行）。 */
export const MAX_SCAN_ENTRIES = 200_000;
/**
 * 聚合扫描的请求预算：一次性分组需要把窗口内的请求都读进来。
 * 2 万条约 10–15 MB 临时对象，是"能覆盖常见单日窗口"与"不把进程撑爆"之间的折中；
 * 超出时置 `partial` 让界面提示收窄范围（而不是静默给出不准的会话数）。
 */
export const MAX_GROUP_SCAN_REQUESTS = 10_000;
/** 单条线程最多返回的轮次数（再长只保留最近一段，避免一次读上千个 blob） */
export const MAX_THREAD_TURNS = 200;
/** 会话键哈希：16 位小写十六进制（采集侧 `sha256(key)[:16]`） */
const SESSION_KEY_PATTERN = /^[0-9a-f]{16}$/;
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
  const sessionKey = toText(record.k);
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
    ...(SESSION_KEY_PATTERN.test(sessionKey) ? { k: sessionKey } : {}),
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
    ...(entry.k === undefined ? {} : { sessionKey: entry.k }),
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
  /** 只取某个会话键下的请求（线程详情用） */
  sessionKey?: string;
  limit: number;
  /** 跳过前 N 条命中行（翻页用；与 cursor 二选一，给了 cursor 时忽略） */
  offset?: number;
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
  /** 已跳过的命中行数（offset 翻页回显；无 offset 时为 0） */
  skipped: number;
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
  if (input.sessionKey !== undefined && entry.k !== input.sessionKey) return false;
  if (input.model !== undefined && entry.m !== input.model) return false;
  if (input.status !== undefined && entry.s !== input.status) return false;
  if (input.failedOnly === true && entry.s < 400) return false;
  if (input.stream !== undefined && entry.st !== input.stream) return false;
  return true;
}

/**
 * 跨日扫描：日期倒序、日内按 `d` 倒序 + `t` 升序。
 *
 * 翻页两种入口：
 * - `offset`（界面翻页，主用）：跳过前 N 条命中行；
 * - `cursor`（兼容保留）：按毫秒时间戳 + trace + 指纹定位，避免新写入导致漂移。
 *
 * 返回 `limit + 1` 条用于判断"是否还有更多"，实际返回 `limit` 条。
 */
export async function scanSessions(input: ScanInput): Promise<ScanResult> {
  const dates = listIndexDates(input.start, input.end, input.maxDays);
  const rows: AuditSessionRow[] = [];
  const scannedDates: string[] = [];
  let unmatched = 0;
  let scanned = 0;
  let skipped = 0;
  let hitScanCap = false;
  const offset = input.offset ?? 0;

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
      if (skipped < offset) {
        skipped += 1;
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

  return { rows: page, nextCursor, scannedDates, unmatched, hasMore, skipped };
}

/* ------------------------------------------------------------------ */
/* 会话聚合                                                            */
/* ------------------------------------------------------------------ */

/**
 * 请求行 → 会话行。同一 `(指纹, 会话键)` 合并；没有会话键的请求各自成行。
 * 输入按时间倒序（scanSessions 的输出顺序），因此首条即最新一条。
 */
export function groupConversations(rows: AuditSessionRow[]): AuditConversationRow[] {
  const groups = new Map<string, {
    row: AuditConversationRow;
    models: Set<string>;
  }>();

  for (const item of rows) {
    const key = item.sessionKey === undefined ? `req:${item.date}:${item.traceId}` : `${item.fp}:${item.sessionKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        models: new Set(item.model === "" ? [] : [item.model]),
        row: {
          ...(item.sessionKey === undefined ? {} : { sessionKey: item.sessionKey }),
          fingerprint: item.fp,
          firstEpoch: item.startedAtEpoch,
          lastEpoch: item.startedAtEpoch,
          requestCount: 1,
          models: [],
          failedCount: item.status >= 400 ? 1 : 0,
          truncatedCount: (item.requestTruncated ? 1 : 0) + (item.responseTruncated ? 1 : 0),
          totalRequestBytes: item.requestBytes,
          totalResponseBytes: item.responseBytes,
          last: item,
        },
      });
      continue;
    }

    const group = existing.row;
    group.requestCount += 1;
    group.totalRequestBytes += item.requestBytes;
    group.totalResponseBytes += item.responseBytes;
    if (item.status >= 400) group.failedCount += 1;
    if (item.requestTruncated) group.truncatedCount += 1;
    if (item.responseTruncated) group.truncatedCount += 1;
    if (item.model !== "") existing.models.add(item.model);
    if (item.startedAtEpoch < group.firstEpoch) group.firstEpoch = item.startedAtEpoch;
  }

  return [...groups.values()]
    .map((entry) => ({ ...entry.row, models: [...entry.models] }))
    .sort((a, b) => (b.lastEpoch - a.lastEpoch) || (a.last.traceId < b.last.traceId ? -1 : 1));
}

export interface ConversationScanResult {
  conversations: AuditConversationRow[];
  /** 扫描范围内分组后的会话总数（与分页无关） */
  total: number;
  /**
   * 是否因扫描预算只覆盖了部分请求。
   * true 表示 `total` 偏小，界面要提示"请缩小范围或按日期收窄"。
   */
  partial: boolean;
  scannedDates: string[];
  unmatched: number;
  hasMore: boolean;
}

/**
 * 按会话聚合的分页：**先全量分组、再按 offset 切片**。
 *
 * 为什么不能按请求翻页：分组键是「会话最后活动时间」，而 cursor 定位的是单条请求时间。
 * 同一会话的请求可能横跨很宽的时间段，用请求级 cursor 翻页会让该会话以更早的
 * 最后活动时间在下一页重复出现。只有先分组再切片，翻页才稳定、不重不漏。
 *
 * 成本：每翻一页都重扫一遍索引（索引本身有 30s 进程内缓存，命中后是内存操作），
 * 因此用 `MAX_GROUP_SCAN_REQUESTS` 兜底，超出时置 `partial`。
 */
export async function scanConversations(input: ScanInput): Promise<ConversationScanResult> {
  const scan = await scanSessions({
    ...input,
    offset: 0,
    cursor: undefined,
    limit: MAX_GROUP_SCAN_REQUESTS,
  });
  const groups = groupConversations(scan.rows);
  const offset = input.offset ?? 0;
  const page = groups.slice(offset, offset + input.limit);

  return {
    conversations: page,
    total: groups.length,
    partial: scan.hasMore,
    scannedDates: scan.scannedDates,
    unmatched: scan.unmatched,
    hasMore: offset + input.limit < groups.length || scan.hasMore,
  };
}

/* ------------------------------------------------------------------ */
/* 线程（一个会话键下的全部请求）                                      */
/* ------------------------------------------------------------------ */

export interface ThreadScanInput {
  dir: string;
  sessionKey: string;
  /** 该用户的指纹集合：会话键是用户可控的，必须再用指纹收口 */
  fingerprints: ReadonlySet<string>;
  start: number;
  end: number;
  maxDays: number;
}

export interface ThreadScanResult {
  turns: AuditThreadTurn[];
  fingerprints: string[];
  total: number;
  truncated: boolean;
  scannedDates: string[];
}

/**
 * 扫出某会话键下的全部请求，按时间**升序**排列。
 *
 * 只读索引、不打开 blob：线程首屏的成本与列表同阶。
 * 会话键由用户自带（`prompt_cache_key` 等），所以必须叠加指纹过滤，
 * 否则知道键就能读到别人的会话。
 */
export async function scanThread(input: ThreadScanInput): Promise<ThreadScanResult> {
  if (!SESSION_KEY_PATTERN.test(input.sessionKey)) {
    throw new AuditQueryError("会话键不合法", [{ path: "sessionKey", message: "会话键必须是 16 位小写十六进制" }]);
  }
  const dates = listIndexDates(input.start, input.end, input.maxDays);
  const scannedDates: string[] = [];
  const hits: Array<{ entry: AuditIndexEntry; date: string; at: number }> = [];
  const fingerprints = new Set<string>();

  for (const date of dates) {
    const day = await readIndexDay(input.dir, date);
    if (!day.exists) continue;
    scannedDates.push(date);
    for (const entry of day.entries) {
      if (entry.k !== input.sessionKey) continue;
      if (!input.fingerprints.has(entry.u)) continue;
      const at = entryEpochMillis(entry);
      if (at < input.start * 1000 || at >= input.end * 1000) continue;
      fingerprints.add(entry.u);
      hits.push({ entry, date, at });
    }
  }

  hits.sort((a, b) => (a.at - b.at) || (a.entry.t < b.entry.t ? -1 : a.entry.t > b.entry.t ? 1 : 0));
  const total = hits.length;
  const kept = total > MAX_THREAD_TURNS ? hits.slice(total - MAX_THREAD_TURNS) : hits;

  const turns: AuditThreadTurn[] = kept.map(({ entry, date, at }, position) => {
    const previous = position === 0 ? undefined : kept[position - 1];
    return {
      index: position + 1,
      sessionKey: input.sessionKey,
      fingerprint: entry.u,
      date,
      traceId: entry.t,
      startedAt: entry.d,
      startedAtEpoch: Math.floor(at / 1000),
      model: entry.m,
      status: entry.s,
      stream: entry.st,
      durationMs: entry.ms,
      firstTokenMs: entry.ft,
      path: entry.p,
      requestBytes: entry.rq,
      responseBytes: entry.rs,
      requestTruncated: (entry.tr & 1) === 1,
      responseTruncated: (entry.tr & 2) === 2,
      gzip: { request: entry.qz, response: entry.rz },
      prev: previous === undefined ? null : { traceId: previous.entry.t, date: previous.date },
    };
  });

  return { turns, fingerprints: [...fingerprints], total, truncated: total > kept.length, scannedDates };
}
