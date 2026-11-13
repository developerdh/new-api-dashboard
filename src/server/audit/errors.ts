/**
 * 审计接口的错误收敛：把读取层的异常映射为统一错误信封。
 *
 * 约定与 `src/server/http.ts` 一致（`{ ok:false, error:{ code, message, issues? } }`），
 * 但不扩展全局的 `ApiErrorCode` 联合类型——审计层错误码只服务这两个路由。
 *
 * 红线：500 只给通用文案；路径、errno、堆栈只进服务端日志，不进响应体。
 */
import { AuditBlobMissingError } from "@/server/audit/reader";
import { AuditPathError, AuditQueryError } from "@/server/audit/paths";

const NO_STORE = { "cache-control": "no-store" } as const;

export type AuditErrorCode =
  | "invalid_query"
  | "not_found"
  | "ambiguous_trace"
  | "audit_read_failed";

export function auditError(
  status: number,
  code: AuditErrorCode,
  message: string,
  issues?: Array<{ path: string; message: string }>,
): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(issues === undefined ? {} : { issues }) } },
    { status, headers: NO_STORE },
  );
}

/** `traceId` 同日命中多条（客户端复用 `X-Request-Id` 重试）时的 409。 */
export class AuditAmbiguousError extends Error {
  readonly code = "ambiguous_trace";

  constructor() {
    super("同一天存在多条同名 trace，请从列表重新进入");
    this.name = "AuditAmbiguousError";
  }
}

/**
 * 异常 → 响应。调用方只负责记录日志（不记录路径与 errno 细节）。
 */
export function toAuditErrorResponse(error: unknown): Response {
  if (error instanceof AuditQueryError) {
    return auditError(400, "invalid_query", error.message, error.issues);
  }
  if (error instanceof AuditPathError) {
    return auditError(400, "invalid_query", "查询参数不合法");
  }
  if (error instanceof AuditBlobMissingError) {
    return auditError(404, "not_found", "会话不存在或已被清理");
  }
  if (error instanceof AuditAmbiguousError) {
    return auditError(409, "ambiguous_trace", error.message);
  }
  return auditError(500, "audit_read_failed", "读取审计记录失败");
}
