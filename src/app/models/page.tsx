import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "模型分析",
};

/** 占位页：模型分析（含用户×模型交叉，真实图表归 FE-M2-04，接口归 BE-M1-06）。 */
export default function ModelsPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">模型分析</h1>
        <p className="text-sm text-muted-foreground">
          看板骨架占位页（INF-M0-01）；数据接入见 FE-M2-04 / BE-M1-06。
        </p>
      </header>
    </main>
  );
}