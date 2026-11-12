/**
 * 额度轨：把区间内每日真实用量压成一条细密刻度条。
 *
 * 这不是装饰性渐变——每根刻度对应一天的聚合值，高度与透明度都来自数据本身。
 * 「额度制中转站」才有这种读数方式，因此作为本看板的签名元素。
 */
export function QuotaRail({ values, label }: { values: number[]; label?: string }) {
  const recent = values.slice(-48);
  if (recent.length === 0) return null;

  const max = Math.max(...recent, 1);
  const caption = label ?? `日分布 · 近 ${recent.length} 天`;

  return (
    <div className="mt-3">
      <div
        className="flex h-6 items-end gap-[2px]"
        role="img"
        aria-label={`${caption}（峰值 ${max.toLocaleString("zh-CN")}）`}
      >
        {recent.map((value, index) => {
          const ratio = Math.max(0, Math.min(1, value / max));
          return (
            <span
              key={index}
              className="min-w-[2px] flex-1 rounded-[1px] bg-primary"
              style={{ height: `${Math.max(6, ratio * 100)}%`, opacity: 0.25 + ratio * 0.75 }}
            />
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        {caption}
      </p>
    </div>
  );
}
