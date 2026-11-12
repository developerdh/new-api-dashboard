/**
 * /单测：schema.ts 基线口径与真实库复验后的列集合。
 *
 * 2026-11-11 已对真实库复验：quota_data 无 prompt/completion（改由 logs 提供），
 * 新增 count/id 等实测列；此处锁定复验结论，避免回退到方案 §2.2 的假设列。
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SCHEMA_VERIFICATION,
  type Database,
  type LogsTable,
  type QuotaDataTable,
  type UsersTable,
} from "@/server/schema";

describe("Database：真实库列集合（2026-11-11 复验）", () => {
  it("只声明 quota_data / logs / users 三张表", () => {
    expectTypeOf<keyof Database>().toEqualTypeOf<"quota_data" | "logs" | "users">();
  });

  it("quota_data：包含实测列，且不含 prompt/completion（方案 §2.2 差异 D2）", () => {
    expectTypeOf<keyof QuotaDataTable>().toEqualTypeOf<
      | "id"
      | "user_id"
      | "username"
      | "model_name"
      | "created_at"
      | "use_group"
      | "token_id"
      | "channel_id"
      | "node_name"
      | "token_used"
      | "count"
      | "quota"
    >();
    expectTypeOf<QuotaDataTable>().not.toHaveProperty("prompt_tokens");
    expectTypeOf<QuotaDataTable>().not.toHaveProperty("completion_tokens");
  });

  it("logs：消费类型与 Token 拆分在 logs（差异 D4/D2）", () => {
    expectTypeOf<keyof LogsTable>().toEqualTypeOf<
      | "id"
      | "user_id"
      | "username"
      | "created_at"
      | "type"
      | "model_name"
      | "quota"
      | "prompt_tokens"
      | "completion_tokens"
    >();
  });

  it("users：含 display_name / used_quota / request_count（实测）", () => {
    expectTypeOf<keyof UsersTable>().toEqualTypeOf<
      | "id"
      | "username"
      | "display_name"
      | "status"
      | "quota"
      | "used_quota"
      | "request_count"
    >();
  });
});

describe("类型口径：Unix 秒与数值列", () => {
  it("created_at 为 Unix 秒（number，int8 由 db.ts 反序列化）", () => {
    expectTypeOf<QuotaDataTable["created_at"]>().toEqualTypeOf<number | null>();
    expectTypeOf<LogsTable["created_at"]>().toEqualTypeOf<number | null>();
  });

  it("用量/额度列统一为 number | null（实测可空）", () => {
    expectTypeOf<QuotaDataTable["quota"]>().toEqualTypeOf<number | null>();
    expectTypeOf<QuotaDataTable["token_used"]>().toEqualTypeOf<number | null>();
    expectTypeOf<LogsTable["prompt_tokens"]>().toEqualTypeOf<number | null>();
    expectTypeOf<UsersTable["quota"]>().toEqualTypeOf<number | null>();
  });

  it("复验状态为已通过（notes 已回填）", () => {
    expect(SCHEMA_VERIFICATION.verified).toBe(true);
    expect(SCHEMA_VERIFICATION.verifiedAt).toBe("2026-11-11");
    expect(SCHEMA_VERIFICATION.notesDoc).toBe("docs/db-schema-notes.md");
  });
});
