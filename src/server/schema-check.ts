/**
 * 数据库 schema 自检：确认统计查询实际引用的列存在。
 *
 * 背景：查询按 New API 的实测结构硬编码列名；不同 New API 版本的表结构可能缺失某些列。
 * 缺列时若不提前暴露，表现为某个接口 500，排查成本高。此处把缺列状态暴露在 `/api/health`。
 *
 * 红线：只读——仅查询 `information_schema.columns`，不建表、不改结构。
 */
import { sql } from "kysely";

import { getDb, type ReadOnlyDatabase } from "@/server/db";

/** 查询实现实际引用的列（见 `src/server/schema.ts` 与 `docs/db-schema-notes.md`）。 */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ["id", "username", "display_name"],
  logs: [
    "user_id",
    "username",
    "created_at",
    "type",
    "model_name",
    "quota",
    "prompt_tokens",
    "completion_tokens",
  ],
  quota_data: ["user_id", "username", "model_name", "created_at", "token_used", "quota"],
};

export interface SchemaCheckResult {
  ok: boolean;
  /** 缺失列，形如 `users.display_name`；空数组表示通过。 */
  missing: string[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
}

/** 缺失列清单；用于构造一次性的 `information_schema` 查询条件。 */
const TABLE_NAMES = Object.keys(REQUIRED_COLUMNS);

/** 纯函数：按 `表.列` 键集合算出缺失项（顺序稳定，便于断言与日志比对）。 */
export function missingColumns(presentKeys: Iterable<string>): string[] {
  const present = new Set(presentKeys);
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      const key = `${table}.${column}`;
      if (!present.has(key)) missing.push(key);
    }
  }
  return missing;
}

export async function checkSchema(db: ReadOnlyDatabase = getDb()): Promise<SchemaCheckResult> {
  const { rows } = await sql<ColumnRow>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (${sql.join(TABLE_NAMES.map((name) => sql.lit(name)))})
  `.execute(db);

  const missing = missingColumns(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return { ok: missing.length === 0, missing };
}
