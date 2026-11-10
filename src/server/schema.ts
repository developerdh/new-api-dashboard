/**
 * Kysely `Database` 接口 —— New API 库的**只读**表结构声明。
 *
 * 状态：**基线，未对真实库复验**（BE-M0-03，2026-11-10）。
 * 口径来源：
 * - 列清单：`docs/方案.md` §2.2「常见字段」（方案自述「字段以实际 \d 为准」，故非库事实）；
 * - 核验清单、差异判据与晋升规则：`docs/db-schema-notes.md`（本文件按其台账校准）。
 *
 * 校准规则（M1 编码前必读）：
 * 1. `Database` 只放「方案 §2.2 基线列」——M1 允许直接编码的字段集合；
 * 2. 未经真实库 `\d` 核验的候选列一律隔离在下方 `*CandidateColumns`，**不并入 `Database`**：
 *    类型层直接拦住「照猜测写查询」，复验后按 db-schema-notes.md §4/§5 晋升或删除；
 * 3. 可空性暂按 NOT NULL 声明；复验时以 `information_schema.columns.is_nullable` 逐列修正
 *    （Kysely 下影响 SELECT 结果是否收窄为 `| null`）；
 * 4. `created_at` = Unix 秒；int8 → number 的反序列化由 `db.ts` 进程级注册（2^53 内安全）。
 *
 * 聚合返回类型口径（M1 必读，见 notes §5.3）：`SUM(bigint)` / `AVG()` 返回 numeric，
 * node-postgres 默认把 numeric 解析为 **string**；需要 number 时在 SQL 内显式 `::bigint`。
 */

/** 按小时聚合的用量数据（方案 §2.2/§2.3）：天/周/月汇总主表，最多 5 分钟延迟。 */
export interface QuotaDataTable {
  user_id: number;
  username: string;
  model_name: string;
  created_at: number;
  token_used: number;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** 原始消费日志（方案 §2.2）：精确请求数、RPM/TPM。 */
export interface LogsTable {
  user_id: number;
  username: string;
  created_at: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** 用户基础信息（方案 §2.2）：用户名、状态、额度。 */
export interface UsersTable {
  id: number;
  username: string;
  status: number;
  quota: number;
}

/**
 * 候选列（**未核验，禁止在查询中引用**）。
 *
 * 存在性、列名与实际类型都待真实库复验；复验结论落 `docs/db-schema-notes.md` §4，
 * 晋升动作 = 移入对应 `*Table` + 更新本文件/单测/notes §3，三者同步。
 * 隔离在独立接口而非注释，是为了让「多加一列」必然触发类型检查失败。
 */

/** quota_data 候选列。 */
export interface QuotaDataCandidateColumns {
  /** 主键（PostgreSQL 表通常有；列名/类型待核验）。 */
  id: number;
  /** 小时桶内请求数：若存在，请求数可直接从 quota_data 取，避免 logs 全量 COUNT。 */
  count: number;
}

/** logs 候选列。 */
export interface LogsCandidateColumns {
  /** 消费/日志类型：若存在，请求数需按「消费」过滤，否则 COUNT(*) 会高估。 */
  type: number;
  /** 主键（列名/类型待核验）。 */
  id: number;
}

/** users 候选列。 */
export interface UsersCandidateColumns {
  /** 已用额度：若存在，可与 quota 组合出「剩余额度」展示口径。 */
  used_quota: number;
}

/**
 * 复验状态（与 notes §1 同步）：真实库核验通过后置 `verified: true` 并填日期，
 * 同时把候选列按结论晋升、更新单测。当前为 false，意味着 M1 只可使用上面三张表接口。
 */
export const SCHEMA_VERIFICATION = {
  verified: false,
  verifiedAt: null,
  notesDoc: "docs/db-schema-notes.md",
} as const;

export interface Database {
  quota_data: QuotaDataTable;
  logs: LogsTable;
  users: UsersTable;
}
