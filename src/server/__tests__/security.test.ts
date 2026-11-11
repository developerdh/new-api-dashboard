/**
 * BE-M4-02 单测：Basic Auth 中间件（401/豁免/fail-closed）、受保护快照读取（穿越防护）、
 * 以及安全收口的关键不变量（参数白名单、缓存 key 白名单）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: vi.fn(async () => undefined) };
});

import type { NextRequest } from "next/server";

import { GET as getSnapshotFile } from "@/app/api/snapshots/[file]/route";
import { middleware } from "@/middleware";
import { EXPORT_RATE_LIMIT } from "@/lib/rate-limit";
import { cacheKey } from "@/server/cache";
import { QueryValidationError, normalizeQueryParams } from "@/server/queries/common";
import { SNAPSHOT_QUEUE_LIMIT, isSnapshotFilename } from "@/server/services/snapshot.service";

const USER = "dash-user";
const PASS = "dash-pass";
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64")}`;

function request(pathname: string, authorization?: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost${pathname}`),
    headers: new Headers(authorization === undefined ? {} : { authorization }),
  } as unknown as NextRequest;
}

let tmpDirs: string[] = [];
const originalDir = process.env.SNAPSHOT_DIR;

beforeEach(() => {
  process.env.DASHBOARD_AUTH_USER = USER;
  process.env.DASHBOARD_AUTH_PASS = PASS;
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.DASHBOARD_AUTH_USER;
  delete process.env.DASHBOARD_AUTH_PASS;
  if (originalDir === undefined) delete process.env.SNAPSHOT_DIR;
  else process.env.SNAPSHOT_DIR = originalDir;
  vi.restoreAllMocks();
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs = [];
});

async function makeSnapshotsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snapshots-protected-"));
  tmpDirs.push(dir);
  process.env.SNAPSHOT_DIR = dir;
  return dir;
}

describe("Basic Auth 中间件", () => {
  it("无凭据/错误凭据 → 401 + WWW-Authenticate", async () => {
    for (const header of [undefined, "Basic d3Jvbmc6d3Jvbmc=", "Bearer token"]) {
      const response = await middleware(request("/dashboard", header));
      expect(response.status, String(header)).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Basic");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("正确凭据 → 放行（x-middleware-next）", async () => {
    const response = await middleware(request("/dashboard", AUTH));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("豁免路径：/api/health、_next 静态资源、Bearer 端点（admin/snapshot）", async () => {
    for (const pathname of [
      "/api/health",
      "/_next/static/chunk.js",
      "/api/admin/cache/stats",
      "/api/admin/cache/clear",
      "/api/snapshot",
      "/favicon.ico",
    ]) {
      const response = await middleware(request(pathname));
      expect(response.headers.get("x-middleware-next"), pathname).toBe("1");
    }
  });

  it("未配置凭据 → 503 fail-closed（开发环境兜底；生产另有启动 fail-fast）", async () => {
    delete process.env.DASHBOARD_AUTH_USER;
    delete process.env.DASHBOARD_AUTH_PASS;

    const response = await middleware(request("/dashboard", AUTH));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("快照读取路由受保护（不在豁免清单）", async () => {
    const response = await middleware(request("/api/snapshots/x.html"));
    expect(response.status).toBe(401);
  });
});

describe("受保护快照读取 /api/snapshots/[file]", () => {
  it("合法文件 → 200 text/html + no-store", async () => {
    const dir = await makeSnapshotsDir();
    await writeFile(join(dir, "dash-20261111-1100.html"), "<html>snap</html>", "utf8");

    const response = await getSnapshotFile(new Request("http://localhost/api/snapshots/x"), {
      params: Promise.resolve({ file: "dash-20261111-1100.html" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<html>snap</html>");
  });

  it("路径穿越/非法文件名 → 400（不读取文件）", async () => {
    await makeSnapshotsDir();
    const cases = [
      "../secret.html",
      "..%2Fsecret.html",
      "..%252Fsecret.html",
      "sub/dir.html",
      "report.txt",
      "..",
      "",
      ".hidden.html",
    ];

    for (const file of cases) {
      const response = await getSnapshotFile(new Request("http://localhost/api/snapshots/x"), {
        params: Promise.resolve({ file }),
      });
      expect(response.status, file).toBe(400);
    }
  });

  it("文件不存在 → 404", async () => {
    await makeSnapshotsDir();
    const response = await getSnapshotFile(new Request("http://localhost/api/snapshots/x"), {
      params: Promise.resolve({ file: "missing-20261111-1100.html" }),
    });
    expect(response.status).toBe(404);
  });

  it("文件名白名单函数：只允许单段 .html", () => {
    expect(isSnapshotFilename("dash-20261111-1100.html")).toBe(true);
    expect(isSnapshotFilename("a.b.html")).toBe(true);
    expect(isSnapshotFilename("../a.html")).toBe(false);
    expect(isSnapshotFilename("a/b.html")).toBe(false);
    expect(isSnapshotFilename("a.html\n")).toBe(false);
    expect(isSnapshotFilename(".html")).toBe(false);
  });
});

describe("安全收口关键不变量（对应 §9 清单）", () => {
  it("参数校验：modelName 白名单拒绝注入式字符（Zod）", () => {
    expect(() =>
      normalizeQueryParams({
        start: "1",
        end: "2",
        modelName: "a'; DROP TABLE logs; --",
      }),
    ).toThrow(QueryValidationError);
  });

  it("缓存 key：拒绝超长/非法模型名与非法 scope（防 key 膨胀）", () => {
    expect(() => cacheKey("overview", { start: 1, end: 2, modelName: "a b" })).toThrow();
    expect(() =>
      cacheKey("overview", { start: 1, end: 2, modelName: "a".repeat(129) }),
    ).toThrow();
  });

  it("限流口径固定：导出 60s/10 次、快照在途上限 3", () => {
    expect(EXPORT_RATE_LIMIT).toEqual({ limit: 10, windowMs: 60_000 });
    expect(SNAPSHOT_QUEUE_LIMIT).toBe(3);
  });
});
