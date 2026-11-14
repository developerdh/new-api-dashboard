/**
 * 抽样口径统一提示（D-P2）：代理开启按调用方指纹比例抽样时展示。
 *
 * 文案口径来自 docs/dashcam/06-performance-plan.md §12.3：
 * 只有会话层面按被抽中的调用方筛选监听（被抽中指纹的会话视图完整），
 * 其他汇总统计不做用户维度口径——总量以 New API 主库为准。
 */
export function SamplingNotice({
  sampling,
}: {
  sampling?: { modulus: number; keep: number };
}) {
  if (!sampling) return null;
  return (
    <p
      data-testid="sampling-notice"
      className="mb-2 shrink-0 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      抽样开启（每 {sampling.modulus} 个调用方保留 {sampling.keep}
      个）：未抽中的调用方不产生任何记录，请求量等汇总只反映被抽中部分；总量口径以 New API
      主库为准。
    </p>
  );
}
