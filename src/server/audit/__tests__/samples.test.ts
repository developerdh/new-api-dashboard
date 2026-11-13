import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readIndexDay, scanSessions } from "@/server/audit/index";
import { normalizeAudit } from "@/server/audit/normalize";
import { readAuditBlob } from "@/server/audit/reader";

/**
 * 真实样本集成测试：用测试机（192.168.4.3）2026-11-13 的采集产物验证读取链路。
 *
 * `data/audit/` 在 `.gitignore` 内，CI 上没有该目录时整体跳过；
 * 本地执行 `verify.sh` 或从测试机同步样本后才会真正跑。
 */
const SAMPLE_DIR = join(process.cwd(), "data", "audit");
const SAMPLE_DATE = "2026-11-13";
const HAS_SAMPLE = existsSync(join(SAMPLE_DIR, "index", `${SAMPLE_DATE}.ndjson`));

/** 测试机 `tokens.id=1 / user_id=1` 的指纹（已由远程库 sha256 计算确认）。 */
const FP_USER_1 = "dbbbf1891a47";

const START = Math.floor(Date.parse(`${SAMPLE_DATE}T00:00:00+08:00`) / 1000);
const END = Math.floor(Date.parse("2026-11-14T00:00:00+08:00") / 1000);

describe.skipIf(!HAS_SAMPLE)("真实样本：列表", () => {
  it("只归属该用户：9 条命中、1 条未知指纹被排除", async () => {
    const result = await scanSessions({
      dir: SAMPLE_DIR,
      start: START,
      end: END,
      maxDays: 31,
      fingerprints: new Set([FP_USER_1]),
      knownFingerprints: new Set([FP_USER_1]),
      limit: 50,
    });
    expect(result.rows).toHaveLength(9);
    expect(result.unmatched).toBe(1);
    // 倒序：最新一条是 13:39:02.277
    expect(result.rows[0]?.traceId).toBe("e9ed66315a1567041f60825795454501");
    expect(result.rows.every((row) => row.fp === FP_USER_1)).toBe(true);
  });

  it("索引容错：坏行不影响其余条目", async () => {
    const day = await readIndexDay(SAMPLE_DIR, SAMPLE_DATE);
    expect(day.exists).toBe(true);
    expect(day.entries).toHaveLength(10);
    expect(day.badLines).toBe(0);
  });
});

describe.skipIf(!HAS_SAMPLE)("真实样本：详情归一化", () => {
  async function load(trace: string) {
    const day = await readIndexDay(SAMPLE_DIR, SAMPLE_DATE);
    const entry = day.entries.find((item) => item.t === trace);
    if (entry === undefined) throw new Error(`样本缺失：${trace}`);
    const [req, res] = await Promise.all([
      readAuditBlob({
        dir: SAMPLE_DIR,
        date: SAMPLE_DATE,
        fp: entry.u,
        trace: entry.t,
        kind: "req",
        gzip: entry.qz,
      }),
      readAuditBlob({
        dir: SAMPLE_DIR,
        date: SAMPLE_DATE,
        fp: entry.u,
        trace: entry.t,
        kind: "res",
        gzip: entry.rz,
      }),
    ]);
    return normalizeAudit({
      entry,
      requestText: req.text,
      responseText: res.text,
      requestBytes: req.bytes,
      responseBytes: res.bytes,
      requestCapped: req.capped,
      responseCapped: res.capped,
    });
  }

  it("非流式：提示词与返回完整", async () => {
    const envelope = await load("029c557182a956c95309ecf0ebc1a740");
    expect(envelope.request.messages.map((block) => block.role)).toEqual(["system", "user"]);
    expect(envelope.request.messages[1]?.text).toBe("非流式输入验证-ABCD");
    expect(envelope.response.outputs[0]?.text).toBe("这是非流式返回内容");
    expect(envelope.response.usage?.totalTokens).toBe(21);
  });

  it("流式：SSE 拼接为完整文本，含独立 usage 块", async () => {
    const envelope = await load("1d666d35fe841698b60ec76b0c3f02df");
    expect(envelope.response.outputs.map((block) => block.text)).toEqual(["你好，这是流式响应。"]);
    expect(envelope.response.stream).toEqual({ events: 6, done: true });
    expect(envelope.response.usage).toEqual({
      promptTokens: 14,
      completionTokens: 8,
      totalTokens: 22,
    });
  });

  it("gzip 请求体解压后可解析", async () => {
    const envelope = await load("370d4d3b8a9a77b9c3c06b46f58865e0");
    expect(envelope.meta.gzip.request).toBe(true);
    expect(envelope.request.bytes).toBeGreaterThan(100_000);
    expect(envelope.request.messages[0]?.role).toBe("user");
  });

  it("请求截断：标记 parse_error，不抛异常", async () => {
    const envelope = await load("b454e49f1614273d1d3ee2f3fa9ace03");
    expect(envelope.request.truncated).toBe(true);
    expect(envelope.request.parseError).toBe("request_truncated");
    expect(envelope.request.messages).toEqual([]);
    expect(envelope.response.outputs[0]?.text).toBe("这是非流式返回内容");
  });

  it("上游错误：401/503 归入 response.error", async () => {
    const day = await readIndexDay(SAMPLE_DIR, SAMPLE_DATE);
    const unauthorized = day.entries.find((item) => item.s === 401);
    expect(unauthorized).toBeDefined();
    const envelope = await load(unauthorized?.t ?? "");
    expect(envelope.response.error?.type).toBe("new_api_error");
    expect(envelope.response.outputs).toEqual([]);
  });
});
