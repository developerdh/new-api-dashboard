/**
 * 全站访问控制（BE-M4-02 / 方案 §9、§11.2）：HTTP Basic Auth 应用层兜底。
 *
 * 口径：
 * - 页面 / 查询 / 导出接口走 Basic Auth（`DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS`）；
 * - `/api/admin/*`、`/api/snapshot` 维持 Bearer（机器调用，各自守卫），中间件放行；
 * - `/api/health`、Next 静态资源、图片、favicon 豁免（容器 healthcheck 依赖）；
 * - 凭据比较：两端 SHA-256 摘要后按字节做常量时间比较（不因长度/前缀提前返回）；
 * - fail-closed：未配置凭据时拒绝请求（503）；生产环境另有 instrumentation fail-fast 拒绝启动。
 *
 * 说明：中间件运行在 edge runtime，使用 WebCrypto（crypto.subtle）而非 node:crypto。
 */
import { NextResponse, type NextRequest } from "next/server";

const REALM = 'Basic realm="new-api-dashboard", charset="UTF-8"';

const EXEMPT_PREFIXES = ["/_next/", "/api/health"];
const EXEMPT_PATHS = new Set(["/favicon.ico", "/robots.txt", "/api/snapshot"]);
/** Bearer 守卫的机器端点：跳过 Basic Auth（各自校验 ADMIN_TOKEN）。 */
const BEARER_PREFIXES = ["/api/admin/"];

function isExempt(pathname: string): boolean {
  if (EXEMPT_PATHS.has(pathname)) return true;
  if (EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (BEARER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  // 静态图片/字体等（Next 会走 _next/，其余公开资源不豁免）
  return false;
}

function unauthorized(): NextResponse {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": REALM, "cache-control": "no-store" },
  });
}

function unavailable(): NextResponse {
  return new NextResponse("访问控制未配置：请设置 DASHBOARD_AUTH_USER / DASHBOARD_AUTH_PASS", {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** 两段摘要逐字节 XOR 累积（长度相同，不提前返回）。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseBasicCredentials(header: string | null): { user: string; pass: string } | null {
  if (header === null) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (match === null) return null;

  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isExempt(pathname)) return NextResponse.next();

  const expectedUser = process.env.DASHBOARD_AUTH_USER?.trim() ?? "";
  const expectedPass = process.env.DASHBOARD_AUTH_PASS ?? "";
  if (expectedUser === "" || expectedPass === "") return unavailable();

  const credentials = parseBasicCredentials(request.headers.get("authorization"));
  if (credentials === null) return unauthorized();

  const [userDigest, passDigest, expectedUserDigest, expectedPassDigest] = await Promise.all([
    sha256(credentials.user),
    sha256(credentials.pass),
    sha256(expectedUser),
    sha256(expectedPass),
  ]);

  if (!constantTimeEqual(userDigest, expectedUserDigest)) return unauthorized();
  if (!constantTimeEqual(passDigest, expectedPassDigest)) return unauthorized();

  return NextResponse.next();
}

export const config = {
  // 排除 Next 静态资源与 favicon；其余路径（页面/API/快照文件）均受保护
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
