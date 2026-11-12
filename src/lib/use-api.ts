"use client";

/**
 * 统一数据获取 hook：fetch + loading/error + 可选轮询，不引入 SWR/react-query。
 *
 * 约定：后端统一响应 `{ ok, data, meta }` / `{ ok:false, error:{ code, message, issues? } }`。
 * `url` 为 null 或 `enabled=false` 时不发请求（便于等待时间选择器参数就绪）。
 */
import { useCallback, useEffect, useState } from "react";

export interface ApiMetaPayload {
  range: { start: number; end: number };
  granularity: "day" | "week" | "month" | null;
  cached: boolean;
  source?: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  issues?: Array<{ path: string; message: string }>;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  meta?: ApiMetaPayload;
  error?: ApiErrorPayload;
}

export interface UseApiOptions {
  /** 轮询间隔（毫秒）；0/未设置 = 不轮询。 */
  refetchInterval?: number;
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | undefined;
  meta: ApiMetaPayload | undefined;
  error: ApiErrorPayload | undefined;
  loading: boolean;
  refresh: () => void;
}

export function useApi<T>(url: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const { refetchInterval = 0, enabled = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [meta, setMeta] = useState<ApiMetaPayload | undefined>(undefined);
  const [error, setError] = useState<ApiErrorPayload | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(url !== null && enabled);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (url === null || !enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- url/enabled 变化时收敛 loading（外部条件 → 展示状态）
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const run = async (showLoading: boolean): Promise<void> => {
      if (showLoading) setLoading(true);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        // 会话过期：回到登录页并保留当前位置，避免停留在一屏失败卡片上
        if (response.status === 401) {
          const target = `${window.location.pathname}${window.location.search}`;
          // 会话过期需整页导航，让 middleware 重新判断并渲染登录页
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/login?next=${encodeURIComponent(target)}`);
          return;
        }

        const body = (await response.json()) as ApiEnvelope<T>;
        if (cancelled) return;

        if (!response.ok || body.ok === false) {
          setError(
            body.error ?? {
              code: `http_${response.status}`,
              message: `请求失败（HTTP ${response.status}）`,
            },
          );
        } else {
          setData(body.data);
          setMeta(body.meta);
          setError(undefined);
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError({ code: "network_error", message: "网络请求失败，请稍后重试" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run(true);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (refetchInterval > 0) {
      timer = setInterval(() => {
        void run(false);
      }, refetchInterval);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [enabled, nonce, refetchInterval, url]);

  return { data, meta, error, loading, refresh };
}
