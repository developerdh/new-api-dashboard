"use client";

/**
 * 会话线程抽屉：把一个会话键下的多轮请求按时间排开，每轮只展示**本轮新增**。
 *
 * 为什么需要它：同一会话里客户端每轮都把完整历史重发一遍，单请求视图打开
 * 第 37 轮只能看到前 36 轮的回放。列表层聚合解决"几十行长得一样"，
 * 这里解决"打开后内容长得一样"——靠服务端算的消息前缀差分（`delta`）。
 *
 * 交互取向：
 * - 打开即展开**最后一轮**（管理员最常看的是刚刚那次）；
 * - 每轮正文按需加载（一次 3 个文件读），不预取全部轮次；
 * - 开头的系统提示 / 上一轮回答归入「上下文回放」默认折叠，不与本轮输入抢占注意力；
 * - 与上一轮不连续（历史被裁剪 / 并发分支）时明确提示，而不是假装是同一串上下文。
 */
import { ChevronRight, Loader2, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  blockMatches,
  isDefaultFilter,
  MessageFilterBar,
  type BlockFilter,
} from "@/components/audit/audit-message-filters";
import { StatusBadge, Tag } from "@/components/audit/badges";
import { BytePair } from "@/components/audit/byte-pair";
import { MessageBlock } from "@/components/audit/message-block";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatBytes, formatDateTimeSecond, formatNumber } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import type {
  AuditBlock,
  AuditConversationRow,
  AuditSessionDetail,
  AuditThread,
  AuditThreadTurn,
} from "@/server/audit/types";

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
      {aside}
    </div>
  );
}

/** 本轮输入的拆分：开头的系统提示 / 上一轮回答属于「回放」，其余是本轮真正新说的。 */
function splitNews(blocks: AuditBlock[]): { replay: AuditBlock[]; fresh: AuditBlock[] } {
  const firstUser = blocks.findIndex((block) => block.role === "user");
  if (firstUser <= 0) return { replay: [], fresh: blocks };
  return { replay: blocks.slice(0, firstUser), fresh: blocks.slice(firstUser) };
}

function DeltaHint({ detail, turn }: { detail: AuditSessionDetail; turn: AuditThreadTurn }) {
  const delta = detail.delta;
  if (turn.prev === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        首轮请求 · 完整上下文 {detail.envelope.request.messages.length} 项
      </p>
    );
  }
  if (delta === undefined) {
    return <p className="text-[11px] text-muted-foreground">未能计算增量，展示完整上下文。</p>;
  }
  if (delta.reason !== undefined) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-1.5 text-[11px] text-muted-foreground">
        {delta.reason === "prev_missing"
          ? "上一轮请求正文已被清理（超出保留期或截断），这里展示完整上下文。"
          : "上一轮请求正文无法解析，这里展示完整上下文。"}
      </p>
    );
  }
  if (!delta.continuous) {
    return (
      <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] leading-5">
        与上一轮<b>不连续</b>：上一轮 {delta.priorMessages} 项里只有 {delta.commonPrefix} 项出现在本轮
        请求中。常见原因是上下文超限被裁剪、并发分支，或客户端换了会话键 —— 此处按完整上下文展示。
      </p>
    );
  }
  return (
    <p className="text-[11px] text-muted-foreground">
      接续上一轮 {delta.priorMessages} 项上下文 · 本轮新增{" "}
      <b className="text-foreground">{delta.news.length}</b> 项
    </p>
  );
}

function TurnBody({
  userId,
  turn,
  filter,
  highlight,
}: {
  userId: string;
  turn: AuditThreadTurn;
  filter: BlockFilter;
  /** 已 trim 的关键词，仅用于命中高亮。 */
  highlight: string;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);

  const params = new URLSearchParams({ date: turn.date, userId, fp: turn.fingerprint });
  if (turn.prev !== null) {
    params.set("prev", turn.prev.traceId);
    params.set("prevDate", turn.prev.date);
  }
  const api = useApi<AuditSessionDetail>(
    `/api/audit/sessions/${encodeURIComponent(turn.traceId)}?${params.toString()}`,
  );

  if (api.loading && api.data === undefined) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在读取本轮正文…
      </div>
    );
  }
  if (api.error !== undefined) {
    return (
      <div className="flex items-center gap-3 px-3 py-4 text-xs">
        <span className="text-muted-foreground">{api.error.message}</span>
        <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
          <RotateCw className="mr-1 size-3" />
          重试
        </Button>
      </div>
    );
  }
  if (api.data === undefined) return null;

  const { envelope } = api.data;
  const filtering = !isDefaultFilter(filter);
  const news = api.data.delta?.news ?? envelope.request.messages;
  const { replay, fresh } = splitNews(news);
  const outputs = envelope.response.outputs;
  // 过滤只隐藏不匹配的内容块，分节结构与计数照旧，避免"筛完不知道少了什么"
  const match = (block: AuditBlock): boolean => blockMatches(block, filter);
  const freshShown = filtering ? fresh.filter(match) : fresh;
  const outputsShown = filtering ? outputs.filter(match) : outputs;
  const replayShown = filtering ? replay.filter(match) : replay;
  const parseError = envelope.request.parseError ?? envelope.response.parseError;
  const usage = envelope.response.usage;

  return (
    <div className="flex flex-col gap-4 border-t px-3 py-3">
      <DeltaHint detail={api.data} turn={turn} />

      {parseError === undefined ? null : (
        <p className="rounded-lg border bg-warning/10 px-3 py-1.5 text-[11px]">
          正文可能不完整（{parseError}），可切到原始报文查看。
        </p>
      )}

      <div>
        <SectionTitle
          aside={
            <button
              type="button"
              className="text-[11px] font-normal text-primary hover:underline"
              onClick={() => setRawOpen((value) => !value)}
            >
              {rawOpen ? "看结构化" : "看原始报文"}
            </button>
          }
        >
          {rawOpen
            ? "原始报文"
            : filtering
              ? `本轮输入 · 命中 ${freshShown.length} / ${fresh.length} 项`
              : `本轮输入 · ${fresh.length} 项`}
        </SectionTitle>

        {rawOpen ? (
          <div className="flex flex-col gap-2">
            <pre className="max-h-60 overflow-auto rounded-lg border bg-muted/30 p-3 text-[11px] leading-5 whitespace-pre-wrap break-all">
              {api.data.raw.request === "" ? "（空）" : api.data.raw.request}
            </pre>
            {api.data.raw.requestTruncated ? (
              <p className="text-[11px] text-muted-foreground">请求原文超过预览上限，仅显示前一段。</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {replay.length === 0 ? null : (
              <>
                <button
                  type="button"
                  onClick={() => setReplayOpen((value) => !value)}
                  className="w-full rounded-lg border border-dashed px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/40"
                >
                  上下文回放 {replay.length} 项（系统提示 / 上一轮回答）
                  {filtering ? ` · 命中 ${replayShown.length}` : ""}
                  {replayOpen ? " · 点击收起" : " · 点击展开"}
                </button>
                {replayOpen
                  ? replayShown.map((block) => (
                      <MessageBlock key={`r-${block.seq}`} block={block} keyword={highlight} />
                    ))
                  : null}
              </>
            )}
            {freshShown.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                {filtering
                  ? "当前筛选条件下没有本轮输入。"
                  : "本轮没有新增输入（可能是重试或工具结果续接，见回放）。"}
              </p>
            ) : (
              freshShown.map((block) => (
                <MessageBlock key={`f-${block.seq}`} block={block} keyword={highlight} />
              ))
            )}
          </div>
        )}
      </div>

      <div>
        <SectionTitle aside={<span className="text-[11px] font-normal">{turn.stream ? "流式" : "JSON"}</span>}>
          {filtering ? `本轮响应 · 命中 ${outputsShown.length} / ${outputs.length} 项` : `本轮响应 · ${outputs.length} 项`}
        </SectionTitle>
        {envelope.response.error === undefined ? null : (
          <div className="mb-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-6">
            <span className="font-semibold text-destructive">
              {envelope.response.error.code ?? "error"}
            </span>
            <br />
            {envelope.response.error.message}
          </div>
        )}
        {outputsShown.length === 0 && envelope.response.error === undefined ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            {filtering ? "当前筛选条件下没有返回内容。" : "无返回内容（可能被截断或非对话接口）。"}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {outputsShown.map((block) => (
              <MessageBlock key={`o-${block.seq}`} block={block} keyword={highlight} />
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {envelope.response.finishReason === undefined ? null : (
            <span className="rounded-md border px-1.5 py-0.5">
              finish_reason {envelope.response.finishReason}
            </span>
          )}
          {usage?.promptTokens === undefined ? null : (
            <span className="rounded-md border px-1.5 py-0.5 tabular-nums">
              token {formatNumber(usage.promptTokens)} →{" "}
              {formatNumber(usage.completionTokens ?? 0)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnCard({
  userId,
  turn,
  open,
  onToggle,
  filter,
  highlight,
}: {
  userId: string;
  turn: AuditThreadTurn;
  open: boolean;
  onToggle: () => void;
  filter: BlockFilter;
  highlight: string;
}) {
  return (
    <div className={`rounded-xl border ${open ? "bg-card" : "bg-card/60"}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="w-8 shrink-0 text-[11px] tabular-nums text-muted-foreground">
          #{turn.index}
        </span>
        <span className="shrink-0 font-mono text-[11px]">{formatDateTimeSecond(turn.startedAtEpoch)}</span>
        <StatusBadge status={turn.status} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {turn.model === "" ? "—" : turn.model}
          {turn.requestTruncated || turn.responseTruncated ? " · 截断" : ""}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {turn.durationMs} ms
        </span>
        <BytePair
          request={formatBytes(turn.requestBytes)}
          response={formatBytes(turn.responseBytes)}
        />
      </button>
      {open ? <TurnBody userId={userId} turn={turn} filter={filter} highlight={highlight} /> : null}
    </div>
  );
}

export function AuditThreadDialog({
  userId,
  conversation,
  start,
  end,
  onClose,
}: {
  userId: string;
  conversation: AuditConversationRow | null;
  start: number;
  end: number;
  onClose: () => void;
}) {
  const sessionKey = conversation?.sessionKey;
  const [filter, setFilter] = useState<BlockFilter>({ role: "all", kind: "all", query: "" });
  const [keywordInput, setKeywordInput] = useState("");
  // 防抖：输入停顿 180ms 后再过滤，与详情抽屉一致，避免长会话逐键全量扫描
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter((current) => ({ ...current, query: keywordInput.trim().toLowerCase() }));
    }, 180);
    return () => clearTimeout(timer);
  }, [keywordInput]);
  const resetFilters = (): void => {
    setFilter({ role: "all", kind: "all", query: "" });
    setKeywordInput("");
  };
  // 全屏是视图偏好，切换会话时保持——习惯全屏看长报文的人不会想每次都退回去
  const [full, setFull] = useState(false);
  /**
   * 用户手动覆盖的开合状态；未覆盖时「最后一轮」默认展开。
   * 带着 `key` 存：抽屉不卸载，切换会话时旧状态必须自动失效，否则会串到新会话上。
   */
  const [overrideState, setOverrideState] = useState<{
    key: string;
    map: Record<number, boolean>;
  }>({ key: "", map: {} });
  const override = overrideState.key === (sessionKey ?? "") ? overrideState.map : {};
  const setOverride = (index: number, next: boolean): void => {
    setOverrideState((current) => {
      const base = current.key === (sessionKey ?? "") ? current.map : {};
      return { key: sessionKey ?? "", map: { ...base, [index]: next } };
    });
  };

  const url =
    sessionKey === undefined
      ? null
      : `/api/audit/conversations/${sessionKey}?userId=${encodeURIComponent(userId)}&start=${start}&end=${end}`;
  const api = useApi<AuditThread>(url);
  const turns = api.data?.turns ?? [];
  const lastIndex = turns.length === 0 ? 0 : (turns.at(-1)?.index ?? 0);

  return (
    <Dialog
      open={conversation !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          // 抽屉形态：右贴边全高；全屏时占满整个视口宽度并去掉左边框。
          // 两种形态都必须覆盖基类的 sm:max-w-lg，否则全屏会被压回 512px。
          "top-0 right-0 left-auto flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0",
          full ? "border-l-0 sm:max-w-none" : "border-l sm:max-w-4xl",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="min-w-0">
            <DialogTitle className="text-base">
              会话线程
              {conversation === null ? null : (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {conversation.requestCount} 轮
                </span>
              )}
            </DialogTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {conversation === null ? null : (
                <>
                  <span className="font-mono">{sessionKey ?? "—"}</span>
                  <span>·</span>
                  <span>指纹 {conversation.fingerprint}</span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {formatDateTimeSecond(conversation.firstEpoch)} →{" "}
                    {formatDateTimeSecond(conversation.lastEpoch)}
                  </span>
                  {conversation.failedCount > 0 ? (
                    <>
                      <span>·</span>
                      <Tag tone="danger">失败 {conversation.failedCount}</Tag>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
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
              className="size-7"
              onClick={onClose}
              aria-label="关闭"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="border-b px-5 py-1.5">
          <MessageFilterBar
            filter={filter}
            queryInput={keywordInput}
            onFilterChange={(patch) => setFilter((current) => ({ ...current, ...patch }))}
            onQueryInputChange={setKeywordInput}
            onReset={resetFilters}
            searchPlaceholder="在已展开的轮次中搜索"
          />
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {api.loading && api.data === undefined ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在定位会话轮次…
            </div>
          ) : api.error !== undefined ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-6 text-sm">
              <p className="text-muted-foreground">{api.error.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
                <RotateCw className="mr-1 size-3.5" />
                重试
              </Button>
            </div>
          ) : turns.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              所选区间内没有该会话的请求。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {api.data?.truncated === true ? (
                <p className="rounded-lg border border-dashed px-3 py-1.5 text-[11px] text-muted-foreground">
                  该会话共 {api.data?.total ?? 0} 轮，只展示最近 {turns.length} 轮（上限保护）。
                </p>
              ) : null}
              {turns.map((turn) => (
                <TurnCard
                  key={`${turn.date}-${turn.traceId}`}
                  userId={userId}
                  turn={turn}
                  open={override[turn.index] ?? turn.index === lastIndex}
                  filter={filter}
                  highlight={keywordInput.trim()}
                  onToggle={() =>
                    setOverride(turn.index, !(override[turn.index] ?? turn.index === lastIndex))
                  }
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
