/** 单测：消息过滤条件（详情抽屉 / 线程抽屉共用）。 */
import { describe, expect, it } from "vitest";

import {
  blockMatches,
  blockText,
  isDefaultFilter,
  kindMatches,
  type BlockFilter,
} from "@/components/dashcam/dashcam-message-filters";
import type { DashcamBlock } from "@/server/dashcam/types";

function block(patch: Partial<DashcamBlock> = {}): DashcamBlock {
  return {
    seq: 1,
    role: "user",
    kind: "text",
    text: "帮我查一下天气",
    ...patch,
  } as DashcamBlock;
}

const ALL: BlockFilter = { role: "all", kind: "all", query: "" };

describe("kindMatches", () => {
  it("text 含 text 与 other，tool 含 tool_call/tool_result", () => {
    expect(kindMatches(block({ kind: "text" }), "text")).toBe(true);
    expect(kindMatches(block({ kind: "other" }), "text")).toBe(true);
    expect(kindMatches(block({ kind: "tool_call" }), "tool")).toBe(true);
    expect(kindMatches(block({ kind: "tool_result" }), "tool")).toBe(true);
    expect(kindMatches(block({ kind: "image" }), "text")).toBe(false);
    expect(kindMatches(block({ kind: "text" }), "image")).toBe(false);
  });

  it("all 不过滤任何类型", () => {
    for (const kind of ["text", "other", "tool_call", "tool_result", "image"] as const) {
      expect(kindMatches(block({ kind }), "all")).toBe(true);
    }
  });
});

describe("blockMatches", () => {
  it("角色精确匹配（unknown 角色不命中任何具体角色）", () => {
    expect(blockMatches(block({ role: "assistant" }), { ...ALL, role: "user" })).toBe(false);
    expect(blockMatches(block({ role: "user" }), { ...ALL, role: "user" })).toBe(true);
    expect(blockMatches(block({ role: "unknown" }), { ...ALL, role: "user" })).toBe(false);
    expect(blockMatches(block({ role: "unknown" }), ALL)).toBe(true);
  });

  it("关键词匹配正文与工具名/参数/callId，大小写不敏感", () => {
    expect(blockMatches(block(), { ...ALL, query: "天气" })).toBe(true);
    expect(blockMatches(block(), { ...ALL, query: "WEATHER" })).toBe(false);

    const tool = block({
      kind: "tool_call",
      text: undefined,
      tool: { name: "getWeather", arguments: '{"city":"hangzhou"}', callId: "call_abc" },
    } as Partial<DashcamBlock>);
    expect(blockMatches(tool, { ...ALL, query: "getweather" })).toBe(true);
    expect(blockMatches(tool, { ...ALL, query: "hangzhou" })).toBe(true);
    expect(blockMatches(tool, { ...ALL, query: "call_abc" })).toBe(true);
    expect(blockMatches(tool, { ...ALL, query: "不存在的词" })).toBe(false);
  });

  it("角色 + 类型 + 关键词是且关系", () => {
    const f: BlockFilter = { role: "user", kind: "text", query: "天气" };
    expect(blockMatches(block(), f)).toBe(true);
    expect(blockMatches(block({ role: "assistant" }), f)).toBe(false);
    expect(blockMatches(block({ kind: "image" }), f)).toBe(false);
  });
});

describe("isDefaultFilter", () => {
  it("全默认为 true，任一条件变化为 false", () => {
    expect(isDefaultFilter(ALL)).toBe(true);
    expect(isDefaultFilter({ ...ALL, role: "user" })).toBe(false);
    expect(isDefaultFilter({ ...ALL, kind: "tool" })).toBe(false);
    expect(isDefaultFilter({ ...ALL, query: "x" })).toBe(false);
  });
});

describe("blockText", () => {
  it("拼接正文与工具字段并整体小写", () => {
    expect(blockText(block()).trim()).toBe("帮我查一下天气");
    const tool = block({
      kind: "tool_call",
      text: undefined,
      tool: { name: "GetWeather", arguments: "{}", callId: "c1" },
    } as Partial<DashcamBlock>);
    expect(blockText(tool)).toContain("getweather");
  });
});
