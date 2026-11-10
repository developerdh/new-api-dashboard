import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind 类名：clsx 处理条件类，tailwind-merge 消解冲突类。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}