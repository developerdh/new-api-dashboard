/**
 * 解析请求的「对外 origin」。
 *
 * 背景：Next.js 在 Route Handler 中构造的 `request.url` 使用服务端自身的监听地址
 * （实测为 `http://localhost:<PORT>`），并不反映 `Host` / `X-Forwarded-*`。
 * 因此直接用 `new URL(request.url).origin` 与浏览器 `Origin` 比较，会在任何
 * 「经反向代理或非 localhost 访问」的部署下恒不相等，导致登录被误判为跨站。
 *
 * 口径：优先取代理转发头（`X-Forwarded-Host` → `Host`），协议取
 * `X-Forwarded-Proto`，缺失时回退到请求 URL 自身；两者都缺失才退回 `request.url`。
 */

/** 逗号分隔的转发头取第一个值（多级代理时最左为客户端侧）。 */
function firstValue(raw: string | null): string | null {
  const value = raw?.split(",")[0]?.trim();
  return value === undefined || value === "" ? null : value;
}

export function externalOrigin(request: Request): string {
  const headers = request.headers;
  const host = firstValue(headers.get("x-forwarded-host")) ?? firstValue(headers.get("host"));
  const ownUrl = new URL(request.url);

  if (host === null) return ownUrl.origin;

  const proto = firstValue(headers.get("x-forwarded-proto")) ?? ownUrl.protocol.replace(":", "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return ownUrl.origin;
  }
}

/** 浏览器 `Origin` 是否与本次请求的对外 origin 一致（同源判定）。 */
export function isSameOrigin(request: Request, origin: string): boolean {
  try {
    return new URL(origin).origin === externalOrigin(request);
  } catch {
    return false;
  }
}

/**
 * 客户端 IP（限流键等场景）。
 *
 * 口径：优先取 `X-Real-IP`——nginx 参考配置（docs/nginx.example.conf）将其固定为
 * `$remote_addr`，客户端无法伪造；仅当缺失时回落 `X-Forwarded-For` 首段（追加模式下
 * 该段可被客户端伪造，只作无 X-Real-IP 部署的兜底）；两者都缺失返回 `unknown`
 * （本地直连，限流退化为进程内全局桶）。
 * 前提：应用只应暴露给可信反代（见 SECURITY.md），否则任何转发头都可被直连方伪造。
 */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;
  return firstValue(request.headers.get("x-forwarded-for")) ?? "unknown";
}
