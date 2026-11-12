/** POST /api/auth/login —— 校验凭据并签发会话 Cookie（登录链路，middleware 豁免）。 */
import { z } from "zod";

import { createRateLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/server/request-origin";
import {
  createSessionToken,
  isSecureRequest,
  readSessionConfig,
  sessionCookie,
  verifyCredentials,
} from "@/server/session";

const bodySchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
});

const NO_STORE = { "cache-control": "no-store" } as const;
/** 登录尝试：同 IP 60s / 10 次（进程内，多实例不共享）。 */
const loginLimiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 2_000 });

function json(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { ...NO_STORE, ...headers } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const config = readSessionConfig();
  if (config === null) {
    return json(503, "access_unconfigured", "访问控制未配置：请联系管理员设置登录凭据");
  }

  // 拒绝跨站表单提交（同源请求可无 Origin，故仅在存在且不匹配时拒绝）
  // 注意：不能直接用 request.url 的 origin——Next 在 Route Handler 中使用服务端监听地址，
  // 经反向代理或非 localhost 访问时与浏览器 Origin 恒不相等，见 request-origin.ts
  const origin = request.headers.get("origin");
  if (origin !== null && !isSameOrigin(request, origin)) {
    return json(403, "invalid_origin", "请求来源不被允许");
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    return json(429, "too_many_attempts", "尝试过于频繁，请稍后再试", {
      "retry-after": String(retryAfter),
    });
  }

  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(await request.json());
  } catch {
    return json(400, "invalid_body", "请提交用户名和密码");
  }

  if (!(await verifyCredentials(payload.username, payload.password, config))) {
    return json(401, "invalid_credentials", "账号或密码错误");
  }

  const token = await createSessionToken(config.user, config);
  return Response.json(
    { ok: true },
    { headers: { ...NO_STORE, "set-cookie": sessionCookie(token, isSecureRequest(request)) } },
  );
}
