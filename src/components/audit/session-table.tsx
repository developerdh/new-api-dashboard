"use client";

/**
 * 会话表格（纯展示）：卡片内翻页与独立页面共用同一份列定义，避免两处漂移。
 *
 * 两种粒度列的差别不是"好看"，而是回答问题不同：
 * - `session`：这个会话有几轮、跨多久、总共多大 —— 排查"是不是同一个会话在反复调"；
 * - `request`：这一次调用的耗时/首字/大小 —— 排查单次异常。
 */
import { StatusBadge, Tag } from "@/components/audit/badges";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTimeSecond, formatDuration } from "@/lib/format";
import type { AuditConversationRow, AuditSessionRow } from "@/server/audit/types";

/**
 * 「未聚合」不再逐行挂标签：审计数据里缺会话键的请求往往占大多数，
 * 每行重复一遍既吵又会把轮次数字挤到换行。改为顶部一行说明 + 「会话键」列用 `—` 标识。
 */
export function UngroupedHint({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="mb-2 text-[11px] text-muted-foreground">
      其中 {count} 条请求没有会话标识，<span className="font-medium text-foreground">未参与聚合</span>
      （会话键列为 —），按单次请求各自成行。
    </p>
  );
}

/** 会话键短码：够用来判断「这几行是不是同一个会话」，又不占列宽。 */
function SessionKeyCell({ value }: { value: string | undefined }) {
  if (value === undefined) {
    return (
      <span
        className="text-muted-foreground"
        title="未聚合：该请求没有会话标识，按单请求展示"
      >
        —
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-muted-foreground" title={`会话键哈希 ${value}`}>
      {value.slice(0, 8)}
    </span>
  );
}

export function ConversationTable({
  rows,
  onOpen,
}: {
  rows: AuditConversationRow[];
  onOpen: (row: AuditConversationRow) => void;
}) {
  return (
    <Table className="border-separate border-spacing-0">
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead>最近一次</TableHead>
          <TableHead className="text-right">轮次</TableHead>
          <TableHead title="采集侧从协议取到的会话键哈希（只存哈希）；— 表示无会话标识，未参与聚合">
            会话键
          </TableHead>
          <TableHead>模型</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">起止跨度</TableHead>
          <TableHead className="text-right">请求 → 响应</TableHead>
          <TableHead className="w-6" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.sessionKey ?? `${row.last.date}-${row.last.traceId}`}
            className="cursor-pointer"
            tabIndex={0}
            onClick={() => onOpen(row)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(row);
              }
            }}
          >
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {formatDateTimeSecond(row.lastEpoch)}
            </TableCell>
            <TableCell className="text-right tabular-nums whitespace-nowrap">
              <span className={row.requestCount > 1 ? "font-semibold" : ""}>{row.requestCount}</span>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <SessionKeyCell value={row.sessionKey} />
            </TableCell>
            <TableCell className="max-w-36 truncate">
              {row.models.length === 0 ? "—" : row.models.join("、")}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge status={row.last.status} />
                {row.failedCount > 0 ? <Tag tone="danger">失败 {row.failedCount}</Tag> : null}
                {row.truncatedCount > 0 ? <Tag tone="warning">截断</Tag> : null}
              </div>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
              {row.requestCount > 1 ? formatDuration(row.lastEpoch - row.firstEpoch) : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatBytes(row.totalRequestBytes)} → {formatBytes(row.totalResponseBytes)}
            </TableCell>
            <TableCell className="text-muted-foreground">›</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RequestTable({
  rows,
  onOpen,
}: {
  rows: AuditSessionRow[];
  onOpen: (row: AuditSessionRow) => void;
}) {
  return (
    <Table className="border-separate border-spacing-0">
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>模型</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>形态</TableHead>
          <TableHead title="采集侧从协议取到的会话键哈希（只存哈希）；— 表示无会话标识，未参与聚合">
            会话键
          </TableHead>
          <TableHead className="text-right">耗时 / 首字</TableHead>
          <TableHead className="text-right">请求 → 响应</TableHead>
          <TableHead className="w-6" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={`${row.date}-${row.traceId}-${row.fp}`}
            className="cursor-pointer"
            tabIndex={0}
            onClick={() => onOpen(row)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(row);
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
            <TableCell className="whitespace-nowrap">
              <SessionKeyCell value={row.sessionKey} />
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
  );
}
