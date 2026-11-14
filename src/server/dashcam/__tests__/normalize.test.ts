import { describe, expect, it } from "vitest";

import { normalizeDashcam, parseSseEvents } from "@/server/dashcam/normalize";
import type { DashcamIndexEntry } from "@/server/dashcam/types";

const TRACE = "0123456789abcdef0123456789abcdef";

function entry(overrides: Partial<DashcamIndexEntry> = {}): DashcamIndexEntry {
  return {
    t: TRACE,
    u: "dbbbf1891a47",
    d: "2026-11-13T13:36:30.796225937+08:00",
    p: "/v1/chat/completions",
    m: "gpt-4o-mini",
    s: 200,
    st: false,
    ms: 73,
    ft: 73,
    rq: 161,
    rs: 280,
    qz: false,
    rz: false,
    tr: 0,
    ...overrides,
  };
}

const CHAT_REQ =
  '{"model":"gpt-4o-mini","stream":false,"messages":[{"role":"system","content":"你是一个测试助手"},{"role":"user","content":"非流式输入验证-ABCD"}]}';
const CHAT_RES =
  '{"id":"chatcmpl-mock","object":"chat.completion","model":"gpt-4o-mini","choices":[{"index":0,"message":{"role":"assistant","content":"这是非流式返回内容"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21,"prompt_tokens_details":{"cached_tokens":4}}}';

const SSE_RES = [
  'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"，这是"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"流式响应"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{"content":"。"},"finish_reason":null}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":8,"total_tokens":22}}',
  "data: [DONE]",
  "",
].join("\n\n");

function normalize(
  overrides: Partial<DashcamIndexEntry> = {},
  requestText = CHAT_REQ,
  responseText = CHAT_RES,
) {
  return normalizeDashcam({
    entry: entry(overrides),
    requestText,
    responseText,
    requestBytes: Buffer.byteLength(requestText),
    responseBytes: Buffer.byteLength(responseText),
    requestCapped: false,
    responseCapped: false,
  });
}

describe("非流式 JSON", () => {
  it("请求与返回展开为块，seq 全局连续", () => {
    const envelope = normalize();
    expect(envelope.schema).toBe("newapi.dashcam.v1");
    expect(envelope.request.messages.map((block) => block.role)).toEqual(["system", "user"]);
    expect(envelope.request.messages[0]?.text).toBe("你是一个测试助手");
    expect(envelope.response.outputs[0]?.text).toBe("这是非流式返回内容");
    expect(envelope.response.outputs[0]?.seq).toBe(2);
    expect(envelope.response.finishReason).toBe("stop");
    expect(envelope.response.usage).toEqual({
      promptTokens: 12,
      completionTokens: 9,
      totalTokens: 21,
      cachedTokens: 4,
    });
  });

  it("工具调用与工具结果各自成块", () => {
    const request = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "今天上海天气？" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"上海"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
      ],
    });
    const envelope = normalize({}, request, CHAT_RES);
    const kinds = envelope.request.messages.map((block) => block.kind);
    expect(kinds).toEqual(["text", "tool_call", "tool_result"]);
    expect(envelope.request.messages[1]?.tool?.name).toBe("get_weather");
    expect(envelope.request.messages[2]?.tool?.callId).toBe("call_1");
  });

  it("图片 data URL 只留元信息，不落 base64", () => {
    const b64 = Buffer.from("fake-png-bytes").toString("base64");
    const request = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
    });
    const envelope = normalize({}, request, CHAT_RES);
    const image = envelope.request.messages.find((block) => block.kind === "image");
    expect(image?.image?.mime).toBe("image/png");
    expect(image?.image?.bytes).toBe(Buffer.from(b64, "base64").length);
    expect(image?.image?.sha256).toHaveLength(8);
    expect(JSON.stringify(envelope)).not.toContain(b64);
  });

  it("错误体归入 response.error，不当作解析失败", () => {
    const errorBody =
      '{"error":{"code":"model_not_found","message":"No available channel","type":"new_api_error"}}';
    const envelope = normalize({ s: 503 }, CHAT_REQ, errorBody);
    expect(envelope.response.outputs).toEqual([]);
    expect(envelope.response.error?.code).toBe("model_not_found");
    expect(envelope.response.parseError).toBeUndefined();
  });
});

describe("流式 SSE", () => {
  it("按事件拼接文本，usage 取自独立块", () => {
    const envelope = normalize({ st: true }, CHAT_REQ, SSE_RES);
    expect(envelope.response.outputs.map((block) => block.text)).toEqual(["你好，这是流式响应。"]);
    expect(envelope.response.usage).toEqual({
      promptTokens: 14,
      completionTokens: 8,
      totalTokens: 22,
    });
    expect(envelope.response.stream).toEqual({ events: 6, done: true });
    expect(envelope.response.parseError).toBeUndefined();
  });

  it("未收到 [DONE] 标记为 stream_incomplete", () => {
    const cut = SSE_RES.split("\n\n").slice(0, 3).join("\n\n");
    const envelope = normalize({ st: true, tr: 2 }, CHAT_REQ, cut);
    expect(envelope.response.stream?.done).toBe(false);
    expect(envelope.response.parseError).toBe("response_truncated");
  });

  it("SSE 事件解析支持多行 data 与注释", () => {
    const events = parseSseEvents(": ping\nevent: message\ndata: a\ndata: b\n\ndata: [DONE]\n\n");
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("message");
    expect(events[0]?.data).toBe("a\nb");
  });

  it("流式工具调用按 index 聚合 arguments", () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"上海\\"}"}}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const envelope = normalize({ st: true }, CHAT_REQ, sse);
    const tool = envelope.response.outputs.find((block) => block.kind === "tool_call");
    expect(tool?.tool?.name).toBe("get_weather");
    expect(tool?.tool?.arguments).toBe('{"city":"上海"}');
  });
});

describe("Anthropic 与 Responses", () => {
  it("anthropic messages：system + content blocks + tool_use", () => {
    const request = JSON.stringify({
      model: "claude-3",
      system: "你是助手",
      messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    });
    const response = JSON.stringify({
      content: [
        { type: "text", text: "你好呀" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const envelope = normalize({ p: "/v1/messages" }, request, response);
    expect(envelope.request.protocol).toBe("anthropic-messages");
    expect(envelope.request.messages[0]?.role).toBe("system");
    expect(envelope.response.outputs.map((block) => block.kind)).toEqual(["text", "tool_call"]);
    expect(envelope.response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("responses API：instructions + output", () => {
    const request = JSON.stringify({
      model: "gpt-5",
      instructions: "简洁回答",
      input: "1+1=?",
    });
    const response = JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "2" }] }],
      usage: {
        input_tokens: 8,
        output_tokens: 1,
        total_tokens: 9,
        input_tokens_details: { cached_tokens: 6 },
      },
    });
    const envelope = normalize({ p: "/v1/responses" }, request, response);
    expect(envelope.request.protocol).toBe("openai-responses");
    expect(envelope.request.messages.map((block) => block.role)).toEqual(["system", "user"]);
    expect(envelope.response.outputs[0]?.text).toBe("2");
    expect(envelope.response.usage).toEqual({
      promptTokens: 8,
      completionTokens: 1,
      totalTokens: 9,
      cachedTokens: 6,
    });
  });
});

describe("截断与未知结构", () => {
  it("请求体截断：保留 parseError，不抛异常", () => {
    const envelope = normalize({ tr: 1 }, '{"model":"gpt-4o-mini","messages":[');
    expect(envelope.request.truncated).toBe(true);
    expect(envelope.request.parseError).toBe("request_truncated");
    expect(envelope.request.messages).toEqual([]);
  });

  it("响应体截断：标记 response_truncated", () => {
    const envelope = normalize({ tr: 2 }, CHAT_REQ, '{"choices":[{"message":{"content":"半');
    expect(envelope.response.parseError).toBe("response_truncated");
  });

  it("读取上限命中也算截断", () => {
    const envelope = normalizeDashcam({
      entry: entry(),
      requestText: CHAT_REQ,
      responseText: CHAT_RES,
      requestBytes: 12,
      responseBytes: 34,
      requestCapped: true,
      responseCapped: false,
    });
    expect(envelope.request.truncated).toBe(true);
  });

  it("未知路径仍尽力提取 messages", () => {
    const envelope = normalize({ p: "/v1/custom" }, CHAT_REQ);
    expect(envelope.request.protocol).toBe("unknown");
    expect(envelope.request.messages).toHaveLength(2);
  });
});
