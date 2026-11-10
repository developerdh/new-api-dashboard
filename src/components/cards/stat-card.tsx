"use client";

import { Card, Metric, Text } from "@tremor/react";

type StatCardProps = {
  title: string;
  value: string;
  hint?: string;
};

/**
 * 指标卡骨架（方案 §7.2「总览：数字卡片」）。
 * 仅做依赖冒烟与结构占位；真实数据与样式收口归 FE-M2-02。
 */
export function StatCard({ title, value, hint }: StatCardProps) {
  return (
    <Card>
      <Text>{title}</Text>
      <Metric>{value}</Metric>
      {hint ? <Text>{hint}</Text> : null}
    </Card>
  );
}