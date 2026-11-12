"use client";

/**
 * 回到顶部：滚动超过阈值后出现在右下角，控制台所有页面共用。
 * window 滚动（页面本身无内部滚动容器）；尊重 prefers-reduced-motion。
 */
import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

const SHOW_AFTER_PX = 320;

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = (): void => {
      setVisible(window.scrollY > SHOW_AFTER_PX);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // 刷新时浏览器可能恢复滚动位置，异步对齐一次初始可见性
    const frame = requestAnimationFrame(onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  if (!visible) return null;

  const scrollToTop = (): void => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <Button
      type="button"
      size="icon"
      onClick={scrollToTop}
      aria-label="回到顶部"
      title="回到顶部"
      className="fixed bottom-6 right-4 z-40 size-11 animate-in rounded-full shadow-md duration-150 fade-in-0 hover:shadow-lg lg:right-6"
    >
      <ArrowUp className="size-4" />
    </Button>
  );
}
