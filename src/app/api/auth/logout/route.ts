/** POST /api/auth/logout —— 清除会话 Cookie（登录链路，middleware 豁免）。 */
import { clearSessionCookie, isSecureRequest } from "@/server/session";

export async function POST(request: Request): Promise<Response> {
  return Response.json(
    { ok: true },
    {
      headers: {
        "cache-control": "no-store",
        "set-cookie": clearSessionCookie(isSecureRequest(request)),
      },
    },
  );
}
