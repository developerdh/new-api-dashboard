/**
 * e2e 造数：经采集代理发送带唯一标记的对话请求，让 UI 断言不依赖既有数据。
 *
 * 产出 3 条记录（写入 index 与段文件，属采集管线正常写入，不碰数据库）：
 * 1 条非流式（详情断言用）+ 2 条同会话键流式（线程抽屉断言用），
 * 请求正文都带唯一标记 `e2e-smoke-<runId>`，trace id 形如 `e2esmoke-<runId>-a`。
 *
 * 产出 tests/e2e/.state.json（不入库），smoke.spec.ts 从中读取标记与 trace id。
 * 失败一律明确报错退出（缺 token / 代理不可达 / 上游非 200），绝不静默跳过。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadE2eEnv } from "./load-env.mjs";
import { shanghaiDateOf } from "./shanghai-date.mjs";

loadE2eEnv();

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3088";
const USER_ID = process.env.E2E_USER_ID ?? "1";
const MODEL = process.env.E2E_MODEL ?? "GLM-5.3-Flash";

// 代理默认取看板主机名 + 3090（同机部署的默认形态）；跨机部署用 E2E_SEED_HOST 显式指定
const PROXY_BASE =
  process.env.E2E_SEED_HOST ??
  (() => {
    const url = new URL(BASE_URL);
    return `${url.protocol}//${url.hostname}:3090`;
  })();

const fail = (message) => {
  console.error(`[e2e:seed] ${message}`);
  process.exit(1);
};

const token = process.env.E2E_TOKEN;
if (token === undefined || token.trim() === "") {
  fail("缺少 E2E_TOKEN（完整 Authorization 头值，如 Bearer sk-…，须属于 E2E_USER_ID 名下的 token）。");
}

const runId = Date.now().toString(36);
const marker = `e2e-smoke-${runId}`;
const threadKey = `e2e-thread-${runId}`;
const records = [];

async function send(label, traceId, body) {
  let response;
  try {
    response = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: token,
        "content-type": "application/json",
        "x-trace-id": traceId,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(`无法连接采集代理 ${PROXY_BASE}（${error instanceof Error ? error.message : String(error)}）。确认 E2E_SEED_HOST 或代理可达性。`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(`造数请求 ${label} 上游返回 ${response.status}（trace=${traceId}）\n${text.slice(0, 200)}`);
  }
  records.push({ label, traceId, status: response.status });
  console.log(`[e2e:seed] ${label} ✓ trace=${traceId}`);
}

await send("非流式详情", `e2esmoke-${runId}-a`, {
  model: MODEL,
  stream: false,
  messages: [{ role: "user", content: marker }],
});
for (const [label, suffix] of [
  ["线程第 1 轮", "b1"],
  ["线程第 2 轮", "b2"],
]) {
  await send(label, `e2esmoke-${runId}-${suffix}`, {
    model: MODEL,
    stream: true,
    prompt_cache_key: threadKey,
    messages: [{ role: "user", content: `${marker} thread` }],
  });
}

// 等看板可查询：服务端索引缓存 TTL 默认 30s，轮询直到本 run 的记录出现在看板 API
// （轮询本身也会让缓存刷新为最新）。超时视为异常，明确报错停止。
const password = process.env.E2E_PASSWORD;
if (password === undefined || password === "") {
  fail("缺少 E2E_PASSWORD（等待看板可查询需要登录 API，见 .env.e2e.example）。");
}
const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.E2E_USERNAME ?? "admin", password }),
});
if (!loginResponse.ok) {
  fail(`看板登录失败（HTTP ${loginResponse.status}），无法轮询确认造数记录可见。`);
}
const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0];
const lastTrace = records[records.length - 1].traceId;
const shanghaiToday = shanghaiDateOf(Math.floor(Date.now() / 1000));
const deadline = Date.now() + 45_000;
let seen = false;
while (Date.now() < deadline && !seen) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    const query = await fetch(
      `${BASE_URL}/api/dashcam/sessions?userId=${USER_ID}&group=request&date=${shanghaiToday}&limit=5`,
      { headers: { cookie } },
    );
    if (query.ok) {
      const body = await query.json();
      const rows = body?.data?.sessions ?? [];
      seen = rows.some((row) => row.traceId === lastTrace);
    }
  } catch {
    // 网络抖动：继续轮询直到超时
  }
}
if (!seen) {
  fail("45s 内看板未查到造数记录：可能是索引缓存未过期、采集落盘失败或用户归属不符（E2E_TOKEN 与 E2E_USER_ID 不匹配）。");
}
console.log(`[e2e:seed] 看板已可查询造数记录 ✓ trace=${lastTrace}`);

const state = {
  runId,
  marker,
  userId: USER_ID,
  date: shanghaiDateOf(Math.floor(Date.now() / 1000)),
  promptCacheKey: threadKey,
  records,
};
const statePath = join(here, ".state.json");
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(`[e2e:seed] 完成：marker=${marker} → ${statePath}`);
