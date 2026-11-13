/**
 * 审计目录的路径与日期口径（读取层最底层）。
 *
 * 硬约束：
 * - 只读：本模块与 `src/server/audit/*` 不出现任何写 API（write/mkdir/rm/rename）；
 * - 与 `getDb()` 完全隔离：不 import `src/server/db`、不持有连接；
 * - 路径校验双保险：三段白名单正则 + `path.resolve` 前缀断言（防目录穿越）。
 *
 * 日期口径：采集侧用**服务端本地时区**分日（部署要求 `TZ=Asia/Shanghai`）。
 * 这里按 Asia/Shanghai 枚举索引日期，与看板其余统计口径一致（`queries/common.ts` 同源语义）。
 */
import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** trace 白名单：与 `capture.go` 的 `tracePattern` 一致，但上限放宽到 71 ——
 * 文件名冲突时会追加 `-<6 位随机>` 后缀（`trace + "-" + 6hex`），实际最长 71。
 * 按 64 校验会永久打不开这类文件（见 `docs/audit-proxy/05-dashboard-plan.md` D1）。 */
export const TRACE_PATTERN = /^[A-Za-z0-9._-]{8,71}$/;

/** 指纹：12 位小写 hex，或代理在无凭据时写的 `_anon`。 */
export const FINGERPRINT_PATTERN = /^(?:[0-9a-f]{12}|_anon)$/;

/** 日期目录 / 索引文件名。 */
export const AUDIT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 默认窗口上限（天）：超限直接 400，不静默截断（否则"看不到"会被误判为"没有"）。 */
export const DEFAULT_MAX_WINDOW_DAYS = 31;
export const MAX_WINDOW_DAYS_LIMIT = 366;

/** 路径非法（穿越、编码异常）：路由映射 400。 */
export class AuditPathError extends Error {
  readonly code = "invalid_path";

  constructor(message: string) {
    super(message);
    this.name = "AuditPathError";
  }
}

/** 查询参数非法（窗口超限、limit 越界等）：路由映射 400 + issues。 */
export class AuditQueryError extends Error {
  readonly code = "invalid_query";
  readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "AuditQueryError";
    this.issues = issues ?? [{ path: "", message }];
  }
}

function envText(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * 审计根目录：仅在显式配置 `AUDIT_DIR` 时启用。
 *
 * 刻意**不**提供隐式默认值：目录不存在与"功能未启用"是两件事，混在一起会让
 * 容器里忘挂载时表现为"没有会话"而不是"未启用"。本地开发显式配 `AUDIT_DIR=./data/audit`。
 */
export function auditDir(): string | null {
  const configured = envText("AUDIT_DIR");
  return configured === undefined ? null : resolve(configured);
}

/** 窗口上限（天）。 */
export function auditMaxWindowDays(): number {
  const raw = envText("AUDIT_MAX_WINDOW_DAYS");
  if (raw === undefined) return DEFAULT_MAX_WINDOW_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS_LIMIT) {
    return DEFAULT_MAX_WINDOW_DAYS;
  }
  return value;
}

/** 单页上限：与查询层 `MAX_LIMIT` 同量级，避免一次拉爆响应体。 */
export const AUDIT_MAX_PAGE_SIZE = 200;
export const AUDIT_DEFAULT_PAGE_SIZE = 50;

/** 目录可用性：只做一次 `readdir`，失败即视为不可用（不抛错，路由按 `available:false` 处理）。 */
export async function isAuditAvailable(dir: string | null = auditDir()): Promise<boolean> {
  if (dir === null) return false;
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 前缀断言：`candidate` 必须落在 `root` 之内。
 * 只做字符串层判断（不 `realpath`）：目标是防穿越；`realpath` 会在容器/NFS 上引入新的失败面。
 */
export function assertInsideRoot(root: string, candidate: string): string {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new AuditPathError("审计路径越界");
  }
  return target;
}

/** `<root>/index/<date>.ndjson`。 */
export function auditIndexPath(dir: string, date: string): string {
  if (!AUDIT_DATE_PATTERN.test(date)) throw new AuditPathError("非法索引日期");
  return assertInsideRoot(dir, join(dir, "index", `${date}.ndjson`));
}

export interface BlobPathInput {
  date: string;
  fp: string;
  trace: string;
  kind: "req" | "res";
  gz: boolean;
}

/** `<root>/blobs/<date>/<fp>/<trace>.<kind>[.gz]`。 */
export function auditBlobPath(dir: string, input: BlobPathInput): string {
  const { date, fp, trace, kind, gz } = input;
  if (!AUDIT_DATE_PATTERN.test(date)) throw new AuditPathError("非法索引日期");
  if (!FINGERPRINT_PATTERN.test(fp)) throw new AuditPathError("非法调用方指纹");
  if (!TRACE_PATTERN.test(trace)) throw new AuditPathError("非法 trace id");
  const name = `${trace}.${kind}${gz ? ".gz" : ""}`;
  return assertInsideRoot(dir, join(dir, "blobs", date, fp, name));
}

/* ------------------------------------------------------------------ */
/* Asia/Shanghai 日期枚举                                              */
/* ------------------------------------------------------------------ */

const SHANGHAI = "Asia/Shanghai";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 东八区自然日 `YYYY-MM-DD`。 */
export function auditDateOf(epochSeconds: number): string {
  const parts = dateFormatter.formatToParts(new Date(epochSeconds * 1000));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * 区间 `[start, end)` 覆盖的索引日期，**倒序**（新→旧）。
 * 起点日 + 终点前一日（左闭右开，与看板其余区间口径一致）。
 */
export function listIndexDates(start: number, end: number, maxDays: number): string[] {
  const first = auditDateOf(start);
  const last = auditDateOf(Math.max(start, end - 1));
  const dates: string[] = [];
  let cursor = first;

  while (cursor <= last) {
    dates.push(cursor);
    if (dates.length > maxDays) {
      throw new AuditQueryError(`查询窗口超过 ${maxDays} 天，请缩小时间范围`, [
        { path: "start", message: `区间最多覆盖 ${maxDays} 个自然日` },
      ]);
    }
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  return dates.reverse();
}
