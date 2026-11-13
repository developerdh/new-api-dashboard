"use client";

/**
 * 用户详情页「会话」区块：提示词与返回结果的列表入口。
 *
 * 两种粒度（`group`）：
 * - `session`（默认）：一行一会话。采集侧从协议里取会话键（Chat/Responses 的
 *   `prompt_cache_key`、Claude `metadata.user_id` 里的 `session_id`），只存哈希，
 *   同一会话的几十轮压成一行；没有会话键的请求（Gemini、老客户端）各自成行并标「未聚合」。
 * - `request`：一行一请求，排障要看单次调用时用。
 *
 * 分页是**翻页**而不是累加：每页 20 条，可切 50/100；要连续往回看用右上角
 * 「在新页面打开」，那一页才是累加加载。
 *
 * 按日期过滤：审计索引本就按天存，选中某天后服务端只扫那一天的索引文件，
 * 既快又能让「会话数 / 页码」变得准确（聚合需要全量分组，窗口越大越贵）。
 */
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { SessionFilters, DEFAULT_SESSION_VIEW, type SessionView } from "@/components/audit/session-filters";
import {
  ConversationTable,
  RequestTable,
  UngroupedHint,
} from "@/components/audit/session-table";
import { AuditDetailDialog } from "@/components/audit/audit-detail-dialog";
import { AuditThreadDialog } from "@/components/audit/audit-thread-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { dayRangeOf, listDaysInRange } from "@/lib/time-range";
import { useApi } from "@/lib/use-api";
import type {
  AuditConversationRow,
  AuditSessionList,
  AuditSessionRow,
} from "@/server/audit/types";

/** 每页条数选项：与 `AUDIT_MAX_PAGE_SIZE` 对齐。 */
const PAGE_SIZES = [20, 50, 100] as const;

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function AuditSessions({
  userId,
  start,
  end,
  displayName = "",
  username = "",
}: {
  userId: string;
  start: number;
  end: number;
  /** 透传到独立页面做标题（用户详情已解析出身份，不必让子页面再查一次） */
  displayName?: string;
  username?: string;
}) {
  const [view, setView] = useState<SessionView>(DEFAULT_SESSION_VIEW);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [selected, setSelected] = useState<AuditSessionRow | null>(null);
  const [thread, setThread] = useState<AuditConversationRow | null>(null);

  const dates = useMemo(() => listDaysInRange(start, end), [start, end]);
  // 选中的日期落在区间外（刚改过全局范围）时自动退回「全部」，不必额外同步状态
  const activeDate = view.date !== null && dates.includes(view.date) ? view.date : null;
  const window = (activeDate === null ? null : dayRangeOf(activeDate)) ?? { start, end };

  const params = new URLSearchParams({
    userId,
    start: String(start),
    end: String(end),
    group: view.group,
    limit: String(pageSize),
    page: String(page),
  });
  if (activeDate !== null) params.set("date", activeDate);
  if (view.stream !== "all") params.set("stream", view.stream === "stream" ? "true" : "false");
  if (view.failedOnly) params.set("failed", "true");

  const api = useApi<AuditSessionList>(`/api/audit/sessions?${params.toString()}`);
  const data = api.data;
  // 视图切换的瞬间可能取到上一模式的响应：口径不一致时先按加载态处理
  const matched = data !== undefined && data.grouped === (view.group === "session");
  const sessions = matched ? data.sessions : [];
  const conversations = matched ? (data.conversations ?? []) : [];
  const rows = view.group === "session" ? conversations.length : sessions.length;
  const totalPages = matched ? data.totalPages : null;
  const total = matched ? data.total : null;
  const partial = matched && data.partial === true;

  const changeView = (patch: Partial<SessionView>): void => {
    setView((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const detailParams = new URLSearchParams({
    start: String(window.start),
    end: String(window.end),
    group: view.group,
  });
  if (activeDate !== null) detailParams.set("date", activeDate);
  if (displayName !== "") detailParams.set("name", displayName);
  if (username !== "") detailParams.set("username", username);
  const detailHref = `/users/${encodeURIComponent(userId)}/sessions?${detailParams.toString()}`;

  return (
    <Card className="gap-3 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold">会话</h2>
          <span className="text-xs text-muted-foreground">提示词与返回结果 · 只读审计文件</span>
        </div>
        <SessionFilters
          view={{ ...view, date: activeDate }}
          onChange={changeView}
          dates={dates}
          refreshing={api.loading}
          onRefresh={api.refresh}
          action={
            <Button asChild size="sm" variant="ghost" className="shrink-0 gap-1 whitespace-nowrap">
              <Link
                href={detailHref}
                target="_blank"
                rel="noopener noreferrer"
                title="在新窗口打开完整列表（累加加载）"
              >
                完整列表
                <ExternalLink className="size-3.5" />
              </Link>
            </Button>
          }
        />
      </div>

      <div className="px-5">
        {api.error !== undefined ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-sm">
            <p className="text-muted-foreground">{api.error.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
              重试
            </Button>
          </div>
        ) : !matched ? (
          <div className="h-40 w-full rounded-lg skeleton-shimmer" aria-busy="true" />
        ) : data.available === false ? (
          <Notice>
            审计正文未启用（未配置 <span className="font-mono">AUDIT_DIR</span>
            ）。统计功能不受影响；配置并只读挂载采集目录后即可查看会话。
          </Notice>
        ) : data.lookupError !== undefined ? (
          <Notice>
            无法反查 token 指纹（{data.lookupError === "permission_denied" ? "缺少 tokens 表读权限" : "数据库暂不可用"}
            ），因此无法定位该用户的采集记录。
          </Notice>
        ) : data.fingerprintCount === 0 ? (
          <Notice>该用户没有可用的 token 指纹，无法定位采集记录。</Notice>
        ) : rows === 0 ? (
          <Notice>
            {activeDate === null ? "所选区间内无采集记录。" : `${activeDate} 无采集记录。`}
            {page > 1 ? (
              <span className="ml-1">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setPage(1)}
                >
                  回到第一页
                </button>
              </span>
            ) : null}
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

            {/* 100 条/页时整张卡会长到几屏高，限高滚动 + 粘性表头，页脚才够得着 */}
            {/* 内层 table-container 自带 overflow-x-auto，会成为 sticky 的滚动容器（且它不纵向滚动），
                这里改成 visible，让限高滚动与粘性表头都落在这一层 */}
            <div className="max-h-[70vh] overflow-auto rounded-xl border [&>[data-slot=table-container]]:overflow-visible">
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
                {total === null
                  ? `第 ${page} 页 · 每页 ${pageSize} 条`
                  : `共 ${total} 个会话 · 第 ${page} / ${totalPages ?? 1} 页`}
                {data.unmatched === undefined
                  ? ""
                  : ` · 另有 ${data.unmatched} 条无法归属到该用户（无效或已失效 key）`}
              </span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1" role="group" aria-label="每页条数">
                  <span className="mr-0.5">每页</span>
                  {PAGE_SIZES.map((size) => (
                    <Button
                      key={size}
                      type="button"
                      size="sm"
                      variant={pageSize === size ? "secondary" : "ghost"}
                      aria-pressed={pageSize === size}
                      onClick={() => {
                        setPageSize(size);
                        setPage(1);
                      }}
                    >
                      {size}
                    </Button>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={totalPages === null ? rows < pageSize : page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

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
    </Card>
  );
}
