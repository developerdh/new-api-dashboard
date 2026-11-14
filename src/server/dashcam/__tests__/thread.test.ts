import { describe, expect, it } from "vitest";

import { blockSignature, commonPrefixLength, computeThreadDelta } from "@/server/dashcam/thread";
import type { DashcamBlock } from "@/server/dashcam/types";

function text(seq: number, role: DashcamBlock["role"], body: string): DashcamBlock {
  return { seq, messageIndex: seq, role, kind: "text", text: body };
}

const system = text(0, "system", "你是助手");
const user1 = text(1, "user", "第一问");
const assistant1 = text(2, "assistant", "第一答");
const user2 = text(3, "user", "第二问");

describe("blockSignature", () => {
  it("同内容同角色签名一致，角色不同签名不同", () => {
    expect(blockSignature(user1)).toBe(blockSignature(text(99, "user", "第一问")));
    expect(blockSignature(user1)).not.toBe(blockSignature(text(1, "assistant", "第一问")));
  });

  it("工具字段参与签名（同名不同参数要能区分）", () => {
    const a: DashcamBlock = {
      seq: 0,
      messageIndex: 0,
      role: "assistant",
      kind: "tool_call",
      tool: { name: "search", arguments: '{"q":"a"}' },
    };
    const b: DashcamBlock = { ...a, tool: { name: "search", arguments: '{"q":"b"}' } };
    expect(blockSignature(a)).not.toBe(blockSignature(b));
  });

  it("序号不参与签名（跨轮局部序号不可比）", () => {
    const shifted: DashcamBlock = { ...user1, seq: 42, messageIndex: 7 };
    expect(blockSignature(shifted)).toBe(blockSignature(user1));
  });
});

describe("commonPrefixLength", () => {
  it("返回公共前缀长度", () => {
    expect(commonPrefixLength(["a", "b", "c"], ["a", "b", "d"])).toBe(2);
    expect(commonPrefixLength(["a"], ["a", "b"])).toBe(1);
    expect(commonPrefixLength([], ["a"])).toBe(0);
  });
});

describe("computeThreadDelta", () => {
  it("连续追加：只保留新增部分", () => {
    const delta = computeThreadDelta({
      prevTraceId: "prev",
      prevMessages: [system, user1, assistant1],
      currentMessages: [system, user1, assistant1, user2],
    });
    expect(delta.priorMessages).toBe(3);
    expect(delta.commonPrefix).toBe(3);
    expect(delta.continuous).toBe(true);
    expect(delta.news.map((block) => block.text)).toEqual(["第二问"]);
    expect(delta.reason).toBeUndefined();
  });

  it("上一轮回答也属于新增（客户端把它带回来了）", () => {
    // 上一轮请求只有 [system, user1]，本轮把 assistant1 一起带上
    const delta = computeThreadDelta({
      prevTraceId: "prev",
      prevMessages: [system, user1],
      currentMessages: [system, user1, assistant1, user2],
    });
    expect(delta.continuous).toBe(true);
    expect(delta.news.map((block) => block.role)).toEqual(["assistant", "user"]);
  });

  it("历史被裁剪：前缀不足上一轮条数，判为不连续", () => {
    const delta = computeThreadDelta({
      prevTraceId: "prev",
      prevMessages: [system, user1, assistant1],
      currentMessages: [user2], // 上下文超限，前文全被丢弃
    });
    expect(delta.commonPrefix).toBe(0);
    expect(delta.continuous).toBe(false);
    expect(delta.news).toHaveLength(1);
  });

  it("上一轮不可读：退回完整上下文并标注原因", () => {
    const missing = computeThreadDelta({ prevTraceId: "prev", currentMessages: [system, user1] });
    expect(missing.reason).toBe("prev_missing");
    expect(missing.news).toHaveLength(2);
    expect(missing.continuous).toBe(false);

    const failed = computeThreadDelta({
      prevTraceId: "prev",
      currentMessages: [system, user1],
      prevParseFailed: true,
    });
    expect(failed.reason).toBe("prev_parse_failed");
  });

  it("上一轮请求为空（非对话接口）时视作连续，新增即全部", () => {
    const delta = computeThreadDelta({
      prevTraceId: "prev",
      prevMessages: [],
      currentMessages: [user1],
    });
    expect(delta.continuous).toBe(true);
    expect(delta.commonPrefix).toBe(0);
    expect(delta.news).toHaveLength(1);
  });
});
