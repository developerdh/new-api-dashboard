import { describe, expect, it } from "vitest";

import {
  buildFingerprintIndex,
  buildFingerprintPairs,
  fingerprintOfKey,
  fingerprintsOfUser,
} from "@/server/queries/audit-tokens";

describe("指纹算法", () => {
  it("与代理同构：sha256(prefix + key) 前 12 位（固定向量）", () => {
    expect(fingerprintOfKey("test-key-abc", "Bearer sk-")).toBe("6897e339f6c7");
  });

  it("前缀参与哈希，空前缀得到不同结果", () => {
    expect(fingerprintOfKey("test-key-abc", "")).toBe("70a575b4d165");
    expect(fingerprintOfKey("test-key-abc", "Bearer sk-")).not.toBe(
      fingerprintOfKey("test-key-abc", ""),
    );
  });

  it("输出恒为 12 位小写十六进制", () => {
    expect(fingerprintOfKey("任意-key", "Bearer sk-")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("构建指纹索引", () => {
  const rows = [
    { id: 1, user_id: 7, key: "key-one" },
    { id: 2, user_id: 7, key: "key-two" },
    { id: 3, user_id: 9, key: "key-three" },
    { id: 4, user_id: 9, key: "" },
  ];

  it("一个用户多个 token 聚合到同一 userId", () => {
    const pairs = buildFingerprintPairs(rows, "Bearer sk-");
    expect(pairs).toHaveLength(3);
    const index = buildFingerprintIndex(pairs);
    expect(index.byUser.get(7)).toHaveLength(2);
    expect(index.byUser.get(9)).toHaveLength(1);
    expect(fingerprintsOfUser(index, 7).size).toBe(2);
    expect(fingerprintsOfUser(index, 42).size).toBe(0);
  });

  it("空 key 跳过，重复指纹只保留一条", () => {
    const pairs = buildFingerprintPairs(
      [
        { id: 1, user_id: 1, key: "dup" },
        { id: 2, user_id: 2, key: "dup" },
      ],
      "Bearer sk-",
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      tokenId: 1,
      userId: 1,
      fp: fingerprintOfKey("dup", "Bearer sk-"),
    });
  });

  it("软删除行由查询层保留（此处按行映射，不判断状态）", () => {
    const index = buildFingerprintIndex(
      buildFingerprintPairs([{ id: 9, user_id: 3, key: "deleted-token" }], "Bearer sk-"),
    );
    expect(index.byFp.size).toBe(1);
    expect(index.byUser.get(3)).toHaveLength(1);
  });
});
