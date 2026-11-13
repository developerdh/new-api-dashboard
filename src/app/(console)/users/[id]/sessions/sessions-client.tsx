"use client";

/**
 * 会话独立页：新窗口打开，累加加载，整页不产生窗口滚动条。
 *
 * 布局约定：
 * - 去掉全局时间选择器与返回按钮：区间由入口 URL 带入，页面只展示「标题 + 会话列表」；
 * - 根容器吃掉剩余视口高度，筛选条 + 表头固定在表格滚动区之外，切换粒度/日期不用往回滚；
 * - **只有表格区滚动**（`flex-1 min-h-0 overflow-auto`），表头 `sticky top-0` 吸顶；
 * - 页脚（已加载 / 每次条数 / 加载更多）也在滚动区之外，始终够得着。
 *
 * 累加实现：真正的**分页追加**——`limit` 固定为步长（20/50，不超过服务端单页上限 100），
 * 「加载更多」把 `page` 加一，响应到达后按 `page` 合并进本地列表（page=1 替换、page>1 去重追加）。
 * 之前「把 limit 一路加到 131」的实现会撞上服务端单页上限，属于实现错误。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { AuditDetailDialog } from "@/components/audit/audit-detail-dialog";
import { AuditThreadDialog } from "@/components/audit/audit-thread-dialog";
import {
  DEFAULT_SESSION_VIEW,
  SessionFilters,
  type SessionView,
} from "@/components/audit/session-filters";
import {
  ConversationTable,
  RequestTable,
  UngroupedHint,
} from "@/components/audit/session-table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { dayRangeOf, listDaysInRange, resolveRangeFromParams } from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type {
  AuditConversationRow,
  AuditSessionList,
  AuditSessionRow,
} from "@/server/audit/types";

/** 每次加载的步长（可切）；不得超过服务端 `AUDIT_MAX_PAGE_SIZE`。 */
const STEPS = [20, 50] as const;

type Row = AuditConversationRow | AuditSessionRow;

function keyOf(grouped: boolean, row: Row): string {
  if (!grouped) {
    const r = row as AuditSessionRow;
    return `${r.date}-${r.traceId}-${r.fp}`;
  }
  const key = (row as AuditConversationRow).sessionKey;
  return key === undefined ? `single:${(row as AuditConversationRow).last.traceId}` : key;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="w-full rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function SessionsClient({ userId }: { userId: string }) {
  const searchParams = useSearchParams();
  const range = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const displayName = searchParams.get("name") ?? "";
  const username = searchParams.get("username") ?? "";

  const [view, setView] = useState<SessionView>(() => {
    const group = searchParams.get("group");
    const date = searchParams.get("date");
    return {
      ...DEFAULT_SESSION_VIEW,
      group: group === "request" ? "request" : "session",
      ...(date === null ? {} : { date }),
    };
  });
  const [step, setStep] = useState<number>(STEPS[0]);
  const [page, setPage] = useState(1);
  /** 累积的行：page=1 替换、page>1 去重追加。 */
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<AuditSessionRow | null>(null);
  const [thread, setThread] = useState<AuditConversationRow | null>(null);

  const dates = useMemo(() => listDaysInRange(range.start, range.end), [range.start, range.end]);
  const activeDate = view.date !== null && dates.includes(view.date) ? view.date : null;
  const window = (activeDate === null ? null : dayRangeOf(activeDate)) ?? range;

  const params = new URLSearchParams({
    userId,
    start: String(range.start),
    end: String(range.end),
    group: view.group,
    limit: String(step),
    page: String(page),
  });
  if (activeDate !== null) params.set("date", activeDate);
  if (view.stream !== "all") params.set("stream", view.stream === "stream" ? "true" : "false");
  if (view.failedOnly) params.set("failed", "true");

  const api = useApi<AuditSessionList>(`/api/audit/sessions?${params.toString()}`);

  // 响应合并：page=1 替换、page>1 追加。分组与否、页码、每页条数都在响应里，
  // 合并逻辑只依赖 api.data，避免与视图状态产生时序耦合。
  useEffect(() => {
    const d = api.data;
    if (d === undefined || d.available !== true) return;
    const incoming: Row[] = d.grouped ? (d.conversations ?? []) : d.sessions;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部响应（URL 数据）→ 本地累积列表
    setRows((current) => {
      if (d.page <= 1) return incoming;
      const seen = new Set(current.map((row) => keyOf(d.grouped, row)));
      const merged = [...current];
      for (const row of incoming) {
        const key = keyOf(d.grouped, row);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(row);
        }
      }
      return merged;
    });
  }, [api.data]);

  const data = api.data;
  const matched = data !== undefined && data.grouped === (view.group === "session");
  const total = matched ? data.total : null;
  const partial = matched && data.partial === true;
  const grouped = view.group === "session";
  const loaded = rows.length;
  // 末次响应是否满页：满页才可能还有下一页（total 不可知的请求视图用这个判断）
  const lastPageFull =
    matched &&
    (data.grouped ? (data.conversations ?? []).length : data.sessions.length) === data.pageSize;
  const canLoadMore = total === null ? lastPageFull : loaded < total;

  const reset = (): void => {
    setRows([]);
    setPage(1);
  };
  const changeView = (patch: Partial<SessionView>): void => {
    setView((current) => ({ ...current, ...patch }));
    reset();
  };

  /** 标题展示「昵称 用户名」；都没有时回退到编号（URL 没带身份参数的直达场景）。 */
  const title = [displayName, username].filter(Boolean).join(" ") || `用户 #${userId}`;
  const ungrouped = rows.filter((row) => keyOf(grouped, row).startsWith("single:")).length;

  const conversationRows = grouped ? (rows as AuditConversationRow[]) : [];
  const sessionRows = grouped ? [] : (rows as AuditSessionRow[]);

  return (
    <div className="flex h-[calc(100dvh-var(--app-header-height)-3rem)] min-h-[360px] flex-col gap-3 overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">会话记录</h1>
        <span className="text-sm text-muted-foreground">{title}</span>
      </header>

      <Card className="flex min-h-0 flex-1 flex-col gap-0 py-4">
        {/* 筛选条在滚动区之外：表格滚到哪儿都能直接切粒度 / 日期 / 错误过滤 */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pb-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <span className="text-sm font-semibold text-foreground">
              {grouped ? "会话列表" : "请求列表"}
            </span>
            <span>
              {activeDate === null ? "所选区间内" : activeDate}
              {total === null ? "" : ` · 共 ${total} 个会话`}
            </span>
          </div>
          <SessionFilters
            view={{ ...view, date: activeDate }}
            onChange={changeView}
            dates={dates}
            refreshing={api.loading}
            onRefresh={() => {
              reset();
              api.refresh();
            }}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5">
          {api.error !== undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-sm">
                <p className="text-muted-foreground">{api.error.message}</p>
                <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
                  重试
                </Button>
              </div>
            </div>
          ) : !matched ? (
            <div className="h-full w-full rounded-lg skeleton-shimmer" aria-busy="true" />
          ) : data.available === false ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Notice>
                审计正文未启用（未配置 <span className="font-mono">AUDIT_DIR</span>
                ），配置并只读挂载采集目录后即可查看。
              </Notice>
            </div>
          ) : data.lookupError !== undefined ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Notice>
                无法反查 token 指纹（
                {data.lookupError === "permission_denied" ? "缺少 tokens 表读权限" : "数据库暂不可用"}
                ），因此无法定位该用户的采集记录。
              </Notice>
            </div>
          ) : data.fingerprintCount === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Notice>该用户没有可用的 token 指纹，无法定位采集记录。</Notice>
            </div>
          ) : loaded === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Notice>
                {activeDate === null ? "所选区间内无采集记录。" : `${activeDate} 无采集记录。`}
              </Notice>
            </div>
          ) : (
            <>
              {partial ? (
                <p className="mb-2 shrink-0 rounded-lg border border-dashed border-warning/50 bg-warning/10 px-3 py-1.5 text-[11px]">
                  所选范围内请求过多，会话统计只覆盖了最近一部分（总数可能偏少）。建议用「按日期」收窄。
                </p>
              ) : null}

              <UngroupedHint count={ungrouped} />

              {/* 唯一的滚动区；内层 table-container 让位给这里，粘性表头才会生效 */}
              <div className="min-h-0 flex-1 overflow-auto rounded-xl border [&>[data-slot=table-container]]:overflow-visible">
                {grouped ? (
                  <ConversationTable
                    rows={conversationRows}
                    onOpen={(row) => {
                      if (row.sessionKey === undefined) setSelected(row.last);
                      else setThread(row);
                    }}
                  />
                ) : (
                  <RequestTable rows={sessionRows} onOpen={setSelected} />
                )}
              </div>

              <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  已加载 {loaded}
                  {total === null ? " 条请求" : ` / ${total} 个会话`}
                  {data.unmatched === undefined
                    ? ""
                    : ` · 另有 ${data.unmatched} 条无法归属到该用户`}
                </span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1" role="group" aria-label="每次加载条数">
                    <span className="mr-0.5">每次</span>
                    {STEPS.map((size) => (
                      <Button
                        key={size}
                        type="button"
                        size="sm"
                        variant={step === size ? "secondary" : "ghost"}
                        aria-pressed={step === size}
                        onClick={() => {
                          setStep(size);
                          reset();
                        }}
                      >
                        {size}
                      </Button>
                    ))}
                  </div>
                  {api.loading && page > 1 ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      加载中…
                    </span>
                  ) : canLoadMore ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((value) => value + 1)}
                    >
                      加载更多
                    </Button>
                  ) : (
                    <span>已是全部</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </Card>

      <AuditDetailDialog
        userId={userId}
        row={selected}
        onClose={() => {
          setSelected(null);
        }}
      />

      <AuditThreadDialog
        userId={userId}
        conversation={thread}
        start={window.start}
        end={window.end}
        onClose={() => {
          setThread(null);
        }}
      />
    </div>
  );
}
