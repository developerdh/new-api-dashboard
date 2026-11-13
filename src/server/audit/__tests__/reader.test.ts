import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditBlobMissingError, readAuditBlob } from "@/server/audit/reader";

const DATE = "2026-11-13";
const FP = "dbbbf1891a47";
const TRACE = "0123456789abcdef0123456789abcdef";

let dir = "";

async function put(name: string, content: Buffer | string): Promise<void> {
  const target = join(dir, "blobs", DATE, FP);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, name), content);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "audit-reader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.AUDIT_MAX_BLOB_BYTES;
});

describe("readAuditBlob", () => {
  it("按索引标记直接读明文", async () => {
    await put(`${TRACE}.req`, '{"hello":"世界"}');
    const result = await readAuditBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "req",
      gzip: false,
    });
    expect(result.text).toBe('{"hello":"世界"}');
    expect(result.gzip).toBe(false);
    expect(result.capped).toBe(false);
  });

  it("按索引标记解压 gzip", async () => {
    const payload = '{"data":"' + "x".repeat(500) + '"}';
    await put(`${TRACE}.res.gz`, gzipSync(payload));
    const result = await readAuditBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "res",
      gzip: true,
    });
    expect(result.text).toBe(payload);
    expect(result.gzip).toBe(true);
  });

  it("标记为 gz 但文件是明文时回退（索引与 rename 的极小窗口）", async () => {
    await put(`${TRACE}.res`, "plain-body");
    const result = await readAuditBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "res",
      gzip: true,
    });
    expect(result.text).toBe("plain-body");
    expect(result.gzip).toBe(false);
  });

  it("文件缺失抛 AuditBlobMissingError（路由映射 404）", async () => {
    await expect(
      readAuditBlob({
        dir,
        date: DATE,
        fp: FP,
        trace: TRACE,
        kind: "req",
        gzip: false,
      }),
    ).rejects.toBeInstanceOf(AuditBlobMissingError);
  });

  it("明文超过上限时截断并标记 capped", async () => {
    process.env.AUDIT_MAX_BLOB_BYTES = "1024";
    await put(`${TRACE}.req`, "a".repeat(4096));
    const result = await readAuditBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "req",
      gzip: false,
    });
    expect(result.capped).toBe(true);
    expect(result.text).toHaveLength(1024);
  });

  it("解压后超过上限时截断（防压缩炸弹）", async () => {
    process.env.AUDIT_MAX_BLOB_BYTES = "1024";
    await put(`${TRACE}.req.gz`, gzipSync("b".repeat(200_000)));
    const result = await readAuditBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "req",
      gzip: true,
    });
    expect(result.capped).toBe(true);
    expect(result.text).toHaveLength(1024);
  });
});
