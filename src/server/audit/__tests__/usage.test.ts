/** 单测：token 用量提取（列表水合用）——协议差异 / SSE / 缓存字段。 */
import { describe, expect, it } from "vitest";

import { extractUsage } from "@/server/audit/normalize";

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
