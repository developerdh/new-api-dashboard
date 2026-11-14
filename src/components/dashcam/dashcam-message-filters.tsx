"use client";

/**
 * 消息内容过滤条：角色 chips + 类型 chips + 关键词搜索 + 清空。
 *
 * 「会话详情」（单请求）与「会话线程」（聚合多轮）共用同一套过滤条件与语义，
 * 保证两个抽屉的交互一致。过滤都作用在 `DashcamBlock` 级别：
 * - 角色：block.role 精确匹配；
 * - 类型：text 含 text/other，tool 含 tool_call/tool_result，image 即 image；
 * - 关键词：正文 + 工具名/参数/callId 的小写包含匹配。
 */

import { Chip } from "@/components/dashcam/chip";
import type { DashcamBlock, DashcamRole } from "@/server/dashcam/types";

export type RoleFilter = "all" | DashcamRole;
export type KindFilter = "all" | "text" | "tool" | "image";

export const ROLE_FILTERS: Array<{ key: RoleFilter; label: string }> = [
  { key: "all", label: "全部角色" },
  { key: "system", label: "系统" },
  { key: "user", label: "用户" },
  { key: "assistant", label: "助手" },
  { key: "tool", label: "工具" },
];

export const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "全部类型" },
  { key: "text", label: "文本" },
  { key: "tool", label: "工具" },
  { key: "image", label: "图片" },
];

export function kindMatches(block: DashcamBlock, kind: KindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "text") return block.kind === "text" || block.kind === "other";
  if (kind === "tool") return block.kind === "tool_call" || block.kind === "tool_result";
  return block.kind === "image";
}

export function blockText(block: DashcamBlock): string {
  return [
    block.text ?? "",
    block.tool?.name ?? "",
    block.tool?.arguments ?? "",
    block.tool?.callId ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export interface BlockFilter {
  role: RoleFilter;
  kind: KindFilter;
  /** 已 trim + 小写的关键词；空串表示不过滤。 */
  query: string;
}

export function blockMatches(block: DashcamBlock, filter: BlockFilter): boolean {
  if (filter.role !== "all" && block.role !== filter.role) return false;
  if (!kindMatches(block, filter.kind)) return false;
  if (filter.query !== "" && !blockText(block).includes(filter.query)) return false;
  return true;
}

export function isDefaultFilter(filter: BlockFilter): boolean {
  return filter.role === "all" && filter.kind === "all" && filter.query === "";
}

export function MessageFilterBar({
  filter,
  queryInput,
  onFilterChange,
  onQueryInputChange,
  onReset,
  searchPlaceholder = "搜索内容",
}: {
  filter: BlockFilter;
  /** 搜索框受控值（未防抖的原始输入）。 */
  queryInput: string;
  onFilterChange: (patch: Partial<Omit<BlockFilter, "query">>) => void;
  onQueryInputChange: (value: string) => void;
  onReset: () => void;
  searchPlaceholder?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ROLE_FILTERS.map((item) => (
        <Chip
          key={item.key}
          active={filter.role === item.key}
          onClick={() => onFilterChange({ role: item.key })}
        >
          {item.label}
        </Chip>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      {KIND_FILTERS.map((item) => (
        <Chip
          key={item.key}
          active={filter.kind === item.key}
          onClick={() => onFilterChange({ kind: item.key })}
        >
          {item.label}
        </Chip>
      ))}
      <input
        value={queryInput}
        onChange={(event) => onQueryInputChange(event.target.value)}
        placeholder={searchPlaceholder}
        className="ml-1 h-6 w-32 rounded-md border border-input bg-transparent px-2 text-[11px] outline-none focus-visible:border-ring"
      />
      {isDefaultFilter(filter) ? null : (
        <button type="button" className="ml-1 text-[11px] text-primary hover:underline" onClick={onReset}>
          清空
        </button>
      )}
    </div>
  );
}
