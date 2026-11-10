import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("忽略空值并保留有效类名", () => {
    expect(cn("text-sm", undefined, null, "font-medium")).toBe("text-sm font-medium");
  });

  it("后者覆盖冲突的 Tailwind 类", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});