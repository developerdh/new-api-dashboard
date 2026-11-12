"use client";

/** 登录表单：凭据校验 → 会话 Cookie → 回到原目标页（整页跳转让 middleware 立即生效）。 */
import { AlertCircle, ArrowRight, Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 仅允许站内非登录、非 API 的相对路径，防开放重定向。 */
function sanitizeNext(value: string | null): string {
  if (
    value === null ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/login") ||
    value.startsWith("/api/")
  ) {
    return "/dashboard";
  }
  return value;
}

interface LoginResponse {
  ok: boolean;
  error?: { code: string; message: string };
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = sanitizeNext(searchParams.get("next"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json()) as LoginResponse;

      if (!response.ok || body.ok === false) {
        setError(body.error?.message ?? "登录失败，请稍后重试");
        setSubmitting(false);
        return;
      }
      window.location.assign(next);
    } catch {
      setError("网络请求失败，请稍后重试");
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] rounded-2xl border border-border bg-card p-7 shadow-[0_12px_40px_rgb(0_0_0/0.08)] sm:p-8">
      <div className="flex flex-col items-start gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
          <LockKeyhole className="size-5" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">登录使用量看板</h1>
          <p className="text-sm text-muted-foreground">使用管理员提供的账号继续访问统计数据。</p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="login-username" className="block text-xs font-medium text-foreground">
            账号
          </label>
          <div className="relative">
            <UserRound
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={userRef}
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              placeholder="请输入账号"
              className="pl-9"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              required
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "login-error"}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="login-password" className="block text-xs font-medium text-foreground">
            密码
          </label>
          <div className="relative">
            <LockKeyhole
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="请输入密码"
              className="pl-9 pr-10"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "login-error"}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        {error !== null ? (
          <div
            id="login-error"
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <Button
          type="submit"
          className="h-11 w-full gap-2 text-sm font-medium"
          disabled={submitting || username === "" || password === ""}
        >
          {submitting ? "正在登录…" : "登录"}
          {submitting ? null : <ArrowRight className="size-4" aria-hidden="true" />}
        </Button>
      </form>

      <p className="mt-6 border-t border-border pt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
        本看板只读连接 New API 数据库，账号与中转站账号体系相互独立。
      </p>
    </div>
  );
}
