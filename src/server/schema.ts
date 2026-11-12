/**
 * Kysely `Database` 接口 —— New API 库的**只读**表结构声明。
 *
 * 状态：**已于 2026-11-11 对真实库复验**（PostgreSQL 18.2，库 `new-api`，只读账号）。
 * 口径来源：`docs/db-schema-notes.md` §3（实测列）与 §4（差异清单）；方案 §2.2 为基线。
 *
 * 实测差异（详见 notes）：
 * - `quota_data` **没有** `prompt_tokens` / `completion_tokens`（Token 拆分改由 logs 提供），
 *   另有 `id`/`use_group`/`token_id`/`channel_id`/`node_name`/`count`；
 * - `logs` 含 `type`（消费类型：2 = 消费）、`id`，以及 prompt/completion；
 * - `users` 含 `display_name`/`used_quota`/`request_count` 等；
 * - 三表均非分区表，位于 `public`。
 *
 * 声明约定：
 * - 可空性按 `information_schema.columns.is_nullable` 实测（`YES` → `| null`）；
 * - `created_at` 为 Unix 秒（int8），连接层已把 int8 反序列化为 number（见 `db.ts`）；
 * - `logs.type = 2` 为消费流水（统计口径常量见 `queries/common.ts` 的 `LOG_TYPE_CONSUME`）。
 */

/** 按小时聚合的用量数据（方案 §2.2/§2.3）：天/周/月汇总主表，最多 5 分钟延迟。 */
export interface QuotaDataTable {
  id: number;
  user_id: number | null;
  username: string | null;
  model_name: string | null;
  created_at: number | null;
  use_group: string | null;
  token_id: number | null;
  channel_id: number | null;
  node_name: string | null;
  token_used: number | null;
  /** 该小时桶内的请求数（实测列；用于对账/精确请求数交叉验证）。 */
  count: number | null;
  quota: number | null;
}

/** 原始消费日志（方案 §2.2）：精确请求数、RPM/TPM。 */
export interface LogsTable {
  id: number;
  user_id: number | null;
  username: string | null;
  created_at: number | null;
  /** 日志类型：2 = 消费（实测；其余类型 quota 为 0）。 */
  type: number | null;
  model_name: string | null;
  quota: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** 用户基础信息（方案 §2.2）：用户名、状态、额度。 */
export interface UsersTable {
  id: number;
  username: string | null;
  display_name: string | null;
  status: number | null;
  quota: number | null;
  used_quota: number | null;
  request_count: number | null;
}

/**
 * 复验状态（与 notes §1 同步）：2026-11-11 已对真实库核验列/类型/索引/保留区间。
 */
export const SCHEMA_VERIFICATION = {
  verified: true,
  verifiedAt: "2026-11-11",
  notesDoc: "docs/db-schema-notes.md",
} as const;

export interface Database {
  quota_data: QuotaDataTable;
  logs: LogsTable;
  users: UsersTable;
}
