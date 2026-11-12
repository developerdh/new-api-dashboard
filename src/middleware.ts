/**
 * 全站访问控制：登录会话 Cookie 守卫。
 *
 * 口径：
 * - 页面 / 查询 / 导出接口校验签名会话；未登录页面重定向 `/login?next=…`，API 返回 401 JSON；
 * - `/login`、`/api/auth/*` 为登录链路，必须豁免（否则重定向成环）；
 * - `/api/admin/*`、`/api/snapshot` 维持 Bearer（机器调用，各自守卫），中间件放行；
 * - `/api/health`、Next 静态资源、favicon / robots 豁免（容器 healthcheck 依赖）；
 * - fail-closed：未配置 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` 时拒绝请求（503）；
 *   生产环境另有 instrumentation fail-fast 拒绝启动。
 *
 * 说明：中间件运行在 edge runtime，会话校验只用 WebCrypto（见 `src/server/session.ts`）。
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  readSessionConfig,
  readSessionCookie,
  verifySessionToken,
} from "@/server/session";

const EXEMPT_PREFIXES = ["/_next/", "/api/health", "/api/auth/"];
const EXEMPT_PATHS = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/login",
  "/api/snapshot",
]);
/** Bearer 守卫的机器端点：跳过会话校验（各自校验 ADMIN_TOKEN）。 */
const BEARER_PREFIXES = ["/api/admin/"];

function isExempt(pathname: string): boolean {
  if (EXEMPT_PATHS.has(pathname)) return true;
  if (EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return BEARER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function noStore(headers: Record<string, string> = {}): Record<string, string> {
  return { "cache-control": "no-store", ...headers };
}

function unavailable(): NextResponse {
  return new NextResponse(
    "访问控制未配置：请设置 DASHBOARD_AUTH_USER / DASHBOARD_AUTH_PASS",
    { status: 503, headers: noStore() },
  );
}

function apiUnauthorized(): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code: "unauthorized", message: "登录状态已失效，请重新登录" } },
    { status: 401, headers: noStore() },
  );
}

/** 仅保留站内相对路径，防开放重定向。 */
function safeNext(pathname: string, search: string): string | undefined {
  const target = `${pathname}${search}`;
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/login")) {
    return undefined;
  }
  return target;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL("/login", request.nextUrl.origin);
  const next = safeNext(request.nextUrl.pathname, request.nextUrl.search);
  if (next !== undefined) loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isExempt(pathname)) return NextResponse.next();

  const config = readSessionConfig();
  if (config === null) return unavailable();

  const token = readSessionCookie(request.headers.get("cookie"));
  if (await verifySessionToken(token, config)) return NextResponse.next();

  return pathname.startsWith("/api/") ? apiUnauthorized() : redirectToLogin(request);
}

export const config = {
  // 排除 Next 静态资源与 favicon；其余路径（页面/API/快照文件）均受保护
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
