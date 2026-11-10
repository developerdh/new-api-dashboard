import { redirect } from "next/navigation";

/** 入口重定向：/ → /dashboard（方案 §7.1）。 */
export default function Home() {
  redirect("/dashboard");
}