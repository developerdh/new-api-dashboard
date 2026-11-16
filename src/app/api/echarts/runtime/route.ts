/**
 * GET /api/echarts/runtime —— 只读暴露本仓库 echarts 运行时（单图导出用）。
 *
 * 用途：前端导出「自包含 HTML」时把运行时内联进导出文件，避免外网 CDN（内网/离线可用）。
 * 来源：`node_modules/echarts/dist/echarts.min.js`（与页面同一版本，构建期不联网）。
 * 说明：进程内缓存首次读取结果；响应为 JS 文本，体积约 1.1MB。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { connection } from "next/server";

let runtimePromise: Promise<string> | undefined;

/** 产物路径固定为项目根下 node_modules（`next start` 的工作目录即项目根）。 */
function runtimePath(): string {
  return join(process.cwd(), "node_modules", "echarts", "dist", "echarts.min.js");
}

function loadRuntime(): Promise<string> {
  // 只缓存成功结果：失败（文件瞬时缺失/EMFILE 等）不驻留 Promise，
  // 否则首次失败后所有请求永远 500，文件恢复也不会重试
  runtimePromise ??= readFile(runtimePath(), "utf8").catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

export async function GET(): Promise<Response> {
  await connection();

  try {
    const runtime = await loadRuntime();
    return new Response(runtime, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[echarts/runtime] failed", message);
    return new Response("// echarts runtime unavailable", {
      status: 500,
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
