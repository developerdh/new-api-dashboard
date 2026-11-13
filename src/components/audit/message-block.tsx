"use client";

/**
 * 审计块的统一渲染：text / tool_call / tool_result / image / other。
 *
 * 约定：
 * - 块序号 `seq` 来自信封（全局递增），排障时与「原始报文」页签逐条对照；
 * - 工具参数保持原始 JSON 字符串，不做美化——参数被截断时 `JSON.parse` 会二次失败；
 * - 图片只展示元信息，正文（base64）不落纸、不渲染。
 */
import { formatBytes } from "@/lib/format";
import type { AuditBlock } from "@/server/audit/types";
import type { ReactNode } from "react";

const KIND_LABEL: Record<AuditBlock["kind"], string> = {
  text: "text",
  tool_call: "tool_call",
  tool_result: "tool_result",
  image: "image",
  other: "other",
};

function Badge({ children, tone }: { children: ReactNode; tone: "neutral" | "info" }) {
  const cls =
    tone === "info"
      ? "border-transparent bg-info/15 text-info"
      : "border-transparent bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] ${cls}`}>
      {children}
    </span>
  );
}

export function MessageBlock({ block }: { block: AuditBlock }) {
  const isTool = block.kind === "tool_call" || block.kind === "tool_result";

  return (
    <div className={`flex gap-3 rounded-xl border px-3 py-2.5 ${isTool ? "bg-muted/40" : "bg-card"}`}>
      <div className="w-16 shrink-0 text-[11px] leading-5 text-muted-foreground">
        <div className="font-semibold text-foreground">{block.role}</div>
        <div className="font-mono">#{block.seq}</div>
      </div>

      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        {block.kind === "text" || block.kind === "other" ? (
          <p className="whitespace-pre-wrap break-words">{block.text}</p>
        ) : null}

        {block.kind === "tool_call" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{KIND_LABEL.tool_call}</Badge>
              <span className="font-mono text-xs">{block.tool?.name ?? "unknown"}</span>
              {block.tool?.callId === undefined ? null : (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {block.tool.callId}
                </span>
              )}
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 text-[11px] leading-5 whitespace-pre-wrap break-all">
              {block.tool?.arguments === "" ? "（无参数）" : block.tool?.arguments}
            </pre>
          </div>
        ) : null}

        {block.kind === "tool_result" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{KIND_LABEL.tool_result}</Badge>
              {block.tool?.callId === undefined ? null : (
                <span className="font-mono text-[11px] text-muted-foreground">
                  call_id {block.tool.callId}
                </span>
              )}
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 text-[11px] leading-5 whitespace-pre-wrap break-all">
              {block.text}
            </pre>
          </div>
        ) : null}

        {block.kind === "image" ? (
          <div className="flex flex-col gap-2">
            <Badge tone="neutral">{KIND_LABEL.image}</Badge>
            <div className="rounded-lg border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
              {block.image?.mime ?? "unknown"} · {formatBytes(block.image?.bytes ?? 0)}
              {block.image?.sha256 === undefined || block.image.sha256 === ""
                ? null
                : ` · sha256 ${block.image.sha256}…`}
              <br />
              正文未落盘，仅保留元信息
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
