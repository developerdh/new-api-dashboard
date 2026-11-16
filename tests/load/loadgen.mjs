#!/usr/bin/env node
/**
 * 定速负载生成器（可复现压测资产，运行手册见 tests/load/README.md）。
 *
 * 开环定速：按 1000/QPS 的节拍发起请求，不因未完成而减速——用于测量转发/采集
 * 链路在固定到达率下的延迟分布与容量天花板。对每个请求测量：
 * - TTFT：流式首字节到达时间（对应 LLM「第一个字」体验）；
 * - 总时长：完整响应接收完成。
 * 输出分位数汇总到 stdout，明细写入 tests/load/results/run-<label>.json（不入库）。
 *
 * 零第三方依赖（Node 22 内置 fetch）；环境变量见 tests/load/README.md。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadE2eEnv } from "../e2e/load-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
loadE2eEnv(); // 复用 .env.e2e（token 与 e2e 同源；环境变量优先）

const TARGET = process.env.LOAD_TARGET_URL ?? "http://127.0.0.1:3090";
const QPS = clampInt(process.env.LOAD_QPS ?? "10", 1, 2000, 10);
const DURATION = clampInt(process.env.LOAD_DURATION ?? "120", 5, 3600, 120);
const MODE = process.env.LOAD_MODE === "nonstream" ? "nonstream" : "stream";
const BODY_BYTES = clampInt(process.env.LOAD_BODY_BYTES ?? "0", 0, 8 << 20, 0);
const MODEL = process.env.LOAD_MODEL ?? "GLM-5.3-Flash";
const LABEL = process.env.LOAD_LABEL ?? `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
const TRACE_PREFIX = process.env.LOAD_TRACE_PREFIX ?? `load-${Date.now().toString(36)}`;
const TOKEN = process.env.LOAD_TOKEN ?? process.env.E2E_TOKEN ?? "";
const REQUEST_TIMEOUT = clampInt(process.env.LOAD_REQUEST_TIMEOUT ?? "30000", 1000, 120_000, 30_000);
// 并发上限：>0 时进入闭环模式（槽位释放才发下一发），适合有并发限制的真实 LLM 上游；
// 0 = 开环定速（默认，适合无限制的哑上游/容量测量）
const CONCURRENCY = clampInt(process.env.LOAD_CONCURRENCY ?? "0", 0, 1000, 0);

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function fail(message) {
  console.error(`[load] ${message}`);
  process.exit(1);
}

if (TOKEN === "") {
  fail("缺少 LOAD_TOKEN / E2E_TOKEN（完整 Authorization 头值，如 Bearer sk-…）。");
}
if (!/^https?:\/\//.test(TARGET)) {
  fail(`LOAD_TARGET_URL 必须是 http(s) URL（当前 ${TARGET}）。`);
}

// 大 body 填充：确定性伪随机字母（LCG），熵贴近真实 JSON——重复字节的
// gzip 近乎免费，会让新旧 CPU 对比失真
const filler = (() => {
  if (BODY_BYTES <= 0) return "";
  let seed = 123456789;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < BODY_BYTES; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += chars[seed % chars.length];
  }
  return out;
})();
const results = []; // { ttfbMs|null, totalMs, status }
const errorCounts = {};

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
}

function summarize(values) {
  const valid = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return {
    count: valid.length,
    p50: percentile(valid, 50),
    p90: percentile(valid, 90),
    p99: percentile(valid, 99),
    max: Math.round(valid[valid.length - 1]),
    min: Math.round(valid[0]),
  };
}

async function fireOne(index) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request-timeout")), REQUEST_TIMEOUT);
  const started = performance.now();
  let ttfbMs = null;
  try {
    const payload = {
      model: MODEL,
      stream: MODE === "stream",
      messages: [{ role: "user", content: filler === "" ? "load-probe" : `load-probe ${filler}` }],
    };
    const response = await fetch(`${TARGET}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: TOKEN,
        "content-type": "application/json",
        "x-trace-id": `${TRACE_PREFIX}-${index}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // 读响应体：流式首块到达即 TTFT；之后排干（SSE 的 [DONE] 也在内）
    const reader = response.body.getReader();
    let first = true;
    for (;;) {
      const { done } = await reader.read();
      if (first) {
        ttfbMs = performance.now() - started;
        first = false;
      }
      if (done) break;
    }
    const totalMs = performance.now() - started;
    results.push({ ttfbMs, totalMs, status: response.status });
    if (!response.ok) {
      errorCounts[`http_${response.status}`] = (errorCounts[`http_${response.status}`] ?? 0) + 1;
    }
  } catch (error) {
    // abort(自定义 reason) 会让 fetch 以该 Error 本身 reject（name 是 "Error" 而非
    // "AbortError"），按 message 识别客户端超时，否则超时全部计入 network_error
    const key = error?.message === "request-timeout" ? "client_timeout" : "network_error";
    errorCounts[key] = (errorCounts[key] ?? 0) + 1;
    results.push({ ttfbMs, totalMs: performance.now() - started, status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

console.log(`[load] 目标=${TARGET} 模式=${MODE} 模型=${MODEL} QPS=${QPS} 时长=${DURATION}s body=${BODY_BYTES}B label=${LABEL}`);

const intervalMs = 1000 / QPS;
const runStarted = performance.now();
let nextAt = runStarted;
let index = 0;
const inFlight = [];
let active = 0;

const fireTracked = (i) => {
  active += 1;
  const task = fireOne(i).finally(() => {
    active -= 1;
  });
  inFlight.push(task);
};

if (CONCURRENCY > 0) {
  // 闭环模式：并发槽位释放才发下一发；QPS 仅作标称
  while (performance.now() < runStarted + DURATION * 1000) {
    if (active >= CONCURRENCY) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    index += 1;
    fireTracked(index);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
} else {
  // 开环定速模式：按节拍发起，不因未完成而减速
  while (nextAt < runStarted + DURATION * 1000) {
    const delay = nextAt - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (performance.now() >= runStarted + DURATION * 1000) break;
    index += 1;
    fireTracked(index);
    nextAt += intervalMs;
  }
}

const gracefulDeadline = Date.now() + 30_000;
for (const task of inFlight) {
  const remain = gracefulDeadline - Date.now();
  if (remain <= 0) break;
  await Promise.race([task, new Promise((resolve) => setTimeout(resolve, remain))]);
}
const wallSeconds = (performance.now() - runStarted) / 1000;

const ok = results.filter((item) => item.status >= 200 && item.status < 300);
const summary = {
  label: LABEL,
  target: TARGET,
  mode: MODE,
  model: MODEL,
  configuredQps: QPS,
  concurrency: CONCURRENCY,
  achievedQps: Math.round((ok.length / wallSeconds) * 10) / 10,
  durationSeconds: Math.round(wallSeconds * 10) / 10,
  sent: results.length,
  okCount: ok.length,
  errorCounts,
  ttfb: summarize(results.map((item) => item.ttfbMs)),
  total: summarize(results.map((item) => item.totalMs)),
  tracePrefix: TRACE_PREFIX,
};

console.log("");
console.log(`发送 ${summary.sent} · 成功 ${summary.okCount} · 实测 ${summary.achievedQps} QPS（配置 ${QPS}）`);
console.log(`错误: ${JSON.stringify(summary.errorCounts)}`);
if (summary.ttfb !== null && MODE === "stream") {
  console.log(
    `TTFT  ms: p50=${summary.ttfb.p50} p90=${summary.ttfb.p90} p99=${summary.ttfb.p99} max=${summary.ttfb.max}`,
  );
}
if (summary.total !== null) {
  console.log(
    `总时长 ms: p50=${summary.total.p50} p90=${summary.total.p90} p99=${summary.total.p99} max=${summary.total.max}`,
  );
}

const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const outPath = join(resultsDir, `run-${LABEL}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[load] 结果已写 ${outPath}（不入库）`);
