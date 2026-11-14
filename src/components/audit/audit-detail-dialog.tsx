"use client";

/**
 * 会话详情抽屉：结构化 / 原始报文 / 事件流（仅流式）。
 *
 * 空间与可读性取向：
 * - 元信息压成一行（trace/协议/大小/耗时/ip），完整字段收进「详细信息」；
 * - 请求默认只展开最后 3 条上下文，更早的内容折叠（同一会话的历史重发导致"每条前面都一样"）；
 * - 正文、工具参数超过阈值默认折叠（`MessageBlock`）；
 * - 结构化视图带角色 / 类型 / 关键词过滤，事件流按事件类型聚合（一次响应可能上千个 delta）。
 */
import { Loader2, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { StatusBadge, Tag } from "@/components/audit/badges";
import {
  blockMatches,
  isDefaultFilter,
  MessageFilterBar,
  type BlockFilter,
} from "@/components/audit/audit-message-filters";
import { MessageBlock } from "@/components/audit/message-block";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, formatDateTimeSecond, formatNumber } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import type {
  AuditSessionDetail,
  AuditSessionRow,
} from "@/server/audit/types";

type Tab = "struct" | "raw" | "events";

/** 请求默认只展开的上下文条数。 */
const RECENT_BLOCKS = 3;

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
      {aside}
    </div>
  );
}

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

function UsageStrip({
  usage,
}: {
  usage: NonNullable<AuditSessionDetail["envelope"]["response"]["usage"]>;
}) {
  const items: Array<[string, number | undefined]> = [
    ["输入", usage.promptTokens],
    ["输出", usage.completionTokens],
    ["缓存读取", usage.cachedTokens],
    ["缓存写入", usage.cacheWriteTokens],
    ["总计", usage.totalTokens],
  ];
  const visible = items.filter((item): item is [string, number] => typeof item[1] === "number");
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-5 py-1.5 text-[11px]">
      <span className="font-semibold text-muted-foreground">Token 明细</span>
      {visible.map(([label, value]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums">{formatNumber(value)}</span>
        </span>
      ))}
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
  // 全屏是视图偏好，切换请求时保持
  const [full, setFull] = useState(false);
  const [tab, setTab] = useState<Tab>("struct");
  const [filter, setFilter] = useState<BlockFilter>({ role: "all", kind: "all", query: "" });
  const [keywordInput, setKeywordInput] = useState("");
  // 防抖：输入停顿 180ms 后再过滤，避免长会话逐键全量扫描
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter((current) => ({ ...current, query: keywordInput.trim().toLowerCase() }));
    }, 180);
    return () => clearTimeout(timer);
  }, [keywordInput]);
  const [expandEarly, setExpandEarly] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

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

  const eventGroups = useMemo(() => {
    const map = new Map<string, { count: number; sample: string }>();
    for (const block of events) {
      const match = /^event:\s*(.+)$/m.exec(block);
      const name = match?.[1]?.trim() ?? "message";
      const current = map.get(name);
      if (current === undefined) map.set(name, { count: 1, sample: block });
      else current.count += 1;
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [events]);

  const envelope = api.data?.envelope;
  const requestBlocks = envelope?.request.messages ?? [];
  const outputBlocks = envelope?.response.outputs ?? [];
  const allBlocks = [...requestBlocks, ...outputBlocks];
  const defaultFilter = isDefaultFilter(filter);

  const requestShown = requestBlocks.filter((block) => blockMatches(block, filter));
  const outputShown = outputBlocks.filter((block) => blockMatches(block, filter));
  const hitCount = requestShown.length + outputShown.length;
  const earlyCount =
    requestBlocks.length > RECENT_BLOCKS ? requestBlocks.length - RECENT_BLOCKS : 0;
  const collapsed = defaultFilter && !expandEarly && earlyCount > 0;
  const requestVisible = collapsed ? requestBlocks.slice(-RECENT_BLOCKS) : requestShown;

  const open = row !== null;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "struct", label: "结构化" },
    { key: "raw", label: "原始报文" },
    ...(row?.stream === true ? [{ key: "events" as const, label: "事件流" }] : []),
  ];
  const activeTab = tabs.some((item) => item.key === tab) ? tab : "struct";

  const resetFilters = (): void => {
    setFilter({ role: "all", kind: "all", query: "" });
    setKeywordInput("");
    setExpandEarly(false);
  };
  const highlight = keywordInput.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          // 抽屉形态：右贴边全高；全屏时占满整个视口宽度并去掉左边框。
          // 两种形态都必须覆盖基类的 sm:max-w-lg，否则会被压回 512px。
          "top-0 right-0 left-auto flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0",
          full ? "border-l-0 sm:max-w-none" : "border-l sm:max-w-3xl",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
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
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {row === null ? null : (
                <>
                  <StatusBadge status={row.status} />
                  <Tag tone="info">{row.stream ? "流式" : "非流式"}</Tag>
                  {row.requestTruncated || row.responseTruncated ? (
                    <Tag tone="warning">截断</Tag>
                  ) : null}
                  {row.model === "" ? null : <span className="text-[11px] text-muted-foreground">{row.model}</span>}
                </>
              )}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            onClick={() => setFull((value) => !value)}
            aria-label={full ? "退出全屏" : "全屏显示"}
            title={full ? "退出全屏" : "全屏显示（查看长报文更方便）"}
          >
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
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
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-5 py-1.5 text-[11px] text-muted-foreground">
              <span className="max-w-[15rem] truncate font-mono" title={row.traceId}>
                {row.traceId}
              </span>
              <span>·</span>
              <span>{row.protocol}</span>
              <span>·</span>
              <span className="tabular-nums">
                {formatBytes(row.requestBytes)} → {formatBytes(row.responseBytes)}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                {row.durationMs} ms
                {row.stream ? ` · 首字 ${row.firstTokenMs} ms` : ""}
              </span>
              {row.gzip.request || row.gzip.response ? (
                <>
                  <span>·</span>
                  <span>gzip</span>
                </>
              ) : null}
              <span>·</span>
              <span className="font-mono">{row.ip ?? "—"}</span>
              <button
                type="button"
                className="ml-auto text-primary hover:underline"
                onClick={() => setShowMeta((value) => !value)}
              >
                {showMeta ? "收起" : "详细信息"}
              </button>
            </div>

            {showMeta ? (
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 border-b bg-canvas px-5 py-3 sm:grid-cols-4">
                <MetaItem label="trace id" value={row.traceId} className="col-span-2" wrap />
                <MetaItem label="path" value={row.path} />
                <MetaItem label="日期 / 指纹" value={`${row.date} · ${row.fp}`} />
                <MetaItem
                  label="总耗时 / 首字"
                  value={`${row.durationMs} ms / ${row.stream ? `${row.firstTokenMs} ms` : "—"}`}
                />
                <MetaItem
                  label="压缩 / 截断"
                  value={`${row.gzip.request || row.gzip.response ? "gzip" : "无"} · tr=${(row.requestTruncated ? 1 : 0) + (row.responseTruncated ? 2 : 0)}`}
                />
                <MetaItem label="协议" value={row.protocol} />
                <MetaItem label="客户端 IP" value={row.ip ?? "—"} />
              </div>
            ) : null}
          </>
        )}

        {envelope?.response.usage === undefined ? null : (
          <UsageStrip usage={envelope.response.usage} />
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
          {activeTab === "struct" && envelope !== undefined ? (
            <span className="ml-auto self-center text-[11px] text-muted-foreground">
              命中 {hitCount} / 共 {allBlocks.length}
            </span>
          ) : null}
        </div>

        {activeTab === "struct" && envelope !== undefined ? (
          <div className="border-b px-5 py-1.5">
            <MessageFilterBar
              filter={filter}
              queryInput={keywordInput}
              onFilterChange={(patch) => setFilter((current) => ({ ...current, ...patch }))}
              onQueryInputChange={setKeywordInput}
              onReset={resetFilters}
            />
          </div>
        ) : null}

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

              {envelope.request.protocol === "openai-completions" ? (
                <p className="text-[11px] text-muted-foreground">
                  `/v1/completions` 只有一段 prompt 字符串，无角色字段，请求内容按用户输入展示。
                </p>
              ) : null}

              {activeTab === "struct" ? (
                <>
                  <div>
                    <SectionTitle
                      aside={
                        <span className="text-[11px] font-normal">
                          {row?.stream === true ? "流式" : "JSON"}
                        </span>
                      }
                    >
                      请求 · {requestBlocks.length} 项
                    </SectionTitle>

                    {earlyCount > 0 && defaultFilter ? (
                      <button
                        type="button"
                        onClick={() => setExpandEarly((value) => !value)}
                        className="mb-2 w-full rounded-lg border border-dashed px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-muted/40"
                      >
                        更早的上下文 {earlyCount} 项
                        {expandEarly
                          ? " · 点击收起"
                          : "（同一会话的历史重发，默认折叠）· 点击展开"}
                      </button>
                    ) : null}

                    {requestVisible.length === 0 ? (
                      <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                        {requestBlocks.length === 0
                          ? "无可用请求内容（可能被截断或非对话接口）。"
                          : "当前筛选条件下没有请求内容。"}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {requestVisible.map((block) => (
                          <MessageBlock key={block.seq} block={block} keyword={highlight} />
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
                    <SectionTitle>返回</SectionTitle>
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
                    {outputShown.length === 0 && envelope.response.error === undefined ? (
                      <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                        {outputBlocks.length === 0 ? "无返回内容。" : "当前筛选条件下没有返回内容。"}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {outputShown.map((block) => (
                          <MessageBlock key={block.seq} block={block} keyword={highlight} />
                        ))}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {envelope.response.finishReason === undefined ? null : (
                        <span className="rounded-md border px-1.5 py-0.5">
                          finish_reason {envelope.response.finishReason}
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
                <div className="flex flex-col gap-1">
                  <SectionTitle
                    aside={<span className="text-[11px] font-normal">{formatNumber(events.length)} 个事件</span>}
                  >
                    事件类型
                  </SectionTitle>
                  {eventGroups.map(([name, group]) => {
                    const expanded = openGroups.has(name);
                    return (
                      <div key={name} className="rounded-lg border">
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-2 text-left text-[11px]"
                          onClick={() => {
                            setOpenGroups((current) => {
                              const next = new Set(current);
                              if (next.has(name)) next.delete(name);
                              else next.add(name);
                              return next;
                            });
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                          <span className="tabular-nums text-muted-foreground">{formatNumber(group.count)}</span>
                          <span className="text-primary">{expanded ? "收起样例" : "查看样例"}</span>
                        </button>
                        {expanded ? (
                          <pre className="max-h-60 overflow-auto border-t bg-muted/30 p-3 text-[11px] leading-5 whitespace-pre-wrap break-all">
                            {group.sample}
                          </pre>
                        ) : null}
                      </div>
                    );
                  })}
                  {eventGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">未解析到 SSE 事件。</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
