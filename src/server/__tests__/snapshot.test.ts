/**
 * 单测：快照路径白名单/query 校验/文件名/并发队列/写文件；路由守卫与错误映射。
 *
 * 约束：本机未安装 playwright（会话约束禁止新增依赖）——默认渲染器路径在本环境返回 503，
 * 因此用注入 renderer 覆盖渲染逻辑；真实快照验收待补。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/snapshot/route";
import { QueryValidationError } from "@/server/queries/common";
import {
  SNAPSHOT_QUEUE_LIMIT,
  SnapshotBusyError,
  SnapshotQueue,
  buildSnapshotUrl,
  createSnapshot,
  normalizeSnapshotPath,
  normalizeSnapshotQuery,
  snapshotFilename,
  snapshotQueue,
} from "@/server/services/snapshot.service";

const TOKEN = "snapshot-test-token";
const NOW = new Date("2026-11-11T03:00:00Z"); // 东八区 11:00

let tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-test-"));
  tmpDirs.push(dir);
  return dir;
}

function postRequest(body: unknown, token: string | null = TOKEN): Request {
  return new Request("http://localhost/api/snapshot", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ADMIN_TOKEN = TOKEN;
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.ADMIN_TOKEN;
  vi.restoreAllMocks();
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("路径与 query 白名单（防 SSRF）", () => {
  it("允许 /dashboard、/models、/users/<id>（含尾斜杠归一）", () => {
    expect(normalizeSnapshotPath("/dashboard")).toBe("/dashboard");
    expect(normalizeSnapshotPath("/dashboard/")).toBe("/dashboard");
    expect(normalizeSnapshotPath("/models")).toBe("/models");
    expect(normalizeSnapshotPath("/users/7")).toBe("/users/7");
    expect(normalizeSnapshotPath("/users/7/")).toBe("/users/7");
  });

  it("拒绝站外地址/非白名单路由/非数字用户 id", () => {
    for (const path of [
      "https://evil.example.com",
      "//evil.example.com/dashboard",
      "/admin",
      "/api/overview",
      "/users/abc",
      "/users/7/models",
      "",
    ]) {
      try {
        normalizeSnapshotPath(path);
        throw new Error(`应当拒绝：${path}`);
      } catch (error) {
        expect(error, path).toBeInstanceOf(QueryValidationError);
        expect((error as QueryValidationError).issues[0]?.path).toBe("path");
      }
    }
  });

  it("query 只允许 start/end/granularity，且格式合法", () => {
    expect(normalizeSnapshotQuery({ start: "1", end: "2", granularity: "week" })).toEqual({
      start: "1",
      end: "2",
      granularity: "week",
    });
    expect(normalizeSnapshotQuery(undefined)).toEqual({});

    const invalidQueries: Array<Record<string, string>> = [
      { userId: "7" },
      { start: "2026-11-10" },
      { granularity: "hour" },
    ];
    for (const query of invalidQueries) {
      expect(() => normalizeSnapshotQuery(query)).toThrow(QueryValidationError);
    }
  });

  it("URL 拼接：基址去尾斜杠，query 序列化", () => {
    expect(buildSnapshotUrl("/dashboard", { start: "1", end: "2" }, "http://x:3000/")).toBe(
      "http://x:3000/dashboard?start=1&end=2",
    );
    expect(buildSnapshotUrl("/models", {}, "http://x:3000")).toBe("http://x:3000/models");
  });
});

describe("文件名规则", () => {
  it("name 安全字符收敛 + 东八区时间戳", () => {
    expect(snapshotFilename("trend", NOW)).toBe("trend-20261111-1100.html");
    expect(snapshotFilename("user 7/../x", NOW)).toBe("user-7-..-x-20261111-1100.html");
    expect(snapshotFilename("///", NOW)).toBe("snapshot-20261111-1100.html");
  });
});

describe("并发队列：同时 1 个、在途上限 3", () => {
  it("第 4 个任务立即 busy；任务串行执行", async () => {
    const queue = new SnapshotQueue(3);
    const gates = Array.from({ length: 3 }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });

    let running = 0;
    let maxRunning = 0;
    const tasks = gates.map((gate) =>
      queue.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await expect(queue.run(async () => undefined)).rejects.toBeInstanceOf(SnapshotBusyError);
    expect(SNAPSHOT_QUEUE_LIMIT).toBe(3);

    for (const gate of gates) gate.release();
    await Promise.all(tasks);
    expect(maxRunning).toBe(1);
  });
});

describe("createSnapshot（注入 renderer）", () => {
  it("校验 → 渲染 → 写文件，返回可访问路径与字节数", async () => {
    const outputDir = await makeTempDir();
    const calls: string[] = [];

    const result = await createSnapshot(
      { path: "/dashboard", query: { start: "1794240000", end: "1794326400" }, name: "trend" },
      {
        outputDir,
        now: NOW,
        baseUrl: "http://localhost:3000",
        renderer: async (url) => {
          calls.push(url);
          return "<html>snapshot</html>";
        },
      },
    );

    expect(calls).toEqual([
      "http://localhost:3000/dashboard?start=1794240000&end=1794326400",
    ]);
    expect(result.file).toBe("/api/snapshots/trend-20261111-1100.html");
    expect(result.bytes).toBe(Buffer.byteLength("<html>snapshot</html>", "utf8"));
    expect(result.createdAt).toBe(NOW.toISOString());

    const written = await readFile(join(outputDir, "trend-20261111-1100.html"), "utf8");
    expect(written).toBe("<html>snapshot</html>");
  });

  it("非法 path 不进入渲染队列", async () => {
    const renderer = vi.fn(async () => "<html></html>");
    await expect(
      createSnapshot({ path: "https://evil.example.com" }, { renderer }),
    ).rejects.toBeInstanceOf(QueryValidationError);
    expect(renderer).not.toHaveBeenCalled();
  });
});

describe("POST /api/snapshot", () => {
  it("未配置 ADMIN_TOKEN → 404；错误 token → 401", async () => {
    delete process.env.ADMIN_TOKEN;
    const disabled = await POST(postRequest({ path: "/dashboard" }, "any"));
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("cache-control")).toBe("no-store");

    process.env.ADMIN_TOKEN = TOKEN;
    const unauthorized = await POST(postRequest({ path: "/dashboard" }, "wrong"));
    expect(unauthorized.status).toBe(401);
  });

  it("非法 path/body → 400（issues 指明字段）", async () => {
    const badPath = await POST(postRequest({ path: "/api/overview" }));
    expect(badPath.status).toBe(400);
    const pathBody = (await badPath.json()) as { error: { issues?: Array<{ path: string }> } };
    expect(pathBody.error.issues?.some((issue) => issue.path === "path")).toBe(true);

    const badJson = await POST(postRequest("{not json"));
    expect(badJson.status).toBe(400);

    const missingPath = await POST(postRequest({}));
    expect(missingPath.status).toBe(400);
  });

  it("合法请求但 playwright 未安装 → 503 snapshot_unavailable（无内部细节）", async () => {
    const response = await POST(postRequest({ path: "/dashboard" }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("snapshot_unavailable");
    expect(body.error.message).not.toMatch(/node_modules|stack|postgres/i);
  });

  it("在途队列已满 → 429 snapshot_busy（Retry-After）", async () => {
    const gates = Array.from({ length: SNAPSHOT_QUEUE_LIMIT }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    for (const gate of gates) {
      void snapshotQueue.run(() => gate.promise);
    }

    const response = await POST(postRequest({ path: "/dashboard" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("snapshot_busy");

    for (const gate of gates) gate.release();
    await Promise.resolve();
  });
});
