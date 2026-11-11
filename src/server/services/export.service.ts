/**
 * CSV 导出服务（BE-M3-01 / 方案 §4、§9.2）。
 *
 * 原则：只调用既有 query / service 函数（与页面同一缓存 key 与 SQL 口径），禁止新写聚合 SQL。
 * 数据集：
 * - usersRanking  → 用户消耗排行（userId/username/quota/token/请求数）
 * - trend         → 全局趋势桶序列（桶起点/标签/消耗/Token/请求数）
 * - modelsRanking → 模型消耗排行（模型/消耗/Token/请求数/单次平均成本）
 * - userModels    → 单用户模型分布（模型/消耗/Token 拆分/占比，必须带 userId）
 *
 * CSV：UTF-8 BOM（Excel 兼容）、引号/逗号/换行转义、英文表头、流式输出。
 */
import { cacheKey } from "@/server/cache";
import {
  QueryValidationError,
  SCOPE_TTL_MS,
  cachedQuery,
  normalizeQueryParams,
  type Granularity,
  type QueryParams,
} from "@/server/queries/common";
import {
  MODEL_RANKING_MAX_LIMIT,
  runModelRankingQuery,
  type ModelRankingRow,
} from "@/server/queries/model";
import { runUserModelsQuery, type UserModelRow, type UserRankingRow } from "@/server/queries/user";
import type { TrendPoint } from "@/server/queries/trend";
import { getTrend, getUserRanking } from "@/server/services/stats.service";

export const EXPORT_DATASETS = [
  "usersRanking",
  "trend",
  "modelsRanking",
  "userModels",
] as const;

export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export interface ExportRequest {
  dataset: ExportDataset;
  params: QueryParams;
  granularity: Granularity;
}

export interface ExportPayload {
  filename: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
}

/** UTF-8 BOM：Excel 打开中文 CSV 不乱码。 */
export const CSV_BOM = "\uFEFF";

const EXPORT_HEADERS: Record<ExportDataset, readonly string[]> = {
  usersRanking: ["user_id", "username", "total_quota", "total_tokens", "request_count"],
  trend: [
    "bucket_start",
    "bucket_label",
    "total_quota",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "request_count",
  ],
  modelsRanking: ["model_name", "total_quota", "total_tokens", "request_count", "avg_cost"],
  userModels: [
    "model_name",
    "total_quota",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "prompt_share",
    "completion_share",
  ],
};

/** 是否需要在 CSV 中转义（含引号/逗号/换行）。 */
const CSV_QUOTE_PATTERN = /[",\r\n]/;

export function escapeCsvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!CSV_QUOTE_PATTERN.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsvLine(fields: readonly unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

/** 行数据 → CSV 流（首块 = BOM + 表头；之后按 100 行分块）。 */
export function csvStream(
  header: readonly string[],
  rows: readonly unknown[][],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${CSV_BOM}${toCsvLine(header)}\r\n`));
    },
    pull(controller) {
      const batch = rows.slice(index, index + 100);
      index += batch.length;
      if (batch.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(batch.map((row) => `${toCsvLine(row)}\r\n`).join("")));
    },
  });
}

export function exportFilename(dataset: ExportDataset, start: number, end: number): string {
  return `dashboard-${dataset}-${start}-${end}.csv`;
}

function csvPayload(
  dataset: ExportDataset,
  params: Pick<QueryParams, "start" | "end">,
  rows: readonly unknown[][],
): ExportPayload {
  const filename = exportFilename(dataset, params.start, params.end);
  return {
    filename,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
    stream: csvStream(EXPORT_HEADERS[dataset], rows),
  };
}

/** 行映射（导出为原始数值，前端/Excel 自行格式化）。 */
export function rowsForUsersRanking(rows: UserRankingRow[]): unknown[][] {
  return rows.map((row) => [
    row.userId,
    row.username,
    row.totalQuota,
    row.totalTokens,
    row.requestCount,
  ]);
}

export function rowsForTrend(points: TrendPoint[]): unknown[][] {
  return points.map((point) => [
    point.bucketStart,
    point.label,
    point.totalQuota,
    point.totalTokens,
    point.promptTokens,
    point.completionTokens,
    point.requestCount,
  ]);
}

export function rowsForModelsRanking(rows: ModelRankingRow[]): unknown[][] {
  return rows.map((row) => [
    row.modelName,
    row.totalQuota,
    row.totalTokens,
    row.requestCount,
    row.avgCost,
  ]);
}

export function rowsForUserModels(rows: UserModelRow[]): unknown[][] {
  return rows.map((row) => [
    row.modelName,
    row.totalQuota,
    row.totalTokens,
    row.promptTokens,
    row.completionTokens,
    row.promptShare,
    row.completionShare,
  ]);
}

/**
 * 解析导出参数：dataset 必填且在枚举内；其余参数复用公共 schema。
 * - userModels 必须带 userId（防全库导出）；
 * - usersRanking / modelsRanking 的 limit 上限 100。
 */
export function resolveExportRequest(searchParams: URLSearchParams): ExportRequest {
  const rawDataset = searchParams.get("dataset");
  if (rawDataset === null || !EXPORT_DATASETS.includes(rawDataset as ExportDataset)) {
    throw new QueryValidationError([
      {
        path: "dataset",
        message: `dataset 必须是 ${EXPORT_DATASETS.join(" / ")}`,
      },
    ]);
  }
  const dataset = rawDataset as ExportDataset;
  const params = normalizeQueryParams(searchParams);
  const granularity = params.granularity ?? "day";

  if (dataset === "userModels" && params.userId === undefined) {
    throw new QueryValidationError([{ path: "userId", message: "userModels 导出必须指定 userId" }]);
  }
  if (
    (dataset === "usersRanking" || dataset === "modelsRanking") &&
    params.limit > MODEL_RANKING_MAX_LIMIT
  ) {
    throw new QueryValidationError([
      { path: "limit", message: `导出 limit 上限 ${MODEL_RANKING_MAX_LIMIT}` },
    ]);
  }

  return { dataset, params, granularity };
}

/** 构建导出响应内容（数据走既有 service/query 与缓存 key，保证与页面同口径）。 */
export async function buildCsvExport(request: ExportRequest): Promise<ExportPayload> {
  const { dataset, params, granularity } = request;
  const range = { start: params.start, end: params.end };

  switch (dataset) {
    case "usersRanking": {
      const { data } = await getUserRanking(params);
      return csvPayload(dataset, params, rowsForUsersRanking(data.rows));
    }
    case "trend": {
      const { data } = await getTrend({
        params: { ...params, granularity },
        compare: "none",
      });
      return csvPayload(dataset, params, rowsForTrend(data.points));
    }
    case "modelsRanking": {
      const key = `${cacheKey("modelDist", range)}:limit=${params.limit}`;
      const { data } = await cachedQuery(key, SCOPE_TTL_MS.usersRanking, () =>
        runModelRankingQuery(range, params.limit),
      );
      return csvPayload(dataset, params, rowsForModelsRanking(data));
    }
    case "userModels": {
      const userId = params.userId as number;
      const key = cacheKey("modelDist", { ...range, userId });
      const { data } = await cachedQuery(key, SCOPE_TTL_MS.modelDist, () =>
        runUserModelsQuery(userId, range),
      );
      return csvPayload(dataset, params, rowsForUserModels(data.models));
    }
  }
}
