/** 单测：schema 自检的缺失列计算（纯函数，不连库）。 */
import { describe, expect, it } from "vitest";

import { REQUIRED_COLUMNS, missingColumns } from "@/server/schema-check";

/** 把 REQUIRED_COLUMNS 展平成 `表.列` 全集，作为「全部存在」的基准。 */
const ALL_KEYS = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
  columns.map((column) => `${table}.${column}`),
);

describe("REQUIRED_COLUMNS", () => {
  it("覆盖三张统计表", () => {
    expect(Object.keys(REQUIRED_COLUMNS).sort()).toEqual(["logs", "quota_data", "users"]);
  });

  it("包含统计口径依赖的关键列", () => {
    expect(REQUIRED_COLUMNS.users).toContain("display_name");
    expect(REQUIRED_COLUMNS.logs).toContain("type");
    expect(REQUIRED_COLUMNS.quota_data).toContain("token_used");
  });
});

describe("missingColumns", () => {
  it("全部存在时返回空数组", () => {
    expect(missingColumns(ALL_KEYS)).toEqual([]);
  });

  it("缺列时按「表.列」返回，且顺序稳定", () => {
    const present = ALL_KEYS.filter((key) => key !== "users.display_name" && key !== "logs.type");
    expect(missingColumns(present)).toEqual(["users.display_name", "logs.type"]);
  });

  it("空集合时返回全部必需列", () => {
    expect(missingColumns([])).toEqual(ALL_KEYS);
  });

  it("多余的表或列不影响结果", () => {
    expect(missingColumns([...ALL_KEYS, "users.extra", "other.id"])).toEqual([]);
  });
});
