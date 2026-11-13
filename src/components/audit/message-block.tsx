"use client";

/**
 * 审计块渲染：角色区分 + 长内容默认折叠。
 *
 * - 角色色带：system 灰、user 蓝、assistant 绿、tool 琥珀、unknown 中性；
 *   角色来自协议字段（chat `role` / messages `system` / responses `instructions`），
 *   `/v1/completions` 无角色字段，归一化层按 user 处理，由抽屉顶部统一说明。
 * - 折叠：正文 > 600 字或 > 12 行、工具参数 > 400 字时默认收起，避免一条记录占满整屏。
 * - 工具参数保持原始 JSON 字符串，不美化（截断时二次解析会失败）。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { formatBytes } from "@/lib/format";
import type { AuditBlock, AuditRole } from "@/server/audit/types";

const ROLE_META: Record<AuditRole, { label: string; chip: string; bar: string }> = {
  system: { label: "系统", chip: "bg-muted text-muted-foreground", bar: "border-l-border" },
  user: { label: "用户", chip: "bg-info/15 text-info", bar: "border-l-info" },
  assistant: { label: "助手", chip: "bg-success/15 text-success", bar: "border-l-success" },
  tool: { label: "工具", chip: "bg-warning/20 text-warning", bar: "border-l-warning" },
  unknown: { label: "未知", chip: "bg-muted text-muted-foreground", bar: "border-l-border" },
};

/**
 * 折叠判定必须基于**实际溢出**，而不是字符数：
 * 519 字的参数在 160px 高度内可能根本没有被裁剪，此时给出「展开全部」按钮点了也没反应。
 */
function useExpandable(forceOpen = false) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const open = manualOpen || forceOpen;

  useLayoutEffect(() => {
    if (open) return;
    const element = ref.current;
    if (element === null) return;
    const check = (): void => {
      if (element.scrollHeight > element.clientHeight + 2) setCanExpand(true);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  return { ref, open, setOpen: setManualOpen, canExpand: canExpand && !forceOpen };
}

/** 命中高亮：大小写不敏感的子串匹配，最多标记 200 处（防长文本生成过多节点）。 */
function Highlight({ text, query }: { text: string; query?: string }) {
  const needle = query?.trim().toLowerCase() ?? "";
  if (needle === "" || text === "") return <>{text}</>;

  const haystack = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hits = 0;

  while (hits < 200) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={`${at}-${hits}`} className="rounded-sm bg-warning/40 px-0.5 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
    hits += 1;
  }

  if (cursor === 0) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function ExpandButton({ open, onClick, hint }: { open: boolean; onClick: () => void; hint: string }) {
  return (
    <button type="button" onClick={onClick} className="mt-1 text-[11px] text-primary hover:underline">
      {open ? "收起" : hint}
    </button>
  );
}

/** 长正文：按实际溢出折叠，底部渐隐，点开展开全文；搜索命中时强制展开。 */
function ClampText({ text, keyword }: { text: string; keyword?: string }) {
  const needle = keyword?.trim().toLowerCase() ?? "";
  const hit = needle !== "" && text.toLowerCase().includes(needle);
  const { ref, open, setOpen, canExpand } = useExpandable(hit);
  return (
    <div>
      <div ref={ref} className={`relative ${open ? "" : "max-h-52 overflow-hidden"}`}>
        <p className="whitespace-pre-wrap break-words">
          <Highlight text={text} query={keyword} />
        </p>
        {canExpand && !open ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
        ) : null}
      </div>
      {canExpand ? (
        <ExpandButton
          open={open}
          onClick={() => setOpen((value) => !value)}
          hint={`展开全部（${text.length} 字）`}
        />
      ) : null}
    </div>
  );
}

/** 工具参数 / 结果：等宽 + 按实际溢出折叠；搜索命中时强制展开。 */
function ClampPre({ text, empty, keyword }: { text: string; empty: string; keyword?: string }) {
  const needle = keyword?.trim().toLowerCase() ?? "";
  const hit = needle !== "" && text.toLowerCase().includes(needle);
  const { ref, open, setOpen, canExpand } = useExpandable(hit);
  if (text === "") {
    return <span className="text-[11px] text-muted-foreground">{empty}</span>;
  }
  return (
    <div>
      <div
        ref={ref}
        className={`rounded-lg border bg-muted/40 p-2.5 ${open ? "" : "max-h-40 overflow-hidden"}`}
      >
        <pre className="text-[11px] leading-5 whitespace-pre-wrap break-all">
          <Highlight text={text} query={keyword} />
        </pre>
      </div>
      {canExpand ? (
        <ExpandButton
          open={open}
          onClick={() => setOpen((value) => !value)}
          hint={`展开全部（${text.length} 字）`}
        />
      ) : null}
    </div>
  );
}

export function MessageBlock({ block, keyword }: { block: AuditBlock; keyword?: string }) {
  const meta = ROLE_META[block.role] ?? ROLE_META.unknown;
  const isTool = block.kind === "tool_call" || block.kind === "tool_result";

  return (
    <div
      className={`flex gap-3 rounded-xl border border-l-2 px-3 py-2.5 ${meta.bar} ${
        isTool ? "bg-muted/40" : "bg-card"
      }`}
    >
      <div className="w-16 shrink-0 text-[11px] leading-5 text-muted-foreground">
        <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] ${meta.chip}`}>
          {meta.label}
        </span>
        <div className="mt-1 font-mono">#{block.seq}</div>
      </div>

      <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
        {block.kind === "text" || block.kind === "other" ? (
          <ClampText text={block.text ?? ""} keyword={keyword} />
        ) : null}

        {block.kind === "tool_call" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] text-info">tool_call</span>
              <span className="font-mono">{block.tool?.name ?? "unknown"}</span>
              {block.tool?.callId === undefined ? null : (
                <span className="font-mono">{block.tool.callId}</span>
              )}
            </div>
            <ClampPre text={block.tool?.arguments ?? ""} empty="（无参数）" keyword={keyword} />
          </div>
        ) : null}

        {block.kind === "tool_result" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px]">tool_result</span>
              {block.tool?.callId === undefined ? null : (
                <span className="font-mono">call_id {block.tool.callId}</span>
              )}
            </div>
            <ClampPre text={block.text ?? ""} empty="（空）" keyword={keyword} />
          </div>
        ) : null}

        {block.kind === "image" ? (
          <div className="flex flex-col gap-2">
            <span className="w-fit rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              image
            </span>
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
