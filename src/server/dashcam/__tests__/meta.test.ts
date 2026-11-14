import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSamplingMeta } from "@/server/dashcam/meta";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dashcam-meta-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeMeta(content: string | Buffer): Promise<void> {
  await writeFile(join(dir, "meta.json"), content);
}

describe("readSamplingMeta（D-P2）", () => {
  it("文件缺失 = 未开启（兼容旧代理）", async () => {
    await expect(readSamplingMeta(dir)).resolves.toBeNull();
  });

  it("记录目录本身不存在时同样返回 null，不抛错", async () => {
    await expect(readSamplingMeta(join(dir, "nope"))).resolves.toBeNull();
  });

  it("开启态：modulus>0 且 1≤keep≤modulus", async () => {
    await writeMeta(`{"sampling_enabled":true,"sample_modulus":10,"sample_keep":3}\n`);
    await expect(readSamplingMeta(dir)).resolves.toEqual({ enabled: true, modulus: 10, keep: 3 });
  });

  it("关闭态（默认输出）：enabled=false", async () => {
    await writeMeta(`{"sampling_enabled":false,"sample_modulus":0,"sample_keep":1}\n`);
    await expect(readSamplingMeta(dir)).resolves.toEqual({ enabled: false, modulus: 0, keep: 1 });
  });

  it("keep 越界（> modulus）即使标记开启也不生效", async () => {
    await writeMeta(`{"sampling_enabled":true,"sample_modulus":10,"sample_keep":11}\n`);
    const meta = await readSamplingMeta(dir);
    expect(meta).not.toBeNull();
    expect(meta?.enabled).toBe(false);
  });

  it("keep=0 同样视为未开启", async () => {
    await writeMeta(`{"sampling_enabled":true,"sample_modulus":10,"sample_keep":0}\n`);
    const meta = await readSamplingMeta(dir);
    expect(meta?.enabled).toBe(false);
  });

  it("损坏的 JSON 返回 null，不抛错", async () => {
    await writeMeta(`{"sampling_enabled":true,`);
    await expect(readSamplingMeta(dir)).resolves.toBeNull();
  });

  it("字段类型异常返回 null", async () => {
    await writeMeta(`{"sampling_enabled":true,"sample_modulus":"many","sample_keep":1}\n`);
    await expect(readSamplingMeta(dir)).resolves.toBeNull();
  });

  it("非 JSON 对象返回 null", async () => {
    await writeMeta(`"enabled"\n`);
    await expect(readSamplingMeta(dir)).resolves.toBeNull();
  });

  it("目录不可读（文件是目录）返回 null", async () => {
    await mkdir(join(dir, "meta.json"));
    await expect(readSamplingMeta(dir)).resolves.toBeNull();
  });
});
