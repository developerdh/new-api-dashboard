/**
 * 统计口径排除账号：所有 logs / quota_data 查询都必须带排除条件。
 *
）* 口径：admin（`users.id = 1` 的调用不计入任何使用量、活跃度、模型分布与沉默用户统计。
 * 该片段为代码常量（不含外部输入），因此不新增参数占位——参数列表保持原样是关键断言。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EXCLUDED_STAT_USERNAMES,
  EXCLUDE_STAT_USERS_SQL,
} from "@/server/queries/common";
import { buildModelRankingTotalsQuery } from "@/server/queries/model";
import { buildQuotaAggregateQuery, buildRequestCountQuery } from "@/server/queries/overview";
import { buildUserDirectoryQuery } from "@/server/queries/user-directory";
import type { Database } from "@/server/schema";

const T0 = 1_794_240_000;
const T1 = T0 + 86_400;

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

describe("EXCLUDE_STAT_USERS_SQL 片段", () => {
  it("排除账号名单固定为 admin", () => {
    expect(EXCLUDED_STAT_USERNAMES).toEqual(["admin"]);
  });

  it("片段包含 user_id 子查询与用户名兜底，且无参数占位", () => {
    const compiled = EXCLUDE_STAT_USERS_SQL.compile(db);
    expect(compiled.sql).toContain('lower("username") = \'admin\'');
    expect(compiled.sql).toContain('coalesce(lower("username"), \'\') <> \'admin\'');
    expect(compiled.sql).toContain('"user_id" not in (select "id" from "users"');
    expect(compiled.parameters).toEqual([]);
  });
});

describe("统计查询自动排除 admin", () => {
  it("总览 quota_data 聚合：带排除条件，参数列表不变", () => {
    const compiled = buildQuotaAggregateQuery(db, { start: T0, end: T1 }).compile();
    expect(compiled.sql).toContain('coalesce(lower("username"), \'\') <> \'admin\'');
    expect(compiled.sql).toContain('"user_id" not in (select "id" from "users"');
    expect(compiled.parameters).toEqual([T0, T1]);
  });

  it("总览 logs 请求数：带排除条件，参数列表不变", () => {
    const compiled = buildRequestCountQuery(db, { start: T0, end: T1 }).compile();
    expect(compiled.sql).toContain('coalesce(lower("username"), \'\') <> \'admin\'');
    expect(compiled.parameters).toEqual([2, T0, T1]);
  });

  it("模型排行聚合：同样排除 admin 的调用", () => {
    const compiled = buildModelRankingTotalsQuery(db, { start: T0, end: T1 }, 20).compile();
    expect(compiled.sql).toContain('coalesce(lower("username"), \'\') <> \'admin\'');
    expect(compiled.parameters).toEqual([T0, T1, 20]);
  });

  it("users 表查询不加排除条件（昵称解析仍可命中 admin）", () => {
    const compiled = buildUserDirectoryQuery(db, [1]).compile();
    expect(compiled.sql).not.toContain("admin");
    expect(compiled.parameters).toEqual([1]);
  });
});
