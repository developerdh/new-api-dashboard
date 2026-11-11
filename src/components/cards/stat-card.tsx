/**
 * 兼容别名（FE-M2-01）：INF-M0-01 的 Tremor 冒烟卡已由 `MetricCard` 取代。
 * 采用自定义卡片的原因见 FE-M2-01 变更记录（Tremor v3 token 与 Tailwind v4 冲突）。
 */
export { MetricCard as StatCard } from "@/components/cards/MetricCard";
export type { MetricCardProps as StatCardProps } from "@/components/cards/MetricCard";
