"use client";

/**
 * 用户详情页「会话」区块：提示词与返回结果的列表入口。
 *
 * - 时间范围继承 URL（与页内其它卡片一致），分页用「加大 limit」实现：
 *   服务端按天倒序扫描，cursor 只用于避免 offset 漂移，界面层不需要感知；
 * - 无数据 / 未配置 / 指纹不可反查分别有独立文案，避免把「能力未启用」显示成错误；
 * - 点击行打开右侧抽屉（`audit-detail-dialog.tsx`）。
 */
import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { StatusBadge, Tag } from "@/components/audit/badges";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTimeSecond } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { AuditSessionList, AuditSessionRow } from "@/server/audit/types";

import { AuditDetailDialog } from "./audit-detail-dialog";

const PAGE_STEP = 20;
const PAGE_MAX = 200;

type StreamFilter = "all" | "stream" | "json";

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
}: {
  userId: string;
  start: number;
  end: number;
}) {
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [limit, setLimit] = useState(PAGE_STEP);
  const [selected, setSelected] = useState<AuditSessionRow | null>(null);

  const params = new URLSearchParams({
    userId,
    start: String(start),
    end: String(end),
    limit: String(limit),
  });
  if (streamFilter !== "all") params.set("stream", streamFilter === "stream" ? "true" : "false");
  if (onlyErrors) params.set("failed", "true");

  const api = useApi<AuditSessionList>(`/api/audit/sessions?${params.toString()}`);
  const data = api.data;
  const sessions = data?.sessions ?? [];
  const canLoadMore = data?.nextCursor !== null && data?.nextCursor !== undefined;
  const atCap = limit >= PAGE_MAX;

  const resetTo = (next: () => void): void => {
    next();
    setLimit(PAGE_STEP);
  };

  return (
    <Card className="gap-3 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold">会话</h2>
          <span className="text-xs text-muted-foreground">提示词与返回结果 · 只读审计文件</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex items-center gap-1" role="group" aria-label="请求形态">
            {(
              [
                ["all", "全部形态"],
                ["stream", "流式"],
                ["json", "非流式"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={streamFilter === key ? "secondary" : "ghost"}
                aria-pressed={streamFilter === key}
                onClick={() => resetTo(() => setStreamFilter(key))}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant={onlyErrors ? "secondary" : "ghost"}
            aria-pressed={onlyErrors}
            onClick={() => resetTo(() => setOnlyErrors((value) => !value))}
          >
            仅错误
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground"
            onClick={api.refresh}
            aria-label="刷新会话列表"
            title="刷新"
          >
            <Loader2 className={api.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        </div>
      </div>

      <div className="px-5">
        {api.error !== undefined ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-sm">
            <p className="text-muted-foreground">{api.error.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={api.refresh}>
              重试
            </Button>
          </div>
        ) : api.loading && data === undefined ? (
          <div className="h-40 w-full rounded-lg skeleton-shimmer" aria-busy="true" />
        ) : data === undefined ? null : data.available === false ? (
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
        ) : sessions.length === 0 ? (
          <Notice>所选区间内无采集记录。</Notice>
        ) : (
          <>
            <div className="overflow-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>形态</TableHead>
                    <TableHead className="text-right">耗时 / 首字</TableHead>
                    <TableHead className="text-right">请求 → 响应</TableHead>
                    <TableHead className="w-6" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((row) => (
                    <TableRow
                      key={`${row.date}-${row.traceId}-${row.fp}`}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => setSelected(row)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(row);
                        }
                      }}
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {formatDateTimeSecond(row.startedAtEpoch)}
                      </TableCell>
                      <TableCell className="max-w-40 truncate">{row.model || "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Tag tone="info">{row.stream ? "流式" : "非流式"}</Tag>
                          {row.requestTruncated ? <Tag tone="warning">请求截断</Tag> : null}
                          {row.responseTruncated ? <Tag tone="warning">响应截断</Tag> : null}
                          {row.gzip.request || row.gzip.response ? <Tag>gz</Tag> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.durationMs} ms
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          / {row.stream ? `${row.firstTokenMs} ms` : "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBytes(row.requestBytes)} → {formatBytes(row.responseBytes)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">›</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                已加载 {sessions.length} 条
                {data.unmatched === undefined
                  ? ""
                  : ` · 另有 ${data.unmatched} 条无法归属到该用户（无效或已失效 key）`}
              </span>
              {canLoadMore ? (
                atCap ? (
                  <span>已达单次上限 {PAGE_MAX} 条，请缩小时间范围</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setLimit((value) => Math.min(PAGE_MAX, value + PAGE_STEP))}
                  >
                    加载更多
                  </Button>
                )
              ) : (
                <span>已是全部</span>
              )}
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
    </Card>
  );
}
