/**
 * 线程增量：本轮请求相对上一轮的**新增消息**。
 *
 * 背景：同一会话里客户端每轮都把完整历史重发一遍，所以「打开第 37 轮」
 * 看到的前 36 轮内容和第 36 轮完全一样。列表层没法解决，只能在这一层做差分。
 *
 * 判定口径：
 * 1. 对两轮请求的消息逐条做**内容签名**（角色 + 类型 + 文本 + 工具字段），
 *    不用 `seq`/`messageIndex`——那是信封内的局部序号，跨轮不可比；
 * 2. 取最长公共前缀 `lcp`；`lcp === 上一轮条数` 才算「连续」，
 *    否则说明历史被裁剪（上下文超限截断）、并发分支或换了会话键；
 * 3. 新增部分 = 当前请求 `slice(lcp)`，原样保留（不做"去掉上一轮回答"的启发式：
 *    工具循环里 `assistant tool_call` / `tool` 结果就是本轮真正新增的内容，
 *    过滤会把它们吞掉）。
 *
 * 展示侧的取舍由界面负责（把开头的 assistant/tool 块标为「上下文回放」），
 * 服务端只保证「哪些是新出现的」这一事实准确。
 */
import { createHash } from "node:crypto";

import type { DashcamBlock, DashcamThreadDelta } from "./types";

/** 消息内容签名：只取会进入模型上下文的语义字段。 */
export function blockSignature(block: DashcamBlock): string {
  const payload = [
    block.role,
    block.kind,
    block.text ?? "",
    block.tool?.name ?? "",
    block.tool?.arguments ?? "",
    block.tool?.callId ?? "",
    block.image === undefined ? "" : `${block.image.mime}:${block.image.sha256}`,
  ].join("\u0000");
  return createHash("sha1").update(payload, "utf8").digest("base64url");
}

/** 最长公共前缀长度。 */
export function commonPrefixLength(prev: string[], next: string[]): number {
  const limit = Math.min(prev.length, next.length);
  let index = 0;
  while (index < limit && prev[index] === next[index]) index += 1;
  return index;
}

/**
 * 计算增量。`prevMessages` 为 `undefined` 表示上一轮不可读（文件缺失 / 解析失败），
 * 此时返回整份消息并标注原因，界面退化为「展示全部上下文」。
 */
export function computeThreadDelta(input: {
  prevTraceId: string;
  prevMessages?: DashcamBlock[];
  currentMessages: DashcamBlock[];
  prevParseFailed?: boolean;
}): DashcamThreadDelta {
  const { prevTraceId, prevMessages, currentMessages } = input;

  if (prevMessages === undefined) {
    return {
      prevTraceId,
      priorMessages: 0,
      commonPrefix: 0,
      news: currentMessages,
      continuous: false,
      reason: input.prevParseFailed === true ? "prev_parse_failed" : "prev_missing",
    };
  }

  const prefix = commonPrefixLength(prevMessages.map(blockSignature), currentMessages.map(blockSignature));
  return {
    prevTraceId,
    priorMessages: prevMessages.length,
    commonPrefix: prefix,
    news: currentMessages.slice(prefix),
    // 前缀必须覆盖上一轮全部消息，才算"本轮是在上一轮基础上继续"
    continuous: prefix >= prevMessages.length,
  };
}
