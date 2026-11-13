"use client";

/**
 * 会话独立页：把用户详情里的卡片放大成一整页，改用**累加加载**。
 *
 * 为什么不在这里也做翻页：整页的高度容得下连续滚动，排查时经常要「往回看一段」
 * 而不是「跳到第 7 页」——累加更贴近这个动作；卡片那边空间小、又要保持页面骨干
 * 不被撑长，所以用翻页。两处共用 `SessionFilters` / `SessionTable`，口径不会不一致。
 *
 * 实现取巧但等价：不做客户端 append，而是把 `limit` 从 20 递增（`page` 恒为 1），
 * 服务端每次返回「前 N 条」，天然去重、不会因新写入而错位。
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

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
import { TimeRangePicker } from "@/components/layout/time-range-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { dayRangeOf, listDaysInRange, parseGranularity, resolveRangeFromParams } from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type {
  AuditConversationRow,
  AuditSessionList,
  AuditSessionRow,
} from "@/server/audit/types";

/** 每次加载的步长（可切）。 */
const STEPS = [20, 50] as const;
/** 累加上限：再多就该用日期/条件收窄，而不是一路滚到底。 */
const MAX_ROWS = 500;

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function SessionsClient({ userId }: { userId: string }) {
  const searchParams = useSearchParams();
  const range = resolveRangeFromParams(searchParams.get("start"), searchParams.get("end"));
  const granularity = parseGranularity(searchParams.get("granularity"));
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
  const [limit, setLimit] = useState<number>(STEPS[0]);
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
    limit: String(limit),
    page: "1",
  });
  if (activeDate !== null) params.set("date", activeDate);
  if (view.stream !== "all") params.set("stream", view.stream === "stream" ? "true" : "false");
  if (view.failedOnly) params.set("failed", "true");

  const api = useApi<AuditSessionList>(`/api/audit/sessions?${params.toString()}`);
  const data = api.data;
  const matched = data !== undefined && data.grouped === (view.group === "session");
  const sessions = matched ? data.sessions : [];
  const conversations = matched ? (data.conversations ?? []) : [];
  const loaded = view.group === "session" ? conversations.length : sessions.length;
  const total = matched ? data.total : null;
  const partial = matched && data.partial === true;
  const atCap = limit >= MAX_ROWS;

  const changeView = (patch: Partial<SessionView>): void => {
    setView((current) => ({ ...current, ...patch }));
    setLimit(step);
  };

  const backParams = new URLSearchParams({
    start: String(range.start),
    end: String(range.end),
  });
  if (granularity !== "day") backParams.set("granularity", granularity);
  if (displayName !== "") backParams.set("name", displayName);
  if (username !== "") backParams.set("username", username);

  const title = displayName !== "" ? displayName : username !== "" ? username : `用户 #${userId}`;
  const canLoadMore =
    !atCap && (total === null ? loaded >= limit : loaded < total);

  return (
    <main className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">会话记录</h1>
            <span className="text-sm text-muted-foreground">{title}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            用户 ID <span className="font-mono">{userId}</span> · 提示词与返回结果 · 只读审计文件
          </p>
        </div>
        <Button asChild size="sm">
          <Link href={`/users/${encodeURIComponent(userId)}?${backParams.toString()}`}>
            返回用户详情
          </Link>
        </Button>
      </header>

      <TimeRangePicker />

      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5">
          <h2 className="text-sm font-semibold">
            {view.group === "session" ? "会话列表" : "请求列表"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {activeDate === null ? "所选区间内" : activeDate}
              {total === null ? "" : ` · 共 ${total} 个会话`}
            </span>
          </h2>
          <SessionFilters
            view={{ ...view, date: activeDate }}
            onChange={changeView}
            dates={dates}
            refreshing={api.loading}
            onRefresh={api.refresh}
          />
        </div>

        <div className="px-5">
          {api.error !== undefined ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-sm">
              <p className="text-muted-foreground">{api.error.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
                重试
              </Button>
            </div>
          ) : !matched ? (
            <div className="h-72 w-full rounded-lg skeleton-shimmer" aria-busy="true" />
          ) : data.available === false ? (
            <Notice>
              审计正文未启用（未配置 <span className="font-mono">AUDIT_DIR</span>
              ），配置并只读挂载采集目录后即可查看。
            </Notice>
          ) : data.lookupError !== undefined ? (
            <Notice>
              无法反查 token 指纹（
              {data.lookupError === "permission_denied" ? "缺少 tokens 表读权限" : "数据库暂不可用"}
              ），因此无法定位该用户的采集记录。
            </Notice>
          ) : data.fingerprintCount === 0 ? (
            <Notice>该用户没有可用的 token 指纹，无法定位采集记录。</Notice>
          ) : loaded === 0 ? (
            <Notice>
              {activeDate === null ? "所选区间内无采集记录。" : `${activeDate} 无采集记录。`}
            </Notice>
          ) : (
            <>
              {partial ? (
                <p className="mb-2 rounded-lg border border-dashed border-warning/50 bg-warning/10 px-3 py-1.5 text-[11px]">
                  所选范围内请求过多，会话统计只覆盖了最近一部分（总数可能偏少）。建议用「按日期」收窄。
                </p>
              ) : null}

              <UngroupedHint
                count={
                  view.group === "session"
                    ? conversations.filter((row) => row.sessionKey === undefined).length
                    : sessions.filter((row) => row.sessionKey === undefined).length
                }
              />

              {/* 累加最多 500 条：限高 + 粘性表头，否则整页会被一张表撑开 */}
              <div className="max-h-[75vh] overflow-auto rounded-xl border [&>[data-slot=table-container]]:overflow-visible">
                {view.group === "session" ? (
                  <ConversationTable
                    rows={conversations}
                    onOpen={(row) => {
                      if (row.sessionKey === undefined) setSelected(row.last);
                      else setThread(row);
                    }}
                  />
                ) : (
                  <RequestTable rows={sessions} onOpen={setSelected} />
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
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
                          setLimit(size);
                        }}
                      >
                        {size}
                      </Button>
                    ))}
                  </div>
                  {canLoadMore ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setLimit((value) => Math.min(MAX_ROWS, value + step))}
                    >
                      加载更多
                    </Button>
                  ) : atCap ? (
                    <span>已达 {MAX_ROWS} 条上限，请按日期或条件收窄</span>
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
    </main>
  );
}
