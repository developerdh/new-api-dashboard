/**
 * GET /api/snapshots/[file] —— 受保护的快照读取路由（BE-M4-02）。
 *
 * 背景：快照含真实用量数据，不再放 public 静态目录；产物写 `data/snapshots`，
 * 读取统一经本路由（由 middleware 的 Basic Auth 保护），文件名白名单防目录穿越。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { connection } from "next/server";

import { isSnapshotFilename, snapshotOutputDir } from "@/server/services/snapshot.service";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> },
): Promise<Response> {
  await connection();

  const { file } = await context.params;
  const name = decodeURIComponent(file);

  if (!isSnapshotFilename(name)) {
    return Response.json(
      { ok: false, error: { code: "invalid_path", message: "非法快照文件名" } },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const html = await readFile(join(snapshotOutputDir(), name), "utf8");
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
    });
  } catch {
    return new Response("Not Found", { status: 404, headers: NO_STORE });
  }
}
