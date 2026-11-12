/** 用户目录查询：SQL 编译口径 + 昵称清洗/映射（无真实库）。 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildUserDirectoryQuery,
  buildUserIdentityQuery,
  toUserIdentityMap,
} from "@/server/queries/user-directory";
import type { Database } from "@/server/schema";

let db: Kysely<Database>;

beforeAll(() => {
  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: "postgres://test:pw@127.0.0.1:5432/test" }),
    }),
  });
});

afterAll(async () => {
  await db.destroy();
});

describe("用户目录 SQL 编译口径", () => {
  it("批量查询：只 SELECT 身份三列，IN 列表参数化", () => {
    const compiled = buildUserDirectoryQuery(db, [7, 8]).compile();
    expect(compiled.sql).toContain('from "users"');
    expect(compiled.sql).toContain('"display_name"');
    expect(compiled.sql).toMatch(/"id" in \(\$1, \$2\)/);
    expect(compiled.parameters).toEqual([7, 8]);
  });

  it("单用户查询：id 等值参数化", () => {
    const compiled = buildUserIdentityQuery(db, 7).compile();
    expect(compiled.sql).toContain('from "users"');
    expect(compiled.sql).toMatch(/"id" = \$1/);
    expect(compiled.parameters).toEqual([7]);
  });
});

describe("toUserIdentityMap", () => {
  it("trim 昵称/账号，NULL 归空串；数值字符串也能整数化", () => {
    const map = toUserIdentityMap([
      { id: 2, username: " alice ", display_name: " 爱丽丝 " },
      { id: 3, username: null, display_name: null },
      { id: "4" as unknown as number, username: "x", display_name: "" },
    ]);
    expect(map.get(2)).toEqual({ userId: 2, username: "alice", displayName: "爱丽丝" });
    expect(map.get(3)).toEqual({ userId: 3, username: "", displayName: "" });
    expect(map.get(4)).toEqual({ userId: 4, username: "x", displayName: "" });
  });

  it("空行 → 空 Map", () => {
    expect(toUserIdentityMap([]).size).toBe(0);
  });
});
