/**
 * 用户目录查询：从 `users` 表解析昵称（`display_name`）与当前账号（`username`）。
 *
 * 背景：`quota_data.username` / `logs.username` 是消费发生时写入的账号，可能被改名；
 * 昵称只存在于 `users` 表，因此按 `user_id` 单独补齐，不改动既有聚合 SQL 的口径。
 *
 * 红线：只读、参数化（Kysely 表达式 / IN 列表）；空 id 列表不发查询。
 * 用户已删除、`display_name` 为 NULL/空白时返回空串，由展示层回落账号（见 `lib/user-label.ts`）。
 */
import { getDb, type ReadOnlyDatabase } from "@/server/db";

export interface UserDirectoryRow {
  id: number;
  username: string | null;
  display_name: string | null;
}

export interface UserIdentity {
  userId: number;
  username: string;
  displayName: string;
}

function toInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** 按 id 批量取用户身份（IN 参数化，供排行 / 沉默用户清单等补齐昵称）。 */
export function buildUserDirectoryQuery(db: ReadOnlyDatabase, userIds: number[]) {
  return db
    .selectFrom("users")
    .select(["id", "username", "display_name"])
    .where("id", "in", userIds);
}

/** 单个用户身份（用户详情页按 id 补齐标题）。 */
export function buildUserIdentityQuery(db: ReadOnlyDatabase, userId: number) {
  return db
    .selectFrom("users")
    .select(["id", "username", "display_name"])
    .where("id", "=", userId);
}

export function toUserIdentityMap(rows: UserDirectoryRow[]): Map<number, UserIdentity> {
  const map = new Map<number, UserIdentity>();
  for (const row of rows) {
    const userId = toInteger(row.id);
    map.set(userId, {
      userId,
      username: clean(row.username),
      displayName: clean(row.display_name),
    });
  }
  return map;
}

/** 批量解析；空列表不发查询。 */
export async function loadUserIdentities(
  userIds: number[],
  db: ReadOnlyDatabase = getDb(),
): Promise<Map<number, UserIdentity>> {
  if (userIds.length === 0) return new Map();
  const rows = (await buildUserDirectoryQuery(db, userIds).execute()) as UserDirectoryRow[];
  return toUserIdentityMap(rows);
}

/** 单个解析；用户不存在返回 null。 */
export async function loadUserIdentity(
  userId: number,
  db: ReadOnlyDatabase = getDb(),
): Promise<UserIdentity | null> {
  const row = (await buildUserIdentityQuery(db, userId).executeTakeFirst()) as
    | UserDirectoryRow
    | undefined;
  return row === undefined ? null : toUserIdentityMap([row]).get(userId) ?? null;
}
