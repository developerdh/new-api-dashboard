"use client";

/**
 * 「上期活跃 · 本期沉默」卡片：总览新增的独立卡片，不需要额外 tab 或二级入口。
 *
 * - 计数与「查看清单」共用一个受控 Dialog；卡片内直接预览上期请求数最高的前几位；
 * - 清单字段：用户名 + 最后活跃时间 + 上期请求数 + 详情链接；
 * - 详情链接**沿用全局筛选区间**（与总览保持一致；切到上期区间会让返回总览时区间被换掉）；
 * - 区间跟随全局 `start/end`，上期为等长紧邻前一周期，由 API 返回 `prevRange`。
 */
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateRange, formatDateTime, formatNumber } from "@/lib/format";
import { primaryUserLabel, secondaryUserLabel } from "@/lib/user-label";
import type { InactiveUserRow, InactiveUsersSnapshot } from "@/server/queries/inactive";

/** 卡片内预览条数（完整清单在弹层）。 */
const PREVIEW_LIMIT = 6;

export interface InactiveUsersCardProps {
  data?: InactiveUsersSnapshot;
  loading: boolean;
  error?: { message: string };
  onRetry: () => void;
  /** 由总览页按当前筛选区间 + 粒度拼出的用户详情链接。 */
  userHref: (row: InactiveUserRow) => string;
}

export function InactiveUsersCard({
  data,
  loading,
  error,
  onRetry,
  userHref,
}: InactiveUsersCardProps) {
  const [open, setOpen] = useState(false);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const prevRange = data?.prevRange;
  const prevLabel =
    prevRange === undefined ? "紧邻本期的等长周期" : formatDateRange(prevRange.start, prevRange.end);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Card className="gap-3 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold">上期活跃 · 本期沉默</h2>
            <p className="text-[11px] text-muted-foreground">
              上期 {prevLabel} 有消费记录，本期无消费；按 logs 消费流水判定
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={loading || total === 0}
              title="查看沉默用户清单"
              aria-label="查看沉默用户清单"
              className="flex items-baseline gap-1.5 rounded-md text-left transition-colors hover:text-primary disabled:cursor-default disabled:hover:text-foreground"
            >
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {loading ? "—" : formatNumber(total)}
              </span>
              <span className="text-xs text-muted-foreground">位</span>
            </button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
              disabled={loading || total === 0}
            >
              查看清单
            </Button>
          </div>
        </div>

        <div className="px-5">
          {error !== undefined ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm">
              <p className="text-muted-foreground">{error.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                重试
              </Button>
            </div>
          ) : loading ? (
            <div className="h-[92px] w-full rounded-lg skeleton-shimmer" aria-busy="true" />
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
              本期没有沉默用户（上期活跃用户在本期均有消费记录，或上期已超出日志保留期）
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {rows.slice(0, PREVIEW_LIMIT).map((row) => (
                <li key={row.userId} className="rounded-lg border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={userHref(row)}
                      className="truncate text-xs font-medium underline-offset-4 hover:text-primary hover:underline"
                    >
                      {primaryUserLabel(row)}
                    </Link>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatNumber(row.prevRequestCount)} 次
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
                    最后活跃 {formatDateTime(row.lastActiveAt)}
                    {secondaryUserLabel(row) === "" ? "" : ` · ${secondaryUserLabel(row)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>沉默用户清单</DialogTitle>
          <DialogDescription>
            上期 {prevLabel} 共 {formatNumber(data?.prevActiveUsers ?? 0)} 位活跃用户，其中{" "}
            {formatNumber(total)} 位本期无消费记录；详情沿用当前筛选区间（本期为空属预期）。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>最后活跃</TableHead>
                <TableHead className="text-right">上期请求数</TableHead>
                <TableHead className="text-right">详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span>{primaryUserLabel(row)}</span>
                      {secondaryUserLabel(row) === "" ? null : (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {secondaryUserLabel(row)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDateTime(row.lastActiveAt)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.prevRequestCount)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={userHref(row)}
                      className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                    >
                      查看 <ArrowUpRight className="size-3" aria-hidden="true" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {data?.truncated === true ? (
          <p className="text-[11px] text-muted-foreground">
            仅展示前 {rows.length} 位（共 {formatNumber(total)} 位），可缩小筛选区间或调大 limit。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
