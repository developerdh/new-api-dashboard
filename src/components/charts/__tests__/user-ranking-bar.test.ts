/** 单测：用户排行图——姓名标签可点（triggerEvent / 链接色）与点击解析。 */
import { describe, expect, it } from "vitest";

import {
  buildRankingOption,
  resolveRankingClickRow,
} from "@/components/charts/user-ranking-bar";
import type { UserRankingRow } from "@/server/queries/user";

const ROWS: UserRankingRow[] = [
  {
    userId: 3,
    username: "xuhb",
    displayName: "谢文杰",
    totalQuota: 500_000,
    totalTokens: 1_000,
    requestCount: 10,
  },
  {
    userId: 7,
    username: "wanghz",
    displayName: "",
    totalQuota: 100_000,
    totalTokens: 500,
    requestCount: 4,
  },
];

interface AxisOption {
  triggerEvent: boolean;
  axisLabel: { color?: string; width: number };
}

describe("buildRankingOption", () => {
  it("y 轴开启 triggerEvent（姓名标签参与事件）", () => {
    const option = buildRankingOption(ROWS) as unknown as { yAxis: AxisOption };
    expect(option.yAxis.triggerEvent).toBe(true);
  });

  it("提供 linkColor 时姓名标签用链接色（穿透主题补全的显式设置）", () => {
    const withColor = buildRankingOption(ROWS, "totalQuota", "#4aa3ff") as unknown as {
      yAxis: AxisOption;
    };
    expect(withColor.yAxis.axisLabel.color).toBe("#4aa3ff");

    const without = buildRankingOption(ROWS) as unknown as { yAxis: AxisOption };
    expect(without.yAxis.axisLabel.color).toBeUndefined();
  });
});

describe("resolveRankingClickRow", () => {
  it("柱体点击：series 事件按 dataIndex 取行", () => {
    expect(resolveRankingClickRow({ targetType: "series", dataIndex: 1 }, ROWS)).toBe(ROWS[1]);
  });

  it("姓名标签点击：axisLabel 事件按类目文本回查（displayName 优先）", () => {
    expect(resolveRankingClickRow({ targetType: "axisLabel", value: "谢文杰" }, ROWS)).toBe(ROWS[0]);
    // 无昵称时标签回落为账号名
    expect(resolveRankingClickRow({ targetType: "axisLabel", value: "wanghz" }, ROWS)).toBe(ROWS[1]);
  });

  it("未知标签 / 越界 dataIndex 返回 undefined（不误跳转）", () => {
    expect(resolveRankingClickRow({ targetType: "axisLabel", value: "不存在" }, ROWS)).toBeUndefined();
    expect(resolveRankingClickRow({ targetType: "series", dataIndex: 9 }, ROWS)).toBeUndefined();
  });
});
