/**
 * 沉默用户服务：参数解析（含区间上限）+ 缓存编排；SQL 与集合差集在 `queries/inactive.ts`。
 *
 * 与排行服务同构：复用 `usersRanking` 缓存档（TTL 120s），key 追加 `:inactive:limit=N` 段避免与排行冲突。
 * 上期区间由 `start/end` 确定性推导，因此无需进 key。
 */
import { cacheKey } from "@/server/cache";
import {
  INACTIVE_DEFAULT_LIMIT,
  INACTIVE_MAX_LIMIT,
  INACTIVE_MAX_RANGE_SECONDS,
  runInactiveUsersQuery,
  type InactiveUsersSnapshot,
} from "@/server/queries/inactive";
import {
  QueryValidationError,
  SCOPE_TTL_MS,
  cachedQuery,
  normalizeQueryParams,
  type QueryParams,
} from "@/server/queries/common";

/** 数据来源标注：logs（活跃判定/请求数/最后活跃）+ users（当前用户名）。 */
export const INACTIVE_SOURCE = "logs+users" as const;

/** 与用户排行共用 120s TTL 档；key 后缀区分命名空间。 */
export const INACTIVE_CACHE_SCOPE = "usersRanking" as const;

/**
 * 解析参数：
 * - `start`/`end` 必填（ISO 或 Unix 秒），复用公共 schema；
 * - `limit` 缺省 100（不是公共件的 20），上限 500；
 * - 本期区间上限 366 天：上期要回溯等长窗口，避免大范围扫描撞 30s statement_timeout。
 */
export function resolveInactiveParams(searchParams: URLSearchParams): QueryParams {
  const params = normalizeQueryParams(searchParams);
  const limit = searchParams.has("limit") ? params.limit : INACTIVE_DEFAULT_LIMIT;

  if (limit > INACTIVE_MAX_LIMIT) {
    throw new QueryValidationError([
      { path: "limit", message: `沉默用户 limit 上限 ${INACTIVE_MAX_LIMIT}` },
    ]);
  }
  if (params.end - params.start > INACTIVE_MAX_RANGE_SECONDS) {
    throw new QueryValidationError([
      {
        path: "range",
        message: `沉默用户统计区间上限 ${INACTIVE_MAX_RANGE_SECONDS / 86_400} 天`,
      },
    ]);
  }

  return { ...params, limit };
}

/** 缓存 key：区间 + limit（limit 改变结果集，必须进 key）。 */
export function inactiveCacheKey(params: QueryParams): string {
  const base = cacheKey(INACTIVE_CACHE_SCOPE, {
    start: params.start,
    end: params.end,
  });
  return `${base}:inactive:limit=${params.limit}`;
}

/** 取沉默用户清单：缓存命中直返；未命中执行集合差集查询（TTL 120s）。 */
export async function getInactiveUsers(
  params: QueryParams,
): Promise<{ data: InactiveUsersSnapshot; cached: boolean }> {
  return cachedQuery(inactiveCacheKey(params), SCOPE_TTL_MS.usersRanking, () =>
    runInactiveUsersQuery({ start: params.start, end: params.end }, params.limit),
  );
}
