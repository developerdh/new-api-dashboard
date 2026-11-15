/**
 * 单测：Token 构成列表的纯函数推导（占比、命中率、跨语义修正与脏数据截断）。
 * 口径实测依据：db-schema-notes §3.7（openai 语义 prompt 含缓存 / anthropic 语义不含）。
 */
import { describe, expect, it } from "vitest";

import { computeTokenBreakdown } from "@/components/charts/token-breakdown-list";

describe("computeTokenBreakdown", () => {
  it("openai 语义（prompt 含缓存）：有效输入 = prompt，命中率 = 读取/prompt，写入行隐藏", () => {
    const result = computeTokenBreakdown({
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 0,
      cacheOutsidePromptTokens: 0,
    });

    expect(result.effectiveInputTokens).toBe(1_000_000);
    expect(result.cacheHitRate).toBe(0.8);
    expect(result.isEmpty).toBe(false);
    expect(result.rows[0]).toMatchObject({ key: "input", tokens: 1_000_000 });
    expect(result.rows[1]).toMatchObject({ key: "output", tokens: 100_000 });
    expect(result.rows[0].share).toBeCloseTo(1_000_000 / 1_100_000, 6);
    expect(result.rows[1].share).toBeCloseTo(100_000 / 1_100_000, 6);
    expect(result.cacheRows).toHaveLength(1);
    expect(result.cacheRows[0]).toMatchObject({ key: "cache-read", tokens: 800_000, share: 0.8 });
  });

  it("anthropic 语义（prompt 不含缓存）：有效输入补回缓存读写修正量", () => {
    // 实测样本形态：prompt=696 / cache_tokens=672896 / cache_creation_tokens=400
    const result = computeTokenBreakdown({
      promptTokens: 700,
      completionTokens: 297,
      cacheReadTokens: 672_896,
      cacheWriteTokens: 400,
      cacheOutsidePromptTokens: 673_296,
    });

    expect(result.effectiveInputTokens).toBe(673_996);
    expect(result.cacheHitRate).toBeCloseTo(672_896 / 673_996, 6);
    expect(result.rows[0]).toMatchObject({ key: "input", tokens: 673_996 });
    expect(result.rows[0].share).toBeCloseTo(673_996 / 674_293, 6);
    expect(result.cacheRows).toHaveLength(2);
    expect(result.cacheRows[0]).toMatchObject({ key: "cache-read" });
    expect(result.cacheRows[1]).toMatchObject({ key: "cache-write", tokens: 400 });
    expect(result.cacheRows[1]?.share).toBeCloseTo(400 / 673_996, 6);
  });

  it("脏数据防御：读取量超过有效输入时命中率与占比截断为 1", () => {
    const result = computeTokenBreakdown({
      promptTokens: 100,
      completionTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      cacheOutsidePromptTokens: 0,
    });

    expect(result.cacheHitRate).toBe(1);
    expect(result.cacheRows[0]).toMatchObject({ share: 1 });
  });

  it("无缓存：缓存子行为空，仅输入/输出两行", () => {
    const result = computeTokenBreakdown({
      promptTokens: 500,
      completionTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheOutsidePromptTokens: 0,
    });

    expect(result.cacheRows).toHaveLength(0);
    expect(result.cacheHitRate).toBe(0);
    expect(result.isEmpty).toBe(false);
  });

  it("空区间：isEmpty 且占比记 0（分母为 0 不产生 NaN）", () => {
    const result = computeTokenBreakdown({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheOutsidePromptTokens: 0,
    });

    expect(result.isEmpty).toBe(true);
    expect(result.effectiveInputTokens).toBe(0);
    expect(result.rows.every((row) => row.share === 0)).toBe(true);
  });
});
