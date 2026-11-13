/**
 * 协议归一化：三种协议 × 两种响应形态 → 统一信封（`newapi.audit.v1`）。
 *
 * 为什么放在看板而不是代理：`docs/audit-proxy/04-decisions.md` D8。代理只做透传 + 落盘，
 * 解析规则演进不需要重新编译关键路径上的二进制。
 *
 * 覆盖范围（实测样本 + 官方协议）：
 * - 请求：`/v1/chat/completions`、`/v1/completions`、`/v1/messages`、`/v1/responses`；
 * - 响应：非流式 JSON、流式 SSE（`data:` 行，含 `usage` 独立块与 `[DONE]`）、错误体 `{error:{…}}`；
 * - 截断：`tr` 位或读取上限命中时保留原始报文并标记 `parseError`，**不抛异常**。
 *
 * 本文件是纯函数：不读文件、不碰 env、不写日志。
 */
import { createHash } from "node:crypto";

import type {
  AuditBlock,
  AuditEnvelope,
  AuditIndexEntry,
  AuditKind,
  AuditProtocol,
  AuditRequestBody,
  AuditResponseBody,
  AuditRole,
} from "./types";
import { AUDIT_SCHEMA } from "./types";

/* ------------------------------------------------------------------ */
/* 协议识别                                                            */
/* ------------------------------------------------------------------ */

export function detectProtocol(path: string): AuditProtocol {
  switch (path) {
    case "/v1/chat/completions":
      return "openai-chat";
    case "/v1/completions":
      return "openai-completions";
    case "/v1/messages":
      return "anthropic-messages";
    case "/v1/responses":
      return "openai-responses";
    default:
      return "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function shortSha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function toRole(value: unknown): AuditRole {
  switch (value) {
    case "system":
    case "developer":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
    case "function":
      return "tool";
    default:
      return "unknown";
  }
}

interface Collector {
  push: (
    role: AuditRole,
    kind: AuditKind,
    messageIndex: number,
    extra?: { text?: string; tool?: AuditBlock["tool"]; image?: AuditBlock["image"] },
  ) => void;
  blocks: AuditBlock[];
}

function createCollector(startSeq = 0): Collector {
  const blocks: AuditBlock[] = [];
  return {
    blocks,
    push(role, kind, messageIndex, extra = {}) {
      blocks.push({
        seq: startSeq + blocks.length,
        messageIndex,
        role,
        kind,
        ...(extra.text === undefined ? {} : { text: extra.text }),
        ...(extra.tool === undefined ? {} : { tool: extra.tool }),
        ...(extra.image === undefined ? {} : { image: extra.image }),
      });
    },
  };
}

/** data URL → 元信息；只留 mime / bytes / sha256，正文丢弃（02-design §7.4）。 */
function imageFromDataUrl(url: string): AuditBlock["image"] | undefined {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);
  if (match === null) return undefined;
  const mime = match[1] ?? "application/octet-stream";
  const isBase64 = match[2] !== undefined;
  const payload = match[3] ?? "";
  if (!isBase64) {
    return { mime, bytes: Buffer.byteLength(payload, "utf8"), sha256: shortSha256(payload) };
  }
  try {
    const buffer = Buffer.from(payload, "base64");
    return { mime, bytes: buffer.length, sha256: shortSha256(buffer) };
  } catch {
    return { mime, bytes: Math.floor((payload.length * 3) / 4), sha256: shortSha256(payload) };
  }
}

/** 图片块：data URL 解元信息；外链只记 `url` 与大小未知，URL 本身不入信封。 */
function pushImage(collector: Collector, role: AuditRole, messageIndex: number, source: string): void {
  if (source.startsWith("data:")) {
    const image = imageFromDataUrl(source);
    collector.push(role, "image", messageIndex, {
      image: image ?? { mime: "unknown", bytes: 0, sha256: "" },
    });
    return;
  }
  collector.push(role, "image", messageIndex, {
    image: { mime: "url", bytes: 0, sha256: "" },
  });
}

function pushText(collector: Collector, role: AuditRole, messageIndex: number, text: string): void {
  if (text === "") return;
  collector.push(role, "text", messageIndex, { text });
}

/** 工具调用：`arguments` 保持原始字符串，不做二次解析（截断时也能展示）。 */
function pushToolCall(
  collector: Collector,
  role: AuditRole,
  messageIndex: number,
  name: string | undefined,
  callId: string | undefined,
  args: string | undefined,
): void {
  collector.push(role, "tool_call", messageIndex, {
    tool: { name, callId, arguments: args ?? "" },
  });
}

/** 未知结构降级：保留可读片段，避免整条消息消失。 */
function pushUnknownPart(collector: Collector, role: AuditRole, messageIndex: number, part: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(part) ?? String(part);
  } catch {
    text = String(part);
  }
  collector.push(role, "other", messageIndex, {
    text: text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text,
  });
}

/* ------------------------------------------------------------------ */
/* 请求侧                                                              */
/* ------------------------------------------------------------------ */

/** OpenAI chat 的 content：string 或 parts 数组。 */
function pushOpenAiContent(
  collector: Collector,
  role: AuditRole,
  messageIndex: number,
  content: unknown,
): void {
  if (typeof content === "string") {
    pushText(collector, role, messageIndex, content);
    return;
  }
  for (const part of asArray(content)) {
    const record = asRecord(part);
    if (record === undefined) {
      if (typeof part === "string") pushText(collector, role, messageIndex, part);
      continue;
    }
    const type = asString(record.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      pushText(collector, role, messageIndex, asString(record.text) ?? "");
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const imageUrl = record.image_url;
      const url =
        typeof imageUrl === "string"
          ? imageUrl
          : asString(asRecord(imageUrl)?.url) ?? asString(record.url);
      if (url !== undefined) pushImage(collector, role, messageIndex, url);
      continue;
    }
    pushUnknownPart(collector, role, messageIndex, part);
  }
}

/** Anthropic 的 content：string 或 block 数组。 */
function pushAnthropicContent(
  collector: Collector,
  role: AuditRole,
  messageIndex: number,
  content: unknown,
): void {
  if (typeof content === "string") {
    pushText(collector, role, messageIndex, content);
    return;
  }
  for (const block of asArray(content)) {
    const record = asRecord(block);
    if (record === undefined) continue;
    const type = asString(record.type);
    if (type === "text") {
      pushText(collector, role, messageIndex, asString(record.text) ?? "");
      continue;
    }
    if (type === "image") {
      const source = asRecord(record.source);
      if (asString(source?.type) === "url") {
        const url = asString(source?.url);
        if (url !== undefined) pushImage(collector, role, messageIndex, url);
      } else {
        const payload = asString(source?.data) ?? "";
        const mime = asString(source?.media_type) ?? "unknown";
        const buffer = Buffer.from(payload, "base64");
        collector.push(role, "image", messageIndex, {
          image: { mime, bytes: buffer.length, sha256: shortSha256(buffer) },
        });
      }
      continue;
    }
    if (type === "tool_use") {
      pushToolCall(
        collector,
        role,
        messageIndex,
        asString(record.name),
        asString(record.id),
        JSON.stringify(record.input ?? {}),
      );
      continue;
    }
    if (type === "tool_result") {
      const inner = record.content;
      const text =
        typeof inner === "string"
          ? inner
          : asArray(inner)
              .map((item) => asString(asRecord(item)?.text) ?? "")
              .join("\n");
      collector.push(role, "tool_result", messageIndex, {
        text: text === "" ? JSON.stringify(inner ?? null) : text,
        tool: { callId: asString(record.tool_use_id) },
      });
      continue;
    }
    pushUnknownPart(collector, role, messageIndex, block);
  }
}

function collectChatMessages(
  collector: Collector,
  messages: unknown,
  parseContent: (c: Collector, role: AuditRole, index: number, content: unknown) => void,
): void {
  asArray(messages).forEach((message, index) => {
    const record = asRecord(message);
    if (record === undefined) return;
    const role = toRole(record.role);
    const toolCalls = asArray(record.tool_calls);
    if (toolCalls.length > 0) {
      toolCalls.forEach((call) => {
        const callRecord = asRecord(call);
        const fn = asRecord(callRecord?.function);
        pushToolCall(
          collector,
          "assistant",
          index,
          asString(fn?.name),
          asString(callRecord?.id),
          asString(fn?.arguments) ?? JSON.stringify(fn?.arguments ?? {}),
        );
      });
      if (record.content !== undefined && record.content !== null) {
        parseContent(collector, role, index, record.content);
      }
      return;
    }
    if (role === "tool") {
      const content = record.content;
      const text =
        typeof content === "string" ? content : (JSON.stringify(content ?? null) ?? "");
      collector.push(role, "tool_result", index, {
        text,
        tool: { callId: asString(record.tool_call_id) },
      });
      return;
    }
    parseContent(collector, role, index, record.content);
  });
}

function collectToolDefinitions(value: unknown): Array<{ name: string; description?: string }> {
  const tools: Array<{ name: string; description?: string }> = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const fn = asRecord(record.function) ?? record;
    const name = asString(fn.name);
    if (name === undefined) continue;
    const description = asString(fn.description);
    tools.push(description === undefined ? { name } : { name, description });
  }
  return tools;
}

interface RequestParseResult {
  blocks: AuditBlock[];
  tools?: Array<{ name: string; description?: string }>;
  model?: string;
  stream?: boolean;
  parseError?: string;
}

function parseRequest(protocol: AuditProtocol, text: string, truncated: boolean): RequestParseResult {
  if (text.trim() === "") return { blocks: [] };
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { blocks: [], parseError: truncated ? "request_truncated" : "invalid_json" };
  }
  const body = asRecord(parsed.value);
  if (body === undefined) return { blocks: [], parseError: "invalid_json" };

  const collector = createCollector();
  const model = asString(body.model);
  const stream = body.stream === true;
  const tools = collectToolDefinitions(body.tools);

  switch (protocol) {
    case "openai-chat":
      collectChatMessages(collector, body.messages, pushOpenAiContent);
      break;
    case "openai-completions": {
      const prompt = body.prompt;
      if (typeof prompt === "string") {
        pushText(collector, "user", 0, prompt);
      } else {
        asArray(prompt).forEach((item, index) => {
          if (typeof item === "string") pushText(collector, "user", index, item);
        });
      }
      break;
    }
    case "anthropic-messages": {
      const system = body.system;
      if (typeof system === "string") {
        pushText(collector, "system", 0, system);
      } else {
        asArray(system).forEach((block) => {
          pushAnthropicContent(collector, "system", 0, [block]);
        });
      }
      collectChatMessages(collector, body.messages, pushAnthropicContent);
      break;
    }
    case "openai-responses": {
      const instructions = asString(body.instructions);
      if (instructions !== undefined) pushText(collector, "system", 0, instructions);
      const input = body.input;
      if (typeof input === "string") {
        pushText(collector, "user", 0, input);
      } else {
        asArray(input).forEach((item, index) => {
          const record = asRecord(item);
          if (record === undefined) {
            if (typeof item === "string") pushText(collector, "user", index, item);
            return;
          }
          const role = toRole(record.role);
          pushOpenAiContent(collector, role, index, record.content);
        });
      }
      break;
    }
    default:
      // 未知路径：尽力从 messages / prompt / input 取内容
      if (body.messages !== undefined) {
        collectChatMessages(collector, body.messages, pushOpenAiContent);
      } else if (body.prompt !== undefined) {
        pushText(collector, "user", 0, typeof body.prompt === "string" ? body.prompt : "");
      } else if (body.input !== undefined) {
        pushText(collector, "user", 0, typeof body.input === "string" ? body.input : "");
      }
      break;
  }

  return {
    blocks: collector.blocks,
    ...(tools.length === 0 ? {} : { tools }),
    ...(model === undefined ? {} : { model }),
    ...(stream ? { stream: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 响应侧                                                              */
/* ------------------------------------------------------------------ */

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

function readOpenAiUsage(value: unknown): Usage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const prompt = asNumber(record.prompt_tokens);
  const completion = asNumber(record.completion_tokens);
  const total = asNumber(record.total_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt === undefined ? {} : { promptTokens: prompt }),
    ...(completion === undefined ? {} : { completionTokens: completion }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
}

function readAnthropicUsage(value: unknown): Usage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const input = asNumber(record.input_tokens);
  const output = asNumber(record.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { promptTokens: input }),
    ...(output === undefined ? {} : { completionTokens: output }),
    ...(input === undefined || output === undefined ? {} : { totalTokens: input + output }),
  };
}

function readResponsesUsage(value: unknown): Usage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const input = asNumber(record.input_tokens);
  const output = asNumber(record.output_tokens);
  const total = asNumber(record.total_tokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { promptTokens: input }),
    ...(output === undefined ? {} : { completionTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
}

interface ResponseParseResult {
  outputs: AuditBlock[];
  finishReason?: string;
  usage?: Usage;
  error?: { code?: string; type?: string; message?: string };
  stream?: { events: number; done: boolean };
  parseError?: string;
}

function parseErrorBody(record: JsonRecord): ResponseParseResult["error"] | undefined {
  const error = asRecord(record.error);
  if (error === undefined) return undefined;
  return {
    ...(asString(error.code) === undefined ? {} : { code: asString(error.code) }),
    ...(asString(error.type) === undefined ? {} : { type: asString(error.type) }),
    ...(asString(error.message) === undefined ? {} : { message: asString(error.message) }),
  };
}

function parseJsonResponse(protocol: AuditProtocol, value: unknown): ResponseParseResult {
  const record = asRecord(value);
  if (record === undefined) {
    return { outputs: [], parseError: "invalid_json" };
  }
  const error = parseErrorBody(record);
  if (error !== undefined) return { outputs: [], error };

  const collector = createCollector();

  if (protocol === "openai-chat" || protocol === "unknown") {
    const choice = asRecord(asArray(record.choices)[0]);
    const message = asRecord(choice?.message);
    if (message !== undefined) {
      const toolCalls = asArray(message.tool_calls);
      if (toolCalls.length > 0) {
        toolCalls.forEach((call) => {
          const callRecord = asRecord(call);
          const fn = asRecord(callRecord?.function);
          pushToolCall(
            collector,
            "assistant",
            0,
            asString(fn?.name),
            asString(callRecord?.id),
            asString(fn?.arguments),
          );
        });
      }
      const reasoning = asString(message.reasoning_content);
      if (reasoning !== undefined && reasoning !== "") {
        collector.push("assistant", "other", 0, { text: reasoning });
      }
      pushOpenAiContent(collector, "assistant", 0, message.content);
      const finishReason = asString(choice?.finish_reason);
      const usage = readOpenAiUsage(record.usage);
      return {
        outputs: collector.blocks,
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
    // `/v1/completions`：choices[0].text
    const legacy = asRecord(asArray(record.choices)[0]);
    const legacyText = asString(legacy?.text);
    if (legacyText !== undefined) {
      pushText(collector, "assistant", 0, legacyText);
      const legacyFinish = asString(legacy?.finish_reason);
      const legacyUsage = readOpenAiUsage(record.usage);
      return {
        outputs: collector.blocks,
        ...(legacyFinish === undefined ? {} : { finishReason: legacyFinish }),
        ...(legacyUsage === undefined ? {} : { usage: legacyUsage }),
      };
    }
    return { outputs: [], parseError: "unrecognized_body" };
  }

  if (protocol === "anthropic-messages") {
    asArray(record.content).forEach((block, index) => {
      pushAnthropicContent(collector, "assistant", index, [block]);
    });
    return {
      outputs: collector.blocks,
      ...(asString(record.stop_reason) === undefined
        ? {}
        : { finishReason: asString(record.stop_reason) }),
      ...(readAnthropicUsage(record.usage) === undefined
        ? {}
        : { usage: readAnthropicUsage(record.usage) }),
    };
  }

  // openai-responses
  asArray(record.output).forEach((item, index) => {
    const recordItem = asRecord(item);
    if (recordItem === undefined) return;
    const type = asString(recordItem.type);
    if (type === "function_call") {
      pushToolCall(
        collector,
        "assistant",
        index,
        asString(recordItem.name),
        asString(recordItem.call_id),
        asString(recordItem.arguments),
      );
      return;
    }
    const content = recordItem.content;
    if (content !== undefined) {
      pushOpenAiContent(collector, "assistant", index, content);
      return;
    }
    const text = asString(recordItem.text);
    if (text !== undefined) pushText(collector, "assistant", index, text);
  });
  return {
    outputs: collector.blocks,
    ...(asString(record.status) === undefined ? {} : { finishReason: asString(record.status) }),
    ...(readResponsesUsage(record.usage) === undefined
      ? {}
      : { usage: readResponsesUsage(record.usage) }),
  };
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

export interface SseEvent {
  event?: string;
  data: string;
}

/** 按空行切事件块，收集多行 `data:`；忽略注释与 `id:`。 */
export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (block.trim() === "") continue;
    const dataLines: string[] = [];
    let eventName: string | undefined;
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith(":")) continue;
      const line = rawLine.trimEnd();
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    events.push({
      ...(eventName === undefined ? {} : { event: eventName }),
      data: dataLines.join("\n"),
    });
  }
  return events;
}

interface ChatStreamState {
  text: string;
  reasoning: string;
  tools: Map<number, { id?: string; name?: string; args: string }>;
  finishReason?: string;
  usage?: Usage;
  events: number;
  done: boolean;
}

function parseChatSse(events: SseEvent[]): ResponseParseResult {
  const state: ChatStreamState = {
    text: "",
    reasoning: "",
    tools: new Map(),
    events: events.length,
    done: false,
  };

  for (const event of events) {
    if (event.data === "[DONE]") {
      state.done = true;
      continue;
    }
    const parsed = parseJson(event.data);
    if (!parsed.ok) continue;
    const chunk = asRecord(parsed.value);
    if (chunk === undefined) continue;
    const usage = readOpenAiUsage(chunk.usage);
    if (usage !== undefined) state.usage = usage;

    for (const choiceValue of asArray(chunk.choices)) {
      const choice = asRecord(choiceValue);
      if (choice === undefined) continue;
      const finish = asString(choice.finish_reason);
      if (finish !== undefined && finish !== "") state.finishReason = finish;
      const delta = asRecord(choice.delta);
      if (delta === undefined) continue;
      const content = asString(delta.content);
      if (content !== undefined) state.text += content;
      // `/v1/completions` 的流式增量没有 delta，直接给 `choices[0].text`
      const legacyText = asString(choice.text);
      if (legacyText !== undefined) state.text += legacyText;
      const reasoning = asString(delta.reasoning_content);
      if (reasoning !== undefined) state.reasoning += reasoning;

      for (const callValue of asArray(delta.tool_calls)) {
        const call = asRecord(callValue);
        if (call === undefined) continue;
        const index = asNumber(call.index) ?? 0;
        const current = state.tools.get(index) ?? { args: "" };
        const id = asString(call.id);
        if (id !== undefined && id !== "") current.id = id;
        const fn = asRecord(call.function);
        const name = asString(fn?.name);
        if (name !== undefined && name !== "") current.name = name;
        const args = asString(fn?.arguments);
        if (args !== undefined) current.args += args;
        state.tools.set(index, current);
      }
    }
  }

  const collector = createCollector();
  if (state.reasoning !== "") {
    collector.push("assistant", "other", 0, { text: state.reasoning });
  }
  pushText(collector, "assistant", 0, state.text);
  for (const index of [...state.tools.keys()].sort((a, b) => a - b)) {
    const tool = state.tools.get(index);
    if (tool === undefined) continue;
    pushToolCall(collector, "assistant", 0, tool.name, tool.id, tool.args);
  }

  return {
    outputs: collector.blocks,
    ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    stream: { events: state.events, done: state.done },
    ...(state.done || events.length === 0 ? {} : { parseError: "stream_incomplete" }),
  };
}

function parseAnthropicSse(events: SseEvent[]): ResponseParseResult {
  const blocks = new Map<number, { type: "text" | "tool_use"; text: string; id?: string; name?: string; args: string }>();
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  let done = false;
  let inputTokens: number | undefined;

  for (const event of events) {
    const parsed = parseJson(event.data);
    if (!parsed.ok) continue;
    const payload = asRecord(parsed.value);
    if (payload === undefined) continue;
    const type = event.event ?? asString(payload.type);

    if (type === "message_start") {
      const startUsage = asNumber(asRecord(asRecord(payload.message)?.usage)?.input_tokens);
      if (startUsage !== undefined) inputTokens = startUsage;
      continue;
    }
    if (type === "content_block_start") {
      const index = asNumber(payload.index) ?? 0;
      const contentBlock = asRecord(payload.content_block);
      const blockType = asString(contentBlock?.type);
      blocks.set(index, {
        type: blockType === "tool_use" ? "tool_use" : "text",
        text: asString(contentBlock?.text) ?? "",
        id: asString(contentBlock?.id),
        name: asString(contentBlock?.name),
        args: "",
      });
      continue;
    }
    if (type === "content_block_delta") {
      const index = asNumber(payload.index) ?? 0;
      const current = blocks.get(index) ?? { type: "text" as const, text: "", args: "" };
      const delta = asRecord(payload.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "text_delta") current.text += asString(delta?.text) ?? "";
      else if (deltaType === "input_json_delta") current.args += asString(delta?.partial_json) ?? "";
      else if (deltaType === "thinking_delta") current.text += asString(delta?.thinking) ?? "";
      blocks.set(index, current);
      continue;
    }
    if (type === "message_delta") {
      const stop = asString(asRecord(payload.delta)?.stop_reason);
      if (stop !== undefined && stop !== "") finishReason = stop;
      const deltaUsage = asNumber(asRecord(payload.usage)?.output_tokens);
      if (deltaUsage !== undefined) {
        usage = {
          ...(inputTokens === undefined ? {} : { promptTokens: inputTokens }),
          completionTokens: deltaUsage,
          ...(inputTokens === undefined ? {} : { totalTokens: inputTokens + deltaUsage }),
        };
      }
      done = true;
      continue;
    }
    if (type === "message_stop") done = true;
  }

  const collector = createCollector();
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index);
    if (block === undefined) continue;
    if (block.type === "tool_use") {
      pushToolCall(collector, "assistant", index, block.name, block.id, block.args);
      continue;
    }
    pushText(collector, "assistant", index, block.text);
  }

  return {
    outputs: collector.blocks,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    stream: { events: events.length, done },
    ...(done ? {} : { parseError: "stream_incomplete" }),
  };
}

function parseResponsesSse(events: SseEvent[]): ResponseParseResult {
  let text = "";
  let done = false;
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  const tools = new Map<string, { name?: string; args: string }>();

  for (const event of events) {
    const parsed = parseJson(event.data);
    if (!parsed.ok) continue;
    const payload = asRecord(parsed.value);
    if (payload === undefined) continue;
    const type = event.event ?? asString(payload.type);

    if (type === "response.output_text.delta") {
      text += asString(payload.delta) ?? "";
      continue;
    }
    if (type === "response.output_item.added") {
      const item = asRecord(payload.item);
      if (asString(item?.type) === "function_call") {
        const id = asString(item?.id) ?? "0";
        tools.set(id, { name: asString(item?.name), args: "" });
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const id = asString(payload.item_id) ?? "0";
      const current = tools.get(id) ?? { args: "" };
      current.args += asString(payload.delta) ?? "";
      tools.set(id, current);
      continue;
    }
    if (type === "response.completed") {
      const response = asRecord(payload.response);
      usage = readResponsesUsage(response?.usage) ?? usage;
      finishReason = asString(response?.status) ?? finishReason;
      done = true;
      continue;
    }
    if (type === "response.failed" || type === "error") {
      done = true;
      continue;
    }
  }

  const collector = createCollector();
  pushText(collector, "assistant", 0, text);
  for (const tool of tools.values()) {
    pushToolCall(collector, "assistant", 0, tool.name, undefined, tool.args);
  }

  return {
    outputs: collector.blocks,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    stream: { events: events.length, done },
    ...(done ? {} : { parseError: "stream_incomplete" }),
  };
}

function parseSseResponse(protocol: AuditProtocol, text: string): ResponseParseResult {
  const events = parseSseEvents(text);
  if (events.length === 0) return { outputs: [], parseError: "stream_incomplete" };
  switch (protocol) {
    case "anthropic-messages":
      return parseAnthropicSse(events);
    case "openai-responses":
      return parseResponsesSse(events);
    default:
      return parseChatSse(events);
  }
}

/** 代理不落响应头，只能按内容首字符判定形态。 */
function looksLikeSse(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith("data:") || head.startsWith("event:");
}

function parseResponse(
  protocol: AuditProtocol,
  text: string,
  truncated: boolean,
): ResponseParseResult {
  if (text.trim() === "") return { outputs: [] };

  if (looksLikeSse(text)) {
    const parsed = parseSseResponse(protocol, text);
    if (parsed.parseError === "stream_incomplete" && truncated) {
      return { ...parsed, parseError: "response_truncated" };
    }
    return parsed;
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    return {
      outputs: [],
      parseError: truncated ? "response_truncated" : "invalid_json",
    };
  }
  const result = parseJsonResponse(protocol, parsed.value);
  if (result.parseError === "unrecognized_body" && truncated) {
    return { ...result, parseError: "response_truncated" };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export interface NormalizeInput {
  entry: AuditIndexEntry;
  requestText: string;
  responseText: string;
  requestBytes: number;
  responseBytes: number;
  requestCapped: boolean;
  responseCapped: boolean;
}

/**
 * 原始报文 → 统一信封。
 * 不变式：`seq` 在整份信封内全局递增（请求块在前，响应块续号）。
 */
export function normalizeAudit(input: NormalizeInput): AuditEnvelope {
  const { entry } = input;
  const protocol = detectProtocol(entry.p);
  const requestTruncated = (entry.tr & 1) === 1 || input.requestCapped;
  const responseTruncated = (entry.tr & 2) === 2 || input.responseCapped;

  const request = parseRequest(protocol, input.requestText, requestTruncated);
  const response = parseResponse(protocol, input.responseText, responseTruncated);

  const requestBody: AuditRequestBody = {
    path: entry.p,
    protocol,
    model: request.model ?? entry.m,
    stream: request.stream ?? entry.st,
    messages: request.blocks,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    truncated: requestTruncated,
    bytes: input.requestBytes,
    ...(request.parseError === undefined ? {} : { parseError: request.parseError }),
  };

  const responseBody: AuditResponseBody = {
    status: entry.s,
    outputs: response.outputs.map((block, index) => ({ ...block, seq: request.blocks.length + index })),
    truncated: responseTruncated,
    bytes: input.responseBytes,
    ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(response.error === undefined ? {} : { error: response.error }),
    ...(response.stream === undefined ? {} : { stream: response.stream }),
    ...(response.parseError === undefined ? {} : { parseError: response.parseError }),
  };

  return {
    schema: AUDIT_SCHEMA,
    traceId: entry.t,
    request: requestBody,
    response: responseBody,
    meta: {
      truncated: entry.tr,
      latencyMs: entry.ms,
      firstTokenMs: entry.ft,
      capturedAt: entry.d,
      requestBytes: entry.rq,
      responseBytes: entry.rs,
      gzip: { request: entry.qz, response: entry.rz },
      ...(entry.ip === undefined ? {} : { ip: entry.ip }),
    },
  };
}
