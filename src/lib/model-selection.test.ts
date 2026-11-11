/** FE-M2-04 单测：模型多选上限（第 11 个不生效）与默认 Top5。 */
import { describe, expect, it } from "vitest";

import {
  TREND_MODEL_DEFAULT,
  TREND_MODEL_MAX,
  defaultModelSelection,
  toggleModelSelection,
} from "@/lib/model-selection";

describe("toggleModelSelection", () => {
  it("未选且未达上限 → 追加", () => {
    expect(toggleModelSelection(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("已选 → 移除", () => {
    expect(toggleModelSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("已达 10 个时选第 11 个 → 原样返回（限制生效）", () => {
    const selected = Array.from({ length: TREND_MODEL_MAX }, (_, i) => `m${i}`);
    const next = toggleModelSelection(selected, "m10");
    expect(next).toBe(selected);
    expect(next).toHaveLength(TREND_MODEL_MAX);
  });

  it("已达上限时仍可取消已有选择", () => {
    const selected = Array.from({ length: TREND_MODEL_MAX }, (_, i) => `m${i}`);
    expect(toggleModelSelection(selected, "m0")).toHaveLength(TREND_MODEL_MAX - 1);
  });
});

describe("defaultModelSelection", () => {
  it("默认取前 5 个", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    expect(defaultModelSelection(names)).toEqual(["a", "b", "c", "d", "e"]);
    expect(defaultModelSelection(names)).toHaveLength(TREND_MODEL_DEFAULT);
  });

  it("候选不足时取全部；count 为 0 时为空", () => {
    expect(defaultModelSelection(["a"], 5)).toEqual(["a"]);
    expect(defaultModelSelection(["a", "b"], 0)).toEqual([]);
  });
});
