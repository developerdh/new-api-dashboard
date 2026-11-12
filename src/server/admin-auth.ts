/**
 * 管理端点访问控制（方案 §6.3(5)、§9.3）。
 *
 * 口径：
 * - `ADMIN_TOKEN` 未配置或为空 → 端点整体禁用，返回 **404**（禁用优先，不暴露端点存在）；
 * - 已配置 → 必须携带 `Authorization: Bearer <token>`，缺失/错误返回 401 + `WWW-Authenticate`；
 * - 比较用 SHA-256 摘要后 timingSafeEqual（等长比较，避免长度/前缀时序泄漏）；
 * - 响应一律 `no-store`，防止管理结果被缓存。
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_TOKEN_ENV = "ADMIN_TOKEN";
export const ADMIN_DISABLED_CODE = "ADMIN_DISABLED";
export const ADMIN_UNAUTHORIZED_CODE = "ADMIN_UNAUTHORIZED";

const BEARER_PATTERN = /^Bearer\s+(\S.*)$/i;

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

/** 摘要后比较：两值长度恒为 32 字节，`timingSafeEqual` 不会因长度差异提前返回。 */
function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** 端点是否启用（配置了非空 ADMIN_TOKEN）。 */
export function isAdminEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env[ADMIN_TOKEN_ENV]?.trim() ?? "") !== "";
}

/**
 * 校验管理请求：返回 `null` 表示放行；否则返回现成的错误响应（404 禁用 / 401 未授权）。
 * 在 Route Handler 里第一行调用，未放行直接 return。
 */
export function requireAdmin(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Response | null {
  const token = env[ADMIN_TOKEN_ENV]?.trim() ?? "";
  if (token === "") {
    return jsonError(404, ADMIN_DISABLED_CODE, "管理端点在未配置 ADMIN_TOKEN 时禁用");
  }

  const header = request.headers.get("authorization");
  const match = header === null ? null : BEARER_PATTERN.exec(header);
  if (match === null) {
    return jsonError(401, ADMIN_UNAUTHORIZED_CODE, "缺少 Authorization: Bearer <token>", {
      "www-authenticate": 'Bearer realm="new-api-dashboard"',
    });
  }

  if (!safeEqual(match[1].trim(), token)) {
    return jsonError(401, ADMIN_UNAUTHORIZED_CODE, "ADMIN_TOKEN 不匹配", {
      "www-authenticate": 'Bearer realm="new-api-dashboard"',
    });
  }

  return null;
}
