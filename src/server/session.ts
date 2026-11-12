/**
 * 登录会话：HttpOnly Cookie + HMAC-SHA256 签名载荷。
 *
 * 口径：
 * - 凭据源沿用 `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS`，不新增账号体系、不访问数据库；
 * - 签名密钥优先取 `DASHBOARD_SESSION_SECRET`，未配置时由凭据派生（改密码即令全部会话失效）；
 * - 仅用 WebCrypto / atob / btoa，可同时运行在 middleware(edge) 与 Route Handler(node)；
 * - 会话有效期 12h，Cookie 为 HttpOnly + SameSite=Lax，HTTPS 下附加 Secure。
 */

export const SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SESSION_SECRET_ENV = "DASHBOARD_SESSION_SECRET";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SessionConfig {
  user: string;
  pass: string;
  secret: string;
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

/** 读取会话配置；凭据缺失时返回 null（fail-closed 由调用方处理）。 */
export function readSessionConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionConfig | null {
  const user = env.DASHBOARD_AUTH_USER?.trim() ?? "";
  const pass = env.DASHBOARD_AUTH_PASS ?? "";
  if (user === "" || pass === "") return null;
  return {
    user,
    pass,
    secret: env[SESSION_SECRET_ENV]?.trim() || `${user}:${pass}`,
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(digest);
}

/** WebCrypto 的 BufferSource 要求 ArrayBuffer 后备；显式复制以适配 TS 5.7+ 的 Uint8Array 泛型。 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const material = await sha256(`new-api-dashboard/session/v1|${secret}`);
  return crypto.subtle.importKey(
    "raw",
    asArrayBuffer(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 账号密码校验：两端摘要后等长常量时间比较，不因长度/前缀提前返回。 */
export async function verifyCredentials(
  user: string,
  pass: string,
  config: SessionConfig,
): Promise<boolean> {
  const [userDigest, passDigest, expectedUser, expectedPass] = await Promise.all([
    sha256(user),
    sha256(pass),
    sha256(config.user),
    sha256(config.pass),
  ]);
  return constantTimeEqual(userDigest, expectedUser) && constantTimeEqual(passDigest, expectedPass);
}

/** 签发 `<payload>.<signature>`，payload 仅含 sub / iat / exp。 */
export async function createSessionToken(
  sub: string,
  config: SessionConfig,
  now: number = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = { sub, iat: issuedAt, exp: issuedAt + SESSION_TTL_SECONDS };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(config.secret), encoder.encode(body)),
  );
  return `${body}.${toBase64Url(signature)}`;
}

/** 解析并校验会话载荷；签名无效 / 过期 / 结构异常一律返回 null。 */
async function parseSessionToken(
  token: string | undefined,
  config: SessionConfig,
  now: number,
): Promise<SessionPayload | null> {
  if (token === undefined || token === "") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (body.length === 0 || body.length > 512 || signature.length === 0 || signature.length > 128) {
    return null;
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(config.secret),
    asArrayBuffer(signatureBytes),
    encoder.encode(body),
  );
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body))) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}

/** 校验签名、过期时间与账号绑定；任何异常都视为未登录。 */
export async function verifySessionToken(
  token: string | undefined,
  config: SessionConfig,
  now?: number,
): Promise<boolean> {
  if (token === undefined || token === "") return false;
  const payload = await parseSessionToken(token, config, now ?? Date.now());
  return payload !== null && payload.sub === config.user;
}

/**
 * 读取已登录账号名（供服务端布局展示），不额外暴露鉴权信息。
 *
 * 注意：`now` 必须是**可选参数**并在空 token 之后求值。布局会在预渲染阶段运行，
 * 此时没有 Cookie；若用 `now: number = Date.now()` 默认参数，`Date.now()` 会先被求值，
 * 触发 Cache Components 的 unstable value 检查（`blocking-prerender-current-time`）。
 */
export async function readSessionUsername(
  token: string | undefined,
  config: SessionConfig,
  now?: number,
): Promise<string | null> {
  if (token === undefined || token === "") return null;
  const payload = await parseSessionToken(token, config, now ?? Date.now());
  return payload?.sub ?? null;
}

/** 从 Cookie 请求头中读取会话值（不依赖 NextRequest.cookies，便于单测）。 */
export function readSessionCookie(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** 仅在本站 HTTPS（含反向代理转发的 https）下设置 Secure。 */
export function isSecureRequest(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
  );
}
