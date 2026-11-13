/**
 * 审计正文的类型契约（`newapi.audit.v1`）。
 *
 * 口径来源：`docs/audit-proxy/02-design.md` §5（索引字段）、§7.4（归一化信封）；
 * 索引字段名与 `audit-proxy/capture.go` 的 `indexEntry` **一一对应，不得重命名**——
 * 那是采集与展示之间唯一的共享契约。
 *
 * 本文件只放类型与常量，不含任何 IO；客户端可用 `import type` 引用，不会打进运行时依赖。
 */

/** 归一化信封版本：协议演进时靠它兼容旧数据。 */
export const AUDIT_SCHEMA = "newapi.audit.v1";

/** 采集侧白名单协议（`CAPTURE_PATHS`），未知路径保留原始报文。 */
export type AuditProtocol =
  | "openai-chat"
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses"
  | "unknown";

/** 索引行（`index/<date>.ndjson`），字段名短名与 `capture.go` 一致。 */
export interface AuditIndexEntry {
  /** trace id，等于文件名 */
  t: string;
  /** 调用方指纹 `sha256(Authorization)[:12]`，等于二级目录名；无凭据为 `_anon` */
  u: string;
  /** 开始时间，RFC3339Nano */
  d: string;
  /** 请求路径 */
  p: string;
  /** 模型名（代理仅从请求体前 8KB 提取，可能为空） */
  m: string;
  /** HTTP 状态码 */
  s: number;
  /** 是否流式请求 */
  st: boolean;
  /** 总耗时（毫秒） */
  ms: number;
  /** 首字节耗时（毫秒），无输出为 0 */
  ft: number;
  /** 请求落盘字节数（截断后的实际值） */
  rq: number;
  /** 响应落盘字节数（截断后的实际值） */
  rs: number;
  /** 请求文件是否 gzip */
  qz: boolean;
  /** 响应文件是否 gzip */
  rz: boolean;
  /** 截断位掩码：1=请求截断，2=响应截断 */
  tr: number;
  /** 上游错误信息 */
  e?: string;
  /** 客户端 IP */
  ip?: string;
}

/** 列表行（API 响应与界面共用）。 */
export interface AuditSessionRow {
  traceId: string;
  /** 调用方指纹；详情仅用于同日同名 trace 消歧。 */
  fp: string;
  /** 索引日期 `YYYY-MM-DD`（详情接口必传，避免客户端自行推算）。 */
  date: string;
  /** 原样 RFC3339Nano（东八区），仅用于展示。 */
  startedAt: string;
  /** 解析后的 Unix 秒，便于格式化与排序。 */
  startedAtEpoch: number;
  path: string;
  protocol: AuditProtocol;
  model: string;
  status: number;
  stream: boolean;
  durationMs: number;
  firstTokenMs: number;
  requestBytes: number;
  responseBytes: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
  gzip: { request: boolean; response: boolean };
  /** 索引 `e` 字段（上游错误串），成功时缺省。 */
  error?: string;
  /** 客户端 IP（索引 `ip`）。 */
  ip?: string;
}

/** 列表响应体。 */
export interface AuditSessionList {
  /** 审计目录是否可用；false 时界面显示提示条而不是错误态。 */
  available: boolean;
  sessions: AuditSessionRow[];
  nextCursor: string | null;
  /** 实际读过的索引日期（排障用）。 */
  scannedDates: string[];
  /** 该用户可用的 token 指纹数。 */
  fingerprintCount: number;
  /** tokens 表不可读时的降级原因。 */
  lookupError?: "permission_denied" | "unavailable";
  /** 已扫描范围内、指纹无法归属任何用户的条数（无效/匿名 key）。 */
  unmatched?: number;
}

export type AuditRole = "system" | "user" | "assistant" | "tool" | "unknown";

/** 块类型：避免纯文本假设丢结构（02-design §7.4）。 */
export type AuditKind = "text" | "tool_call" | "tool_result" | "image" | "other";

/** 展开后的内容块：`seq` 全局递增，`messageIndex` 保留原始消息序号。 */
export interface AuditBlock {
  seq: number;
  messageIndex: number;
  role: AuditRole;
  kind: AuditKind;
  text?: string;
  tool?: { name?: string; callId?: string; arguments?: string };
  image?: { mime: string; bytes: number; sha256: string };
}

/** 请求侧归一化结果。 */
export interface AuditRequestBody {
  path: string;
  protocol: AuditProtocol;
  model: string;
  stream: boolean;
  messages: AuditBlock[];
  tools?: Array<{ name: string; description?: string }>;
  truncated: boolean;
  bytes: number;
  parseError?: string;
}

/** 响应侧归一化结果。 */
export interface AuditResponseBody {
  status: number;
  finishReason?: string;
  outputs: AuditBlock[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: { code?: string; type?: string; message?: string };
  stream?: { events: number; done: boolean };
  truncated: boolean;
  bytes: number;
  parseError?: string;
}

/** 归一化信封（02-design §7.4 + 错误体/截断兜底）。 */
export interface AuditEnvelope {
  schema: typeof AUDIT_SCHEMA;
  traceId: string;
  request: AuditRequestBody;
  response: AuditResponseBody;
  meta: {
    truncated: number;
    latencyMs: number;
    firstTokenMs: number;
    capturedAt: string;
    requestBytes: number;
    responseBytes: number;
    gzip: { request: boolean; response: boolean };
    ip?: string;
  };
}

/** 详情响应体：信封 + 原始报文（按上限截断）。 */
export interface AuditSessionDetail {
  envelope: AuditEnvelope;
  raw: {
    request: string;
    response: string;
    requestTruncated: boolean;
    responseTruncated: boolean;
  };
}
