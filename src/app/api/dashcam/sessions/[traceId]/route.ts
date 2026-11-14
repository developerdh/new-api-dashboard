/**
 * GET /api/dashcam/sessions/[traceId] —— 单次会话全文。
 *
 * 安全链（每一步失败都收敛为 404，不泄露存在性）：
 * 1. `traceId` / `date` / `fp` 三段白名单正则；
 * 2. 从**索引**取条目，`u` 必须属于该 `userId` 的指纹集合（客户端传什么不算数）；
 * 3. 文件路径由索引字段拼装，再经 `path.resolve` 前缀断言（`paths.ts`）。
 *
 * 同一天同名 trace 多条（客户端复用 `X-Request-Id` 重试）时返回 409，由列表带 `fp` 重新进入。
 */
import { connection } from "next/server";

import { DashcamAmbiguousError, dashcamError, toDashcamErrorResponse } from "@/server/dashcam/errors";
import { entryEpochSeconds, readIndexDay, usageOfIndexEntry } from "@/server/dashcam/index";
import { normalizeDashcam, normalizeRequestMessages } from "@/server/dashcam/normalize";
import { TRACE_PATTERN, dashcamDir, isDashcamAvailable } from "@/server/dashcam/paths";
import { parseDetailQuery } from "@/server/dashcam/query";
import { DashcamBlobMissingError, dashcamRawPreviewBytes, readDashcamBlob } from "@/server/dashcam/reader";
import { computeThreadDelta } from "@/server/dashcam/thread";
import type { DashcamBlock, DashcamSessionDetail, DashcamThreadDelta } from "@/server/dashcam/types";
import { ok } from "@/server/http";
import { fingerprintsOfUser, loadTokenFingerprints } from "@/server/queries/dashcam-tokens";

/** 原始报文预览截断（按字节，避免多字节字符被二次放大）。 */
function preview(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/**
 * 读上一轮请求的消息列表（线程增量用）。
 *
 * 匹配条件必须同时满足 `trace + 指纹 + 会话键`：
 * 只按 trace 找的话，客户端复用 `X-Request-Id` 时可能命中另一条会话的请求，
 * 差分结果会串台。找不到 / 读不到正文时返回空，由调用方标注原因降级。
 */
async function resolvePrevMessages(input: {
  dir: string;
  prev: { traceId: string; date: string };
  current: { u: string; k?: string };
  fingerprints: ReadonlySet<string>;
}): Promise<{ messages?: DashcamBlock[]; parseFailed: boolean }> {
  const day = await readIndexDay(input.dir, input.prev.date);
  const entry = day.entries.find(
    (item) =>
      item.t === input.prev.traceId && item.u === input.current.u && item.k === input.current.k,
  );
  if (entry === undefined || !input.fingerprints.has(entry.u)) {
    return { parseFailed: false };
  }

  let blob: Awaited<ReturnType<typeof readDashcamBlob>>;
  try {
    blob = await readDashcamBlob({
      dir: input.dir,
      date: input.prev.date,
      fp: entry.u,
      trace: entry.t,
      kind: "req",
      gzip: entry.qz,
    });
  } catch {
    return { parseFailed: false }; // 已被清理：降级为「展示全部上下文」
  }

  const parsed = normalizeRequestMessages({
    entry,
    requestText: blob.text,
    requestCapped: blob.capped,
  });
  if (parsed.parseError !== undefined) return { parseFailed: true };
  return { messages: parsed.messages, parseFailed: false };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  await connection();

  try {
    const { traceId: rawTrace } = await context.params;
    let trace: string;
    try {
      trace = decodeURIComponent(rawTrace);
    } catch {
      return dashcamError(400, "invalid_query", "traceId 编码非法", [
        { path: "traceId", message: "traceId 编码非法" },
      ]);
    }
    if (!TRACE_PATTERN.test(trace)) {
      return dashcamError(400, "invalid_query", "traceId 不合法", [
        { path: "traceId", message: "traceId 不合法" },
      ]);
    }

    const query = parseDetailQuery(new URL(request.url).searchParams);
    const dir = dashcamDir();
    if (dir === null || !(await isDashcamAvailable(dir))) {
      return toDashcamErrorResponse(new DashcamBlobMissingError());
    }

    const tokens = await loadTokenFingerprints();
    const fingerprints = fingerprintsOfUser(tokens, query.userId);
    if (!tokens.ok || fingerprints.size === 0) {
      return toDashcamErrorResponse(new DashcamBlobMissingError());
    }

    const day = await readIndexDay(dir, query.date);
    const matched = day.entries.filter(
      (entry) => entry.t === trace && (query.fp === undefined || entry.u === query.fp),
    );
    if (matched.length === 0) return toDashcamErrorResponse(new DashcamBlobMissingError());
    if (matched.length > 1) throw new DashcamAmbiguousError();

    const entry = matched[0];
    if (entry === undefined || !fingerprints.has(entry.u)) {
      return toDashcamErrorResponse(new DashcamBlobMissingError());
    }

    const [requestBlob, responseBlob] = await Promise.all([
      readDashcamBlob({
        dir,
        date: query.date,
        fp: entry.u,
        trace: entry.t,
        kind: "req",
        gzip: entry.qz,
      }),
      readDashcamBlob({
        dir,
        date: query.date,
        fp: entry.u,
        trace: entry.t,
        kind: "res",
        gzip: entry.rz,
      }),
    ]);

    const envelope = normalizeDashcam({
      entry,
      requestText: requestBlob.text,
      responseText: responseBlob.text,
      requestBytes: requestBlob.bytes,
      responseBytes: responseBlob.bytes,
      requestCapped: requestBlob.capped,
      responseCapped: responseBlob.capped,
    });
    // token 以索引字段为准（采集端提取，是唯一权威来源，与列表/线程天然一致）；
    // 旧数据索引无字段时保留正文解析结果
    const indexUsage = usageOfIndexEntry(entry);
    if (indexUsage !== undefined) {
      envelope.response.usage = indexUsage;
    }

    const rawMax = dashcamRawPreviewBytes();
    const rawRequest = preview(requestBlob.text, rawMax);
    const rawResponse = preview(responseBlob.text, rawMax);

    let delta: DashcamThreadDelta | undefined;
    if (query.prev !== undefined) {
      const prev = await resolvePrevMessages({
        dir,
        prev: query.prev,
        current: { u: entry.u, ...(entry.k === undefined ? {} : { k: entry.k }) },
        fingerprints,
      });
      delta = computeThreadDelta({
        prevTraceId: query.prev.traceId,
        ...(prev.messages === undefined ? {} : { prevMessages: prev.messages }),
        currentMessages: envelope.request.messages,
        prevParseFailed: prev.parseFailed,
      });
    }

    const data: DashcamSessionDetail = {
      envelope,
      raw: {
        request: rawRequest.text,
        response: rawResponse.text,
        requestTruncated: requestBlob.capped || rawRequest.truncated,
        responseTruncated: responseBlob.capped || rawResponse.truncated,
      },
      ...(delta === undefined ? {} : { delta }),
    };

    const epoch = entryEpochSeconds(entry);
    return ok(data, {
      range: { start: epoch, end: epoch + 1 },
      granularity: null,
      cached: false,
      source: "dashcam-files",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[dashcam/sessions/:trace] failed", message);
    return toDashcamErrorResponse(error);
  }
}
