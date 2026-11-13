"use client";

/**
 * 会话详情抽屉：结构化 / 原始报文 / 事件流（仅流式）。
 *
 * 数据来自 `GET /api/audit/sessions/[traceId]`；关闭时不发请求（`useApi(null)`）。
 * 抽屉复用 `ui/dialog`，仅用 class 覆盖成右侧满高，不新增依赖。
 */
import { Loader2, RotateCw, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { MessageBlock } from "@/components/audit/message-block";
import { StatusBadge, Tag } from "@/components/audit/badges";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, formatDateTimeSecond } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { AuditSessionDetail, AuditSessionRow } from "@/server/audit/types";

type Tab = "struct" | "raw" | "events";

function MetaItem({
  label,
  value,
  title,
  className,
  wrap = false,
}: {
  label: string;
  value: string;
  title?: string;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={wrap ? "text-xs break-all" : "truncate text-xs"} title={title ?? value}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function RawPane({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{label}</SectionTitle>
      <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-3 text-[11px] leading-5 whitespace-pre-wrap break-all">
        {text === "" ? "（空）" : text}
      </pre>
    </div>
  );
}

export function AuditDetailDialog({
  userId,
  row,
  onClose,
}: {
  userId: string;
  row: AuditSessionRow | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("struct");

  const url =
    row === null
      ? null
      : `/api/audit/sessions/${encodeURIComponent(row.traceId)}?date=${row.date}&userId=${encodeURIComponent(userId)}&fp=${row.fp}`;
  const api = useApi<AuditSessionDetail>(url);

  const events = useMemo(() => {
    const raw = api.data?.raw.response ?? "";
    if (raw === "") return [];
    return raw.split(/\r?\n\r?\n/).filter((block) => block.trim() !== "");
  }, [api.data?.raw.response]);

  const open = row !== null;
  const envelope = api.data?.envelope;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "struct", label: "结构化" },
    { key: "raw", label: "原始报文" },
    ...(row?.stream === true ? [{ key: "events" as const, label: `事件流（${events.length}）` }] : []),
  ];
  const activeTab = tabs.some((item) => item.key === tab) ? tab : "struct";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 right-0 left-auto flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 sm:max-w-3xl"
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="text-base">
              会话详情
              {row === null ? null : (
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {formatDateTimeSecond(row.startedAtEpoch)}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              某次请求的提示词与模型返回，含原始报文
            </DialogDescription>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {row === null ? null : (
                <>
                  <StatusBadge status={row.status} />
                  <Tag tone="info">{row.stream ? "流式" : "非流式"}</Tag>
                  {row.requestTruncated ? <Tag tone="warning">请求截断</Tag> : null}
                  {row.responseTruncated ? <Tag tone="warning">响应截断</Tag> : null}
                  {row.gzip.request || row.gzip.response ? <Tag>gz</Tag> : null}
                </>
              )}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>

        {row === null ? null : (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 border-b bg-canvas px-5 py-3 sm:grid-cols-4">
            <MetaItem label="trace id" value={row.traceId} className="col-span-2" wrap />
            <MetaItem label="path" value={row.path} />
            <MetaItem label="日期 / 指纹" value={`${row.date} · ${row.fp}`} />
            <MetaItem
              label="总耗时 / 首字"
              value={`${row.durationMs} ms / ${row.stream ? `${row.firstTokenMs} ms` : "—"}`}
            />
            <MetaItem
              label="请求 / 响应"
              value={`${formatBytes(row.requestBytes)} → ${formatBytes(row.responseBytes)}`}
            />
            <MetaItem
              label="压缩 / 截断"
              value={`${row.gzip.request || row.gzip.response ? "gzip" : "无"} · tr=${(row.requestTruncated ? 1 : 0) + (row.responseTruncated ? 2 : 0)}`}
            />
            <MetaItem label="协议" value={row.protocol} />
            <MetaItem label="客户端 IP" value={row.ip ?? "—"} />
          </div>
        )}

        <div className="flex gap-1 border-b px-5">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-pressed={activeTab === item.key}
              className={`border-b-2 px-3 py-2 text-xs transition-colors ${
                activeTab === item.key
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {api.loading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在读取审计正文…
            </div>
          ) : api.error !== undefined ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-6 text-sm">
              <p className="text-muted-foreground">{api.error.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
                <RotateCw className="mr-1 size-3.5" />
                重试
              </Button>
            </div>
          ) : envelope === undefined ? null : (
            <div className="flex flex-col gap-5">
              {envelope.request.parseError === undefined &&
              envelope.response.parseError === undefined ? null : (
                <div className="rounded-xl border bg-warning/10 px-3 py-2 text-xs leading-5">
                  正文可能不完整（
                  {[envelope.request.parseError, envelope.response.parseError]
                    .filter((value) => value !== undefined)
                    .join(" / ")}
                  ）。已保留原始报文，可切到「原始报文」页签查看。
                </div>
              )}

              {activeTab === "struct" ? (
                <>
                  <div>
                    <SectionTitle>
                      请求 · {envelope.request.stream ? "SSE 请求" : "JSON 请求"}
                    </SectionTitle>
                    {envelope.request.messages.length === 0 ? (
                      <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                        无可用请求内容（可能被截断或非对话接口）。
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {envelope.request.messages.map((block) => (
                          <MessageBlock key={block.seq} block={block} />
                        ))}
                      </div>
                    )}
                    {envelope.request.tools === undefined ? null : (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        工具定义 {envelope.request.tools.length} 个：
                        {envelope.request.tools.map((tool) => tool.name).join("、")}
                      </p>
                    )}
                  </div>

                  <div>
                    <SectionTitle>
                      返回
                      {envelope.response.stream === undefined
                        ? ""
                        : ` · ${envelope.response.stream.events} 个事件已拼接`}
                    </SectionTitle>
                    {envelope.response.error === undefined ? null : (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-6">
                        <span className="font-semibold text-destructive">
                          {envelope.response.error.code ?? "error"}
                        </span>
                        {envelope.response.error.type === undefined ? null : (
                          <span className="ml-2 text-muted-foreground">
                            {envelope.response.error.type}
                          </span>
                        )}
                        <br />
                        {envelope.response.error.message}
                      </div>
                    )}
                    {envelope.response.outputs.length === 0 &&
                    envelope.response.error === undefined ? (
                      <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                        无返回内容。
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {envelope.response.outputs.map((block) => (
                          <MessageBlock key={block.seq} block={block} />
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {envelope.response.finishReason === undefined ? null : (
                        <span className="rounded-md border px-1.5 py-0.5">
                          finish_reason {envelope.response.finishReason}
                        </span>
                      )}
                      {envelope.response.usage === undefined ? null : (
                        <span className="rounded-md border px-1.5 py-0.5">
                          prompt / completion / total{" "}
                          {envelope.response.usage.promptTokens ?? "—"} /{" "}
                          {envelope.response.usage.completionTokens ?? "—"} /{" "}
                          {envelope.response.usage.totalTokens ?? "—"}
                        </span>
                      )}
                      {envelope.response.stream === undefined ? null : (
                        <span className="rounded-md border px-1.5 py-0.5">
                          {envelope.response.stream.done ? "[DONE] 已收到" : "流未正常结束"}
                        </span>
                      )}
                      <span className="rounded-md border px-1.5 py-0.5">
                        请求 {formatBytes(envelope.request.bytes)} · 响应{" "}
                        {formatBytes(envelope.response.bytes)}
                      </span>
                    </div>
                  </div>
                </>
              ) : null}

              {activeTab === "raw" ? (
                <>
                  <RawPane
                    label={`原始请求 · ${formatBytes(row?.requestBytes ?? 0)}${row?.gzip.request === true ? " · gzip" : ""}`}
                    text={api.data?.raw.request ?? ""}
                  />
                  <RawPane
                    label={`原始响应 · ${formatBytes(row?.responseBytes ?? 0)}${row?.gzip.response === true ? " · gzip" : ""}`}
                    text={api.data?.raw.response ?? ""}
                  />
                  {api.data?.raw.requestTruncated === true ||
                  api.data?.raw.responseTruncated === true ? (
                    <p className="text-[11px] text-muted-foreground">
                      原始报文超过预览上限（`AUDIT_RAW_PREVIEW_BYTES`），此处只显示前一段。
                    </p>
                  ) : null}
                </>
              ) : null}

              {activeTab === "events" ? (
                <div className="flex flex-col gap-2">
                  <SectionTitle>事件流 · {events.length} 块</SectionTitle>
                  {events.map((block, index) => (
                    <div key={index} className="flex gap-3 border-b py-2 text-[11px]">
                      <span className="w-6 shrink-0 text-muted-foreground">{index + 1}</span>
                      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all">{block}</pre>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
