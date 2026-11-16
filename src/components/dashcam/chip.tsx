import { type ComponentProps } from "react";

/** 过滤条件小胶囊：激活态主题蓝描边 + 淡底。 */
export function Chip({
  active,
  children,
  ...rest
}: ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...rest}
      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
