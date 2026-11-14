/**
 * 列表行的 token 水合：对「当前页可见行」惰性读响应正文，提取 usage。
 *
 * 为什么不在扫描层做：索引扫描的设计成本是「只读一个 NDJSON 文件」，而
 * token 只存在于 blob 正文里（各协议的 usage 字段，见 normalize.ts）。
 * 水合预算 `DASHCAM_USAGE_HYDRATE_MAX`（默认 100 个正文/请求）保证列表页
 * 最坏情况也只多读「一页行数」个响应文件；预算之外的行不带 `usage`，
 * 界面显示 `—`。解析结果进 30s 进程内缓存，翻页/刷新命中缓存后接近零成本。
 */
import { getCache } from "@/server/cache";

import { dashcamCacheTtlMs } from "./index";
import { extractUsage } from "./normalize";
import { readDashcamBlob } from "./reader";
import type { DashcamUsage } from "./types";

/** 单次 API 请求最多水合的正文数。 */
const DEFAULT_USAGE_HYDRATE_MAX = 100;
const MIN_HYDRATE_MAX = 1;
const MAX_HYDRATE_MAX = 300;
/** 并发读正文的上限，避免一次请求打开上百个 fd。 */
const READ_CONCURRENCY = 8;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function usageHydrateMax(): number {
  return envInt("DASHCAM_USAGE_HYDRATE_MAX", DEFAULT_USAGE_HYDRATE_MAX, MIN_HYDRATE_MAX, MAX_HYDRATE_MAX);
}

/** 水合输入的最小形状：请求行与会话线程轮次都满足。 */
export interface UsageSource {
  date: string;
  fp: string;
  traceId: string;
  path: string;
  responseTruncated: boolean;
  gzip: { request: boolean; response: boolean };
}

/** 水合结果的 map 键：与 blob 寻址（日期 + 指纹 + trace）一致。 */
export function usageKey(row: Pick<UsageSource, "date" | "fp" | "traceId">): string {
  return `${row.date}:${row.fp}:${row.traceId}`;
}

/** 读一次请求的 token 用量（正文缺失 / 解析失败都返回 undefined，不让列表 500）。 */
export async function readSessionUsage(
  dir: string,
  row: UsageSource,
): Promise<DashcamUsage | undefined> {
  const cache = getCache();
  const key = `dashcam:usage:${dir}:${usageKey(row)}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    // 空对象是负缓存哨兵（缓存实现不接受 null）
    const value = cached as DashcamUsage;
    return Object.keys(value).length === 0 ? undefined : value;
  }

  let usage: DashcamUsage | undefined;
  try {
    const blob = await readDashcamBlob({
      dir,
      date: row.date,
      fp: row.fp,
      trace: row.traceId,
      kind: "res",
      gzip: row.gzip.response,
    });
    usage = extractUsage({
      path: row.path,
      responseText: blob.text,
      truncated: row.responseTruncated || blob.capped,
    });
  } catch {
    usage = undefined;
  }

  // 未命中也缓存（负缓存），避免坏正文每页都重读
  cache.set(key, usage ?? {}, { ttl: dashcamCacheTtlMs() });
  return usage;
}

/**
 * 批量水合：按传入顺序取前 `usageHydrateMax()` 个，8 并发读正文。
 * 返回的 map 只包含成功解析的行；调用方按 `usageKey` 回填。
 */
export async function hydrateSessionUsages(
  dir: string,
  rows: UsageSource[],
): Promise<Map<string, DashcamUsage>> {
  const budget = usageHydrateMax();
  const targets = rows.slice(0, budget);
  const result = new Map<string, DashcamUsage>();

  for (let start = 0; start < targets.length; start += READ_CONCURRENCY) {
    const batch = targets.slice(start, start + READ_CONCURRENCY);
    const usages = await Promise.all(batch.map((row) => readSessionUsage(dir, row)));
    batch.forEach((row, index) => {
      const usage = usages[index];
      if (usage !== undefined) result.set(usageKey(row), usage);
    });
  }
  return result;
}

/** 把水合结果回填到行上（没有命中的行保持不带 `usage` 字段）。 */
export function attachUsage<T extends { date: string; fp: string; traceId: string; usage?: DashcamUsage }>(
  row: T,
  usages: Map<string, DashcamUsage>,
): T {
  const usage = usages.get(usageKey(row));
  return usage === undefined ? row : { ...row, usage };
}
