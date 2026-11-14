import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DashcamBlobMissingError, readDashcamBlob } from "@/server/dashcam/reader";

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
  dir = await mkdtemp(join(tmpdir(), "dashcam-reader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.DASHCAM_MAX_BLOB_BYTES;
});

describe("readDashcamBlob", () => {
  it("按索引标记直接读明文", async () => {
    await put(`${TRACE}.req`, '{"hello":"世界"}');
    const result = await readDashcamBlob({
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
    const result = await readDashcamBlob({
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
    const result = await readDashcamBlob({
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

  it("文件缺失抛 DashcamBlobMissingError（路由映射 404）", async () => {
    await expect(
      readDashcamBlob({
        dir,
        date: DATE,
        fp: FP,
        trace: TRACE,
        kind: "req",
        gzip: false,
      }),
    ).rejects.toBeInstanceOf(DashcamBlobMissingError);
  });

  it("明文超过上限时截断并标记 capped", async () => {
    process.env.DASHCAM_MAX_BLOB_BYTES = "1024";
    await put(`${TRACE}.req`, "a".repeat(4096));
    const result = await readDashcamBlob({
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
    process.env.DASHCAM_MAX_BLOB_BYTES = "1024";
    await put(`${TRACE}.req.gz`, gzipSync("b".repeat(200_000)));
    const result = await readDashcamBlob({
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

/* ------------------------------------------------------------------ */
/* 段式打包（D-P5）                                                     */
/* ------------------------------------------------------------------ */

/** 与 dashcam/pack.go 的记录格式一致：[magic 4B][reqLen 4B LE][resLen 4B LE][flags 2B LE]。 */
const PACK_HEADER = 14;

function packHeader(reqLen: number, resLen: number, flags: number): Buffer {
  const head = Buffer.alloc(PACK_HEADER);
  head.write("DCPK", 0, 4, "latin1");
  head.writeUInt32LE(reqLen, 4);
  head.writeUInt32LE(resLen, 8);
  head.writeUInt16LE(flags, 12);
  return head;
}

async function putSeg(
  name: string,
  records: Array<{ req: Buffer; res: Buffer; flags: number }>,
): Promise<Array<{ off: number; ln: number }>> {
  const chunks: Buffer[] = [];
  const layout: Array<{ off: number; ln: number }> = [];
  let offset = 0;
  for (const record of records) {
    const head = packHeader(record.req.length, record.res.length, record.flags);
    const whole = Buffer.concat([head, record.req, record.res]);
    layout.push({ off: offset, ln: whole.length });
    chunks.push(whole);
    offset += whole.length;
  }
  await put(name, Buffer.concat(chunks));
  return layout;
}

const REQ_BODY = Buffer.from('{"messages":[{"role":"user","content":"hi"}]}');
const RES_BODY = Buffer.from("data: hello\n\n");
const SEG = "seg-09-00.pack";

describe("readDashcamBlob 段式打包（D-P5）", () => {
  it("seg 定位：req/res 各取一侧，未压缩 payload 原样返回", async () => {
    const [rec] = await putSeg(SEG, [
      { req: REQ_BODY, res: RES_BODY, flags: 0 },
    ]);
    const common = { dir, date: DATE, fp: FP, trace: TRACE };
    const req = await readDashcamBlob({ ...common, kind: "req", gzip: false, seg: { name: SEG, off: rec.off, ln: rec.ln } });
    expect(req.text).toBe(REQ_BODY.toString("utf8"));
    expect(req.gzip).toBe(false);
    expect(req.capped).toBe(false);
    const res = await readDashcamBlob({ ...common, kind: "res", gzip: false, seg: { name: SEG, off: rec.off, ln: rec.ln } });
    expect(res.text).toBe(RES_BODY.toString("utf8"));
  });

  it("seg 定位：flags 标记 gzip 的侧自动解压（无需索引 qz/rz）", async () => {
    const [rec] = await putSeg(SEG, [
      { req: REQ_BODY, res: gzipSync(RES_BODY), flags: 1 << 1 },
    ]);
    const res = await readDashcamBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "res",
      gzip: true,
      seg: { name: SEG, off: rec.off, ln: rec.ln },
    });
    expect(res.text).toBe(RES_BODY.toString("utf8"));
    expect(res.gzip).toBe(true);
  });

  it("新旧并存：seg 缺失的行走旧两文件路径（既有行为不变）", async () => {
    await put(`${TRACE}.req`, "legacy-body");
    const result = await readDashcamBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "req",
      gzip: false,
    });
    expect(result.text).toBe("legacy-body");
  });

  it("ln 与头部声明的 payload 长度不一致 → missing（索引与段错位）", async () => {
    const [rec] = await putSeg(SEG, [{ req: REQ_BODY, res: RES_BODY, flags: 0 }]);
    await expect(
      readDashcamBlob({
        dir,
        date: DATE,
        fp: FP,
        trace: TRACE,
        kind: "req",
        gzip: false,
        seg: { name: SEG, off: rec.off, ln: rec.ln + 5 },
      }),
    ).rejects.toBeInstanceOf(DashcamBlobMissingError);
  });

  it("崩溃半条：payload 被截断的记录按 missing 处理，不影响同段完整记录", async () => {
    const [rec1] = await putSeg(SEG, [
      { req: REQ_BODY, res: RES_BODY, flags: 0 },
    ]);
    // 模拟崩溃半条：头部声明 1MB payload，实际只有 4 字节
    const torn = Buffer.concat([packHeader(1 << 20, 0, 0), Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])]);
    const target = join(dir, "blobs", DATE, FP, SEG);
    await writeFile(target, Buffer.concat([await readFile(target), torn]));

    // 完整记录照常可读
    const req = await readDashcamBlob({
      dir,
      date: DATE,
      fp: FP,
      trace: TRACE,
      kind: "req",
      gzip: false,
      seg: { name: SEG, off: rec1.off, ln: rec1.ln },
    });
    expect(req.text).toBe(REQ_BODY.toString("utf8"));

    // 引用到半条的索引行（外部损坏才会出现）→ missing，不抛底层错误
    await expect(
      readDashcamBlob({
        dir,
        date: DATE,
        fp: FP,
        trace: TRACE,
        kind: "req",
        gzip: false,
        seg: { name: SEG, off: rec1.off + rec1.ln, ln: PACK_HEADER + (1 << 20) },
      }),
    ).rejects.toBeInstanceOf(DashcamBlobMissingError);
  });

  it("段文件缺失 → missing（已被清理）", async () => {
    await expect(
      readDashcamBlob({
        dir,
        date: DATE,
        fp: FP,
        trace: TRACE,
        kind: "req",
        gzip: false,
        seg: { name: "seg-10-01.pack", off: 0, ln: 100 },
      }),
    ).rejects.toBeInstanceOf(DashcamBlobMissingError);
  });
});
