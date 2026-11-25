/** 单测：sameQueryGeneration——按 `?` 后请求串判同代（跨端点路径比较的回归防护）。 */
import { describe, expect, it } from "vitest";

import { sameQueryGeneration } from "@/lib/use-api";

describe("sameQueryGeneration", () => {
  it("同参数不同端点路径 → 同代（跨端点堆叠守卫的核心语义）", () => {
    expect(
      sameQueryGeneration(
        "/api/trend?start=1&end=2&granularity=day",
        "/api/models/trend?start=1&end=2&granularity=day",
      ),
    ).toBe(true);
  });

  it("参数不同（任一侧仍是旧区间）→ 不同代", () => {
    expect(
      sameQueryGeneration(
        "/api/trend?start=1&end=2&granularity=day",
        "/api/models/trend?start=3&end=4&granularity=day",
      ),
    ).toBe(false);
  });

  it("任一侧尚未完成请求（null）→ 不同代", () => {
    expect(sameQueryGeneration(null, "/api/trend?start=1&end=2")).toBe(false);
    expect(sameQueryGeneration("/api/trend?start=1&end=2", null)).toBe(false);
    expect(sameQueryGeneration(null, null)).toBe(false);
  });

  it("无查询串的 URL → 不同代（防整串相等误判）", () => {
    expect(sameQueryGeneration("/api/trend", "/api/models/trend")).toBe(false);
  });
});
