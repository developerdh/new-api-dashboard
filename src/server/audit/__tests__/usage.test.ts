/** 单测：token 用量提取（列表水合用）——协议差异 / SSE / 缓存字段。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extractUsage } from "@/server/audit/normalize";

/**
 * 契约样例：与采集端 Go 测试（audit-proxy/usage_test.go）共用同一份文件。
 * 两侧对同一段正文必须给出相同的 token 数字——谁改了行为，哪一侧测试就红。
 */
const CONTRACT_DIR = fileURLToPath(
  new URL("../../../../audit-proxy/testdata/usage", import.meta.url),
);

function sample(name: string): string {
  return readFileSync(`${CONTRACT_DIR}/${name}`, "utf8");
}

describe("采集契约样例（与 audit-proxy/usage_test.go 共用 testdata/usage/）", () => {
  const cases: Array<{
    name: string;
    file: string;
    path: string;
    want: { pt: number; ct: number; cc: number; cw: number };
  }> = [
    { name: "chat json + cached", file: "chat.json", path: "/v1/chat/completions", want: { pt: 1200, ct: 48, cc: 900, cw: 0 } },
    { name: "chat sse last usage wins", file: "chat-stream.sse", path: "/v1/chat/completions", want: { pt: 800, ct: 40, cc: 0, cw: 0 } },
    { name: "anthropic json cache read/write", file: "anthropic.json", path: "/v1/messages", want: { pt: 500, ct: 30, cc: 400, cw: 60 } },
    { name: "anthropic sse merges start/delta", file: "anthropic-stream.sse", path: "/v1/messages", want: { pt: 500, ct: 30, cc: 400, cw: 60 } },
    { name: "responses json", file: "responses.json", path: "/v1/responses", want: { pt: 300, ct: 20, cc: 250, cw: 0 } },
    { name: "responses sse nested usage", file: "responses-stream.sse", path: "/v1/responses", want: { pt: 300, ct: 20, cc: 250, cw: 0 } },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const usage = extractUsage({ path: tc.path, responseText: sample(tc.file), truncated: false });
      expect(usage?.promptTokens ?? 0).toBe(tc.want.pt);
      expect(usage?.completionTokens ?? 0).toBe(tc.want.ct);
      expect(usage?.cachedTokens ?? 0).toBe(tc.want.cc);
      expect(usage?.cacheWriteTokens ?? 0).toBe(tc.want.cw);
    });
  }
});

describe("extractUsage", () => {
  it("openai-chat JSON：含 prompt_tokens_details.cached_tokens", () => {
    const usage = extractUsage({
      path: "/v1/chat/completions",
      responseText: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 48,
          total_tokens: 1248,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      }),
      truncated: false,
    });
    expect(usage).toEqual({
      promptTokens: 1200,
      completionTokens: 48,
      totalTokens: 1248,
      cachedTokens: 900,
    });
  });

  it("openai-chat SSE：取流中最后一次 usage 块", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":12,"total_tokens":812}}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":40,"total_tokens":852}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const usage = extractUsage({ path: "/v1/chat/completions", responseText: sse, truncated: false });
    expect(usage?.promptTokens).toBe(812);
    expect(usage?.completionTokens).toBe(40);
  });

  it("anthropic-messages：cache_read / cache_creation", () => {
    const usage = extractUsage({
      path: "/v1/messages",
      responseText: JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 500,
          output_tokens: 30,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 60,
        },
      }),
      truncated: false,
    });
    expect(usage).toMatchObject({
      promptTokens: 500,
      completionTokens: 30,
      cachedTokens: 400,
      cacheWriteTokens: 60,
    });
  });

  it("responses 接口：input_tokens_details.cached_tokens", () => {
    const usage = extractUsage({
      path: "/v1/responses",
      responseText: JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: {
          input_tokens: 300,
          output_tokens: 20,
          total_tokens: 320,
          input_tokens_details: { cached_tokens: 250 },
        },
      }),
      truncated: false,
    });
    expect(usage).toMatchObject({ promptTokens: 300, completionTokens: 20, cachedTokens: 250 });
  });

  it("无 usage / 坏正文 → undefined", () => {
    expect(
      extractUsage({
        path: "/v1/chat/completions",
        responseText: JSON.stringify({ choices: [{ message: { content: "no usage" } }] }),
        truncated: false,
      }),
    ).toBeUndefined();
    expect(
      extractUsage({ path: "/v1/chat/completions", responseText: "not-json", truncated: false }),
    ).toBeUndefined();
  });
});
