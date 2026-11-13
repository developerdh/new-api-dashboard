/**
 * 调用方指纹 → 用户的反查（只读数据库）。
 *
 * 为什么不在 `src/server/audit/`：那是纯文件读取层，必须与 `getDb()` 完全隔离。
 * 这里只做一件事：把 `tokens.key` 用与代理**完全相同**的算法重算成 12 位指纹，
 * 得到 `指纹 → {token_id, user_id}` 映射。
 *
 * 算法一致性（实测，见 `05-dashboard-plan.md` §0）：
 *   代理：`sha256(strings.TrimSpace(Authorization))[:12]`
 *   这里：`sha256(prefix + key)[:12]`，prefix 默认 `Bearer sk-`
 *   测试机实测：`tokens.id=1 / user_id=1` → `dbbbf1891a47`，与索引 `u`、目录名一致。
 *
 * 安全：`key` 只在函数内参与哈希，**不出作用域、不进日志、不进响应**；
 * 对外只暴露 12 位指纹（不可逆，也不含密钥信息）。
 */
import { createHash } from "node:crypto";

import { sql } from "kysely";

import { getCache } from "@/server/cache";
import { getDb, type ReadOnlyDatabase } from "@/server/db";

/** 与代理实际看到的 Authorization 头保持一致（`tokens.key` 不含 `sk-`）。 */
export const DEFAULT_TOKEN_HEADER_PREFIX = "Bearer sk-";

/** 成功结果缓存 60s；失败结果缓存 5 分钟，避免每次请求都打一次无权限查询。 */
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 300_000;
const CACHE_KEY = "audit:tokens:fingerprints";

export type TokenLookupError = "permission_denied" | "unavailable";

export interface TokenFingerprintPair {
  tokenId: number;
  userId: number;
  /** `sha256(prefix + key)[:12]` */
  fp: string;
}

export interface TokenFingerprintIndex {
  byFp: Map<string, { tokenId: number; userId: number }>;
  byUser: Map<number, string[]>;
  /**
   * 是否成功读到 `tokens` 表。
   * false 时列表不报错，改为 `fingerprintCount: 0` + `lookupError`，界面给解释。
   */
  ok: boolean;
  error?: TokenLookupError;
}

interface TokenRow {
  id: number;
  user_id: number;
  key: string;
}

/**
 * 前缀可配：换 header 形态（如 `x-api-key`）时不需要改代码。
 * 刻意 **不 trim**：前缀属于协议字节，多一个空格就该对不上。
 */
export function tokenHeaderPrefix(): string {
  const raw = process.env.AUDIT_TOKEN_HEADER_PREFIX;
  return raw === undefined ? DEFAULT_TOKEN_HEADER_PREFIX : raw;
}

/** 与 `audit-proxy/capture.go` 的 `tokenFingerprint` 同构。 */
export function fingerprintOfKey(key: string, prefix: string = tokenHeaderPrefix()): string {
  return createHash("sha256").update(`${prefix}${key}`, "utf8").digest("hex").slice(0, 12);
}

/** 纯函数：行 → 指纹对（便于单测，不碰缓存与连接池）。 */
export function buildFingerprintPairs(
  rows: readonly TokenRow[],
  prefix: string = tokenHeaderPrefix(),
): TokenFingerprintPair[] {
  const seen = new Set<string>();
  const pairs: TokenFingerprintPair[] = [];
  for (const row of rows) {
    const key = typeof row.key === "string" ? row.key : "";
    if (key === "") continue;
    const fp = fingerprintOfKey(key, prefix);
    // 48 bit 碰撞概率极低，但真撞上时不能把两条 token 混为一谈
    if (seen.has(fp)) continue;
    seen.add(fp);
    pairs.push({ tokenId: Number(row.id), userId: Number(row.user_id), fp });
  }
  return pairs;
}

export function buildFingerprintIndex(pairs: readonly TokenFingerprintPair[]): TokenFingerprintIndex {
  const byFp = new Map<string, { tokenId: number; userId: number }>();
  const byUser = new Map<number, string[]>();
  for (const pair of pairs) {
    byFp.set(pair.fp, { tokenId: pair.tokenId, userId: pair.userId });
    const list = byUser.get(pair.userId);
    if (list === undefined) byUser.set(pair.userId, [pair.fp]);
    else list.push(pair.fp);
  }
  return { byFp, byUser, ok: true };
}

function classifyError(error: unknown): TokenLookupError {
  const message = error instanceof Error ? error.message : String(error);
  return /permission denied|insufficient privilege/i.test(message)
    ? "permission_denied"
    : "unavailable";
}

interface CachedFailure {
  ok: false;
  error: TokenLookupError;
}

function isFailure(value: unknown): value is CachedFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

/**
 * 读取全部 token 指纹（含软删除行：历史请求仍属于该用户）。
 * 一次查询、进程内缓存；失败降级不抛错。
 */
export async function loadTokenFingerprints(
  db: ReadOnlyDatabase = getDb(),
): Promise<TokenFingerprintIndex> {
  const cache = getCache();
  const cached = cache.get(CACHE_KEY);
  if (isFailure(cached)) return { byFp: new Map(), byUser: new Map(), ok: false, error: cached.error };
  if (cached !== undefined) {
    return buildFingerprintIndex(cached as TokenFingerprintPair[]);
  }

  try {
    const { rows } = await sql<TokenRow>`
      select id, user_id, key
      from tokens
      where key is not null
    `.execute(db);
    const pairs = buildFingerprintPairs(rows);
    cache.set(CACHE_KEY, pairs, { ttl: SUCCESS_TTL_MS });
    return buildFingerprintIndex(pairs);
  } catch (error) {
    const failure: CachedFailure = { ok: false, error: classifyError(error) };
    cache.set(CACHE_KEY, failure, { ttl: FAILURE_TTL_MS });
    return { byFp: new Map(), byUser: new Map(), ok: false, error: failure.error };
  }
}

/** 某用户的指纹集合（无 token 时为空集合）。 */
export function fingerprintsOfUser(index: TokenFingerprintIndex, userId: number): Set<string> {
  return new Set(index.byUser.get(userId) ?? []);
}

/** 仅供测试：清空指纹缓存。 */
export function clearTokenFingerprintCache(): void {
  getCache().delete(CACHE_KEY);
}
