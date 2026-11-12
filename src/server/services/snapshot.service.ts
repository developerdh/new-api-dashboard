/**
 * 看板快照服务（方案 §8.2）。
 *
 * 流程：白名单校验 path/query → 并发队列（同时渲染 1，最多 3 个在途）→ Playwright
 * `goto(url) → waitForLoadState('networkidle') → page.content()` → 写入 `public/snapshots/`。
 *
 * 依赖说明：`playwright` 为可选运行时依赖。未安装时抛出 `SnapshotUnavailableError`
 * （路由映射 503），保证应用在无浏览器环境可正常构建/启动（需安装 playwright 与 chromium）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { QueryValidationError } from "@/server/queries/common";
import { SESSION_COOKIE_NAME, createSessionToken, readSessionConfig } from "@/server/session";

/** 在途快照上限（1 个渲染 + 2 个排队；第 4 个请求 429）。 */
export const SNAPSHOT_QUEUE_LIMIT = 3;

const ALLOWED_PATH_PATTERN = /^\/(?:dashboard|models)\/?$|^\/users\/\d+\/?$/;
const ALLOWED_QUERY_KEYS = new Set(["start", "end", "granularity"]);
const GRANULARITIES = new Set(["day", "week", "month"]);
const MAX_NAME_LENGTH = 64;

export interface SnapshotRequest {
  path: string;
  query?: Record<string, string>;
  name?: string;
}

export interface SnapshotResult {
  /** 可访问路径：`/snapshots/<file>`。 */
  file: string;
  bytes: number;
  createdAt: string;
}

export type SnapshotRenderer = (url: string) => Promise<string>;

/** 参数非法（400）。 */
export class SnapshotBusyError extends Error {
  readonly code = "snapshot_busy";
  constructor() {
    super("快照任务过多，请稍后再试");
    this.name = "SnapshotBusyError";
  }
}

/** Playwright 未安装/不可用（503）。 */
export class SnapshotUnavailableError extends Error {
  readonly code = "snapshot_unavailable";
  constructor(message = "快照能力不可用：未安装 playwright 或 chromium（需安装 playwright 与 chromium）") {
    super(message);
    this.name = "SnapshotUnavailableError";
  }
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

/** path 白名单：仅本站三类路由（防 SSRF 打内网任意地址）。 */
export function normalizeSnapshotPath(input: string): string {
  const path = input.trim();
  if (!ALLOWED_PATH_PATTERN.test(path)) {
    throw new QueryValidationError([
      { path: "path", message: "仅允许 /dashboard、/models、/users/<数字id>" },
    ]);
  }
  return path.replace(/\/$/, "");
}

/** query 白名单：只允许 start/end/granularity，start/end 为 Unix 秒。 */
export function normalizeSnapshotQuery(
  query: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(query ?? {})) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new QueryValidationError([{ path: "query", message: `不支持的查询参数：${key}` }]);
    }
    if ((key === "start" || key === "end") && !/^\d+$/.test(value)) {
      throw new QueryValidationError([{ path: "query", message: `${key} 必须是 Unix 秒` }]);
    }
    if (key === "granularity" && !GRANULARITIES.has(value)) {
      throw new QueryValidationError([
        { path: "query", message: "granularity 只允许 day/week/month" },
      ]);
    }
    normalized[key] = value;
  }

  return normalized;
}

export function buildSnapshotUrl(
  path: string,
  query: Record<string, string>,
  baseUrl: string = process.env.DASHBOARD_BASE_URL ?? "http://127.0.0.1:3088",
): string {
  const search = new URLSearchParams(query).toString();
  const base = baseUrl.replace(/\/+$/, "");
  return search === "" ? `${base}${path}` : `${base}${path}?${search}`;
}

/* ------------------------------------------------------------------ */
/* 文件名                                                              */
/* ------------------------------------------------------------------ */

const timestampFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `<name>-<YYYYMMDD-HHmm>.html`（东八区时间）。 */
export function snapshotFilename(name: string, now: Date = new Date()): string {
  const parts = timestampFormatter.formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const stamp = `${pick("year")}${pick("month")}${pick("day")}-${pick("hour")}${pick("minute")}`;

  const safeName = name
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  return `${safeName || "snapshot"}-${stamp}.html`;
}

function defaultSnapshotName(path: string): string {
  return path.replace(/^\/+/, "").replaceAll("/", "-");
}

/* ------------------------------------------------------------------ */
/* 并发队列（同时 1 个，最多 3 个在途）                                  */
/* ------------------------------------------------------------------ */

export class SnapshotQueue {
  private active = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly limit: number = SNAPSHOT_QUEUE_LIMIT) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) throw new SnapshotBusyError();
    this.active += 1;

    const runTask = this.tail.then(task, task);
    this.tail = runTask.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await runTask;
    } finally {
      this.active -= 1;
    }
  }
}

/** 进程内快照队列单例。 */
export const snapshotQueue = new SnapshotQueue();

/* ------------------------------------------------------------------ */
/* Playwright 渲染                                                     */
/* ------------------------------------------------------------------ */

interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
}

interface PlaywrightBrowser {
  newContext(options?: { extraHTTPHeaders?: Record<string, string> }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: { launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser> };
}

/**
 * 可选依赖加载：用 Function 构造动态 import，避免打包器在构建期解析缺失的 `playwright`。
 * 未安装时抛 SnapshotUnavailableError（503），不影响应用构建与其余功能。
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;

  try {
    return (await dynamicImport("playwright")) as PlaywrightModule;
  } catch {
    throw new SnapshotUnavailableError();
  }
}

/**
 * 默认渲染器：签发短期会话 Cookie → goto → networkidle → content。
 * 快照要抓取受登录保护的页面，浏览器上下文必须携带与 middleware 同源的会话。
 * browser.close 在 finally 保证。
 */
export const playwrightRenderer: SnapshotRenderer = async (url) => {
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const config = readSessionConfig();
    const cookie =
      config === null
        ? undefined
        : `${SESSION_COOKIE_NAME}=${await createSessionToken(config.user, config)}`;
    const context = await browser.newContext(
      cookie === undefined ? {} : { extraHTTPHeaders: { cookie } },
    );
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
};

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 快照产物目录：默认 `data/snapshots`（不入库；`SNAPSHOT_DIR` 供测试/部署覆盖）。 */
export function snapshotOutputDir(): string {
  const override = process.env.SNAPSHOT_DIR?.trim();
  if (override !== undefined && override !== "") return override;
  return join(process.cwd(), "data", "snapshots");
}

/** 快照访问路径前缀（受保护路由，非 public 静态目录）。 */
export const SNAPSHOT_URL_PREFIX = "/api/snapshots/";

/** 快照文件名白名单：仅单段 `<name>.html`，禁止路径分隔与 `..`。 */
export function isSnapshotFilename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(name) && !name.includes("..");
}

export interface SnapshotOptions {
  renderer?: SnapshotRenderer;
  outputDir?: string;
  now?: Date;
  baseUrl?: string;
  queue?: SnapshotQueue;
}

/** 生成快照：校验 → 队列渲染 → 写文件；返回可访问路径与字节数。 */
export async function createSnapshot(
  request: SnapshotRequest,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const path = normalizeSnapshotPath(request.path);
  const query = normalizeSnapshotQuery(request.query);
  const renderer = options.renderer ?? playwrightRenderer;
  const queue = options.queue ?? snapshotQueue;
  const baseUrl = options.baseUrl ?? process.env.DASHBOARD_BASE_URL ?? "http://127.0.0.1:3088";
  const now = options.now ?? new Date();

  const url = buildSnapshotUrl(path, query, baseUrl);
  const html = await queue.run(() => renderer(url));

  const outputDir = options.outputDir ?? snapshotOutputDir();
  await mkdir(outputDir, { recursive: true });

  const filename = snapshotFilename(request.name ?? defaultSnapshotName(path), now);
  await writeFile(join(outputDir, filename), html, "utf8");

  return {
    file: `${SNAPSHOT_URL_PREFIX}${filename}`,
    bytes: Buffer.byteLength(html, "utf8"),
    createdAt: now.toISOString(),
  };
}
