/**
 * 沉默用户查询：上期活跃 ∩ 本期无消费 = 「上期活跃但本期沉默」的具体用户清单。
 *
 * 口径（与用户确认的方案一致）：
 * - 本期 = 全局筛选区间 `[start, end)`；上期 = **等长紧邻前一周期** `[start - (end-start), start)`；
 * - 活跃 = `logs.type = 2`（消费流水）且 `user_id` 非空；不依赖 quota_data（它有 ≤5 分钟延迟）；
 * - 集合差集在应用层完成：先分别取两个区间的 `user_id` 集合，再做差集，避免逐用户 NOT EXISTS；
 * - 账号取 `users.username`、昵称取 `users.display_name`；用户已删除/未匹配时返回空串，由前端兜底为「用户 N」；
 * - 排序按上期请求数降序、user_id 升序，输出受 limit 截断但 `total` 始终返回完整差集数量。
 *
 * 红线：只读（ReadOnlyDatabase）、参数化（Kysely 表达式）、数值 `::bigint` 交给 int8 解析器。
 * 注意：真实库 logs 保留约 97 天，上期超出保留期时结果会**偏少**（缺失的上期用户不会入选），
 * 不会产生「本期活跃却被判沉默」的假阳性。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";
import {
  EXCLUDE_STAT_USERS_SQL,
  LOG_TYPE_CONSUME,
  type QueryRange,
} from "@/server/queries/common";

/** 清单缺省 / 上限条数（上限与 `common.ts` 的 MAX_LIMIT 对齐）。 */
export const INACTIVE_DEFAULT_LIMIT = 100;
export const INACTIVE_MAX_LIMIT = 500;

/** 单次统计允许的最长本期区间：366 天（上期再回溯等长，避免大范围扫描撞 30s statement_timeout）。 */
export const INACTIVE_MAX_RANGE_SECONDS = 366 * 86_400;

/** 上期活跃聚合行（logs 按 user_id 分组）。 */
export interface PrevActiveRow {
  user_id: number;
  prev_request_count: number;
  last_active_at: number;
}

/** 本期活跃集合行（DISTINCT user_id）。 */
export interface CurrentActiveRow {
  user_id: number;
}

/** users 表名称行（含昵称）。 */
export interface InactiveNameRow {
  id: number;
  username: string | null;
  display_name: string | null;
}

/** 差集候选（尚未附带用户名）。 */
export interface InactiveCandidateRow {
  userId: number;
  lastActiveAt: number;
  prevRequestCount: number;
}

/** 响应行：用户名/昵称 + 最后活跃时间 + 上期请求数（详情链接由前端按 userId 拼）。 */
export interface InactiveUserRow extends InactiveCandidateRow {
  username: string;
  displayName?: string;
}

export interface InactiveUsersSnapshot {
  rows: InactiveUserRow[];
  /** 实际上期区间（Unix 秒，左闭右开），供前端展示与详情链接使用。 */
  prevRange: QueryRange;
  /** 上期活跃用户数（差集的分母）。 */
  prevActiveUsers: number;
  /** 沉默用户总数（不受 limit 截断）。 */
  total: number;
  /** rows 是否被 limit 截断。 */
  truncated: boolean;
}

function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return INACTIVE_DEFAULT_LIMIT;
  return Math.max(0, Math.min(Math.trunc(limit), INACTIVE_MAX_LIMIT));
}

/**
 * 上期区间：等长、紧邻、左闭右开。
 * `start` 早于一个区间长度时钳到 0（Unix 纪元），此时上期区间自然缩短。
 */
export function previousPeriod(range: QueryRange): QueryRange {
  const length = Math.max(1, range.end - range.start);
  return { start: Math.max(0, range.start - length), end: range.start };
}

/** 上期活跃聚合：请求数 + 最后一次消费时间。 */
export function buildPrevActiveQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select([
      "user_id",
      sql<number>`COUNT(*)::bigint`.as("prev_request_count"),
      sql<number>`MAX(created_at)::bigint`.as("last_active_at"),
    ])
    .where("type", "=", LOG_TYPE_CONSUME)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "is not", null)
    .groupBy("user_id");
}

/** 本期活跃集合：DISTINCT user_id，不聚合其它指标。 */
export function buildCurrentActiveQuery(db: ReadOnlyDatabase, range: QueryRange) {
  return db
    .selectFrom("logs")
    .where(EXCLUDE_STAT_USERS_SQL)
    .select("user_id")
    .distinct()
    .where("type", "=", LOG_TYPE_CONSUME)
    .where("created_at", ">=", range.start)
    .where("created_at", "<", range.end)
    .where("user_id", "is not", null);
}

/** 差集结果的账号 + 昵称补齐（仅对最终入选的 user_id 查 users，控制 IN 列表长度）。 */
export function buildInactiveNamesQuery(db: ReadOnlyDatabase, userIds: number[]) {
  return db
    .selectFrom("users")
    .select(["id", "username", "display_name"])
    .where("id", "in", userIds);
}

export interface InactiveSelection {
  rows: InactiveCandidateRow[];
  prevActiveUsers: number;
  total: number;
  truncated: boolean;
}

/** 集合差集 + 排序 + 截断（纯函数，无 DB 依赖）。 */
export function selectInactiveCandidates(
  prevRows: PrevActiveRow[],
  currentRows: CurrentActiveRow[],
  limit: number,
): InactiveSelection {
  const activeNow = new Set(currentRows.map((row) => toInteger(row.user_id)));
  const candidates: InactiveCandidateRow[] = prevRows
    .map((row) => ({
      userId: toInteger(row.user_id),
      lastActiveAt: toInteger(row.last_active_at),
      prevRequestCount: toInteger(row.prev_request_count),
    }))
    .filter((row) => !activeNow.has(row.userId))
    .sort(
      (a, b) => b.prevRequestCount - a.prevRequestCount || a.userId - b.userId,
    );

  const capped = clampLimit(limit);
  return {
    rows: candidates.slice(0, capped),
    prevActiveUsers: prevRows.length,
    total: candidates.length,
    truncated: candidates.length > capped,
  };
}

/** 附带账号与昵称；users 表缺失/字段为 NULL 时留空串，由前端兜底显示。 */
export function attachInactiveNames(
  candidates: InactiveCandidateRow[],
  nameRows: InactiveNameRow[],
): InactiveUserRow[] {
  const names = new Map<number, { username: string; displayName: string }>();
  for (const row of nameRows) {
    names.set(toInteger(row.id), {
      username: (row.username ?? "").trim(),
      displayName: (row.display_name ?? "").trim(),
    });
  }
  return candidates.map((row) => ({
    ...row,
    username: names.get(row.userId)?.username ?? "",
    displayName: names.get(row.userId)?.displayName ?? "",
  }));
}

/** 执行三层查询：上期聚合 + 本期集合并发，最后按差集结果补用户名。 */
export async function runInactiveUsersQuery(
  range: QueryRange,
  limit: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<InactiveUsersSnapshot> {
  const prevRange = previousPeriod(range);
  const [prevRows, currentRows] = await Promise.all([
    buildPrevActiveQuery(db, prevRange).execute() as Promise<PrevActiveRow[]>,
    buildCurrentActiveQuery(db, range).execute() as Promise<CurrentActiveRow[]>,
  ]);

  const selection = selectInactiveCandidates(prevRows, currentRows, limit);
  const nameRows =
    selection.rows.length === 0
      ? []
      : ((await buildInactiveNamesQuery(
          db,
          selection.rows.map((row) => row.userId),
        ).execute()) as InactiveNameRow[]);

  return {
    rows: attachInactiveNames(selection.rows, nameRows),
    prevRange,
    prevActiveUsers: selection.prevActiveUsers,
    total: selection.total,
    truncated: selection.truncated,
  };
}
