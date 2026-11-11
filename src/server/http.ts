/**
 * API 统一响应封装（BE-M1-01 / 方案 §4）。
 *
 * 成功：`{ ok: true, data, meta: { range, granularity, cached } }`
 * 失败：`{ ok: false, error: { code, message, issues? } }`
 *
 * 红线（根 AGENTS.md / 方案 §9.1）：
 * - 错误体不回显 SQL、连接串、host、堆栈——`queryFailed()` 不接受任何内部错误详情；
 * - 所有响应 `cache-control: no-store`（数据随时变化，且避免缓存层误存）。
 */
import { z } from "zod";

/** 粒度：方案 §4 的 day / week / month（API 契约层定义，查询层复用）。 */
export type ApiGranularity = "day" | "week" | "month";

/** 参数问题（Zod flatten 后的字段级/表单级错误）。 */
export interface QueryIssue {
  /** 字段路径（顶层为字段名；表单级错误为空串）。 */
  path: string;
  message: string;
}

export interface ApiMeta {
  /** 实际生效的查询区间（Unix 秒，左闭右开）。 */
  range: { start: number; end: number };
  granularity: ApiGranularity | null;
  /** 本次响应是否来自进程内缓存。 */
  cached: boolean;
  /** 数据来源标注（如 overview 混用 quota_data 与 logs，两者存在 5 分钟延迟差）；可选。 */
  source?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export type ApiErrorCode = "invalid_query" | "query_failed";

export interface ApiFailure {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: QueryIssue[];
  };
}

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

/** 成功响应。 */
export function ok<T>(data: T, meta: ApiMeta): Response {
  const body: ApiSuccess<T> = { ok: true, data, meta };
  return Response.json(body, { headers: NO_STORE_HEADERS });
}

/** 参数校验失败（400）。`issues` 直接来自 Zod flatten，便于前端定位字段。 */
export function invalidQuery(issues: QueryIssue[]): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: "invalid_query", message: "查询参数不合法", issues },
  };
  return Response.json(body, { status: 400, headers: NO_STORE_HEADERS });
}

/** 查询失败（500）：只给通用文案，内部错误由调用方自行记录（不得写入响应体）。 */
export function queryFailed(): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: "query_failed", message: "查询失败" },
  };
  return Response.json(body, { status: 500, headers: NO_STORE_HEADERS });
}

/** `z.flattenError` → 前端可读的 issues 列表（表单级错误 path 为空串）。 */
export function toQueryIssues<T>(error: z.ZodError<T>): QueryIssue[] {
  const flattened = z.flattenError(error);
  const fieldErrors = flattened.fieldErrors as Record<string, string[] | undefined>;
  const issues: QueryIssue[] = flattened.formErrors.map((message) => ({ path: "", message }));

  for (const [path, messages] of Object.entries(fieldErrors)) {
    for (const message of messages ?? []) {
      issues.push({ path, message });
    }
  }
  return issues;
}
