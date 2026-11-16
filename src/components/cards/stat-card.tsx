/**
 * 兼容别名：原 Tremor 冒烟卡已由 `MetricCard` 取代。
 * 采用自定义卡片的原因见 CHANGELOG.md（Tremor v3 token 与 Tailwind v4 冲突）。
 */
export { MetricCard as StatCard } from "@/components/cards/MetricCard";
export type { MetricCardProps as StatCardProps } from "@/components/cards/MetricCard";
