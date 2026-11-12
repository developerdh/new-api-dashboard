/** 用户展示名公共件：昵称优先、账号兜底、全称组合。 */
import { describe, expect, it } from "vitest";

import { fullUserLabel, primaryUserLabel, secondaryUserLabel } from "@/lib/user-label";

describe("primaryUserLabel", () => {
  it("有昵称时优先展示昵称", () => {
    expect(primaryUserLabel({ userId: 2, username: "alice", displayName: "爱丽丝" })).toBe("爱丽丝");
  });

  it("昵称缺失/空白时回落账号", () => {
    expect(primaryUserLabel({ userId: 2, username: "alice", displayName: "" })).toBe(
      "alice",
    );
    expect(primaryUserLabel({ userId: 2, username: "alice", displayName: "   " })).toBe(
      "alice",
    );
    expect(primaryUserLabel({ userId: 2, username: "alice" })).toBe("alice");
  });

  it("两者都缺失时回落「用户 N」，null 也按缺失处理", () => {
    expect(primaryUserLabel({ userId: 7 })).toBe("用户 7");
    expect(primaryUserLabel({ userId: 7, username: null, displayName: null })).toBe("用户 7");
  });
});

describe("secondaryUserLabel", () => {
  it("昵称与账号不同时返回账号", () => {
    expect(secondaryUserLabel({ userId: 2, username: "alice", displayName: "爱丽丝" })).toBe(
      "alice",
    );
  });

  it("昵称等于账号 / 无昵称 / 无账号时不重复展示", () => {
    expect(
      secondaryUserLabel({ userId: 2, username: "alice", displayName: "alice" }),
    ).toBe("");
    expect(secondaryUserLabel({ userId: 2, username: "alice", displayName: "" })).toBe("");
    expect(secondaryUserLabel({ userId: 2, username: "", displayName: "爱丽丝" })).toBe("");
  });
});

describe("fullUserLabel", () => {
  it("昵称 + 账号组合成中文括号全称", () => {
    expect(fullUserLabel({ userId: 2, username: "alice", displayName: "爱丽丝" })).toBe(
      "爱丽丝（alice）",
    );
  });

  it("无昵称时只显示账号", () => {
    expect(fullUserLabel({ userId: 2, username: "alice", displayName: "" })).toBe("alice");
  });
});
