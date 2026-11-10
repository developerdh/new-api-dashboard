/**
 * BE-M0-03 单测：schema.ts 基线口径与「未复验候选列隔离」。
 *
 * 目的不是复述类型，而是把两条会被后续任务无意破坏的约束钉住：
 * 1. `Database` 只含方案 §2.2 基线列（M1 可编码范围）；
 * 2. 真实库复验前，候选列（quota_data.count / logs.type / users.used_quota 等）
 *    不得出现在 `Database`；晋升必须同时改本测试与 docs/db-schema-notes.md。
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SCHEMA_VERIFICATION,
  type Database,
  type LogsCandidateColumns,
  type LogsTable,
  type QuotaDataCandidateColumns,
  type QuotaDataTable,
  type UsersCandidateColumns,
  type UsersTable,
} from "@/server/schema";

describe("Database：方案 §2.2 基线列", () => {
  it("只声明 quota_data / logs / users 三张表", () => {
    expectTypeOf<keyof Database>().toEqualTypeOf<"quota_data" | "logs" | "users">();
  });

  it("quota_data 列集合与方案 §2.2 一致", () => {
    expectTypeOf<keyof QuotaDataTable>().toEqualTypeOf<
      | "user_id"
      | "username"
      | "model_name"
      | "created_at"
      | "token_used"
      | "quota"
      | "prompt_tokens"
      | "completion_tokens"
    >();
  });

  it("logs 列集合与方案 §2.2 一致（无 token_used）", () => {
    expectTypeOf<keyof LogsTable>().toEqualTypeOf<
      | "user_id"
      | "username"
      | "created_at"
      | "model_name"
      | "quota"
      | "prompt_tokens"
      | "completion_tokens"
    >();
  });

  it("users 列集合与方案 §2.2 一致", () => {
    expectTypeOf<keyof UsersTable>().toEqualTypeOf<"id" | "username" | "status" | "quota">();
  });
});

describe("类型口径：Unix 秒与数值列", () => {
  it("created_at 为 Unix 秒（number，int8 由 db.ts 反序列化）", () => {
    expectTypeOf<QuotaDataTable["created_at"]>().toEqualTypeOf<number>();
    expectTypeOf<LogsTable["created_at"]>().toEqualTypeOf<number>();
  });

  it("用量/额度列统一为 number（不做 bigint 字符串化）", () => {
    expectTypeOf<QuotaDataTable["quota"]>().toEqualTypeOf<number>();
    expectTypeOf<QuotaDataTable["token_used"]>().toEqualTypeOf<number>();
    expectTypeOf<LogsTable["prompt_tokens"]>().toEqualTypeOf<number>();
    expectTypeOf<UsersTable["quota"]>().toEqualTypeOf<number>();
  });
});

describe("未复验候选列：类型层隔离", () => {
  it("复验状态为未通过（与 notes §1 一致）", () => {
    expect(SCHEMA_VERIFICATION.verified).toBe(false);
    expect(SCHEMA_VERIFICATION.verifiedAt).toBeNull();
    expect(SCHEMA_VERIFICATION.notesDoc).toBe("docs/db-schema-notes.md");
  });

  it("候选列不进入 Database（复验前禁用，晋升须同步改测试与 notes）", () => {
    expectTypeOf<Database["quota_data"]>().not.toHaveProperty("id");
    expectTypeOf<Database["quota_data"]>().not.toHaveProperty("count");
    expectTypeOf<Database["logs"]>().not.toHaveProperty("id");
    expectTypeOf<Database["logs"]>().not.toHaveProperty("type");
    expectTypeOf<Database["users"]>().not.toHaveProperty("used_quota");
  });

  it("候选列清单保持显式（避免被静默删除）", () => {
    expectTypeOf<keyof QuotaDataCandidateColumns>().toEqualTypeOf<"id" | "count">();
    expectTypeOf<keyof LogsCandidateColumns>().toEqualTypeOf<"type" | "id">();
    expectTypeOf<keyof UsersCandidateColumns>().toEqualTypeOf<"used_quota">();
  });
});
