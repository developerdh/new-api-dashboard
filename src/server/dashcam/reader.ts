/**
 * blob 读取：按索引决定路径与解压，**不猜后缀**。
 *
 * 双路径（D-P5）：
 * - `seg` 存在 → 段式打包（`blobs/<date>/<fp>/<seg>`，1 次 open + 按需 pread）：
 *   14B 定长头 `[magic "DCPK"][reqLen 4B LE][resLen 4B LE][flags 2B LE]` +
 *   req||res payload，flags bit0/bit1 = req/res gzip；
 * - `seg` 缺失 → 旧的两文件布局（`<trace>.req[.gz]` / `.res[.gz]`），按 `qz`/`rz` 解压。
 *
 * 上限：`DASHCAM_MAX_BLOB_BYTES`（默认 16 MiB，解压后）为硬顶。采集侧上限是 128 MiB，
 * 直接整段读入 + `JSON.parse` 会让单次请求吃掉数百 MB 内存，故读取层先截断再交给归一化。
 *
 * 兼容：旧布局在 rename 之后追加索引，理论上有极小窗口出现标记与实际文件不符，
 * 因此标记为 `.gz` 但文件不存在、或解压失败时，回退试一次另一后缀。
 * 段记录损坏（头部不符 / ln 与索引不一致 / 被截断）一律按 missing 处理——
 * 崩溃半条不会有索引行，能被索引引用到的记录必然完整。
 */
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";

import { dashcamBlobPath, dashcamPackPath } from "./paths";

/** 默认单文件读取上限（解压后）。 */
export const DEFAULT_MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** 与采集侧 `MAX_REQUEST_BYTES` 对齐的硬上限。 */
export const HARD_MAX_BLOB_BYTES = 128 * 1024 * 1024;

/** 段记录定长头：`[magic 4B][reqLen 4B LE][resLen 4B LE][flags 2B LE]`。 */
export const PACK_HEADER_BYTES = 14;
/** 段记录 magic（与 dashcam/pack.go 的 packMagic 一致）。 */
export const PACK_MAGIC = "DCPK";
/** flags bit0/bit1 = req/res gzip（与 packFlagReqGz/packFlagResGz 一致）。 */
const PACK_FLAG_REQ_GZ = 1 << 0;
const PACK_FLAG_RES_GZ = 1 << 1;

export class DashcamBlobMissingError extends Error {
  readonly code = "not_found";

  constructor(message = "监控记录不存在") {
    super(message);
    this.name = "DashcamBlobMissingError";
  }
}

/** 索引 seg/off/ln 的段定位信息（D-P5）；缺失 = 旧的两文件布局。 */
export interface ReadBlobSeg {
  /** 段文件名（`seg-<HH>-<seq>.pack`，已由索引解析层按白名单校验） */
  name: string;
  /** 记录头在段文件内的偏移（字节） */
  off: number;
  /** 整条记录字节数（头 + payload）；缺失时由头部校验推导 */
  ln?: number;
}

export interface ReadBlobInput {
  dir: string;
  date: string;
  fp: string;
  trace: string;
  kind: "req" | "res";
  gzip: boolean;
  /** 段式打包定位（D-P5）；给出时走段路径，忽略 trace/gzip 后缀猜测 */
  seg?: ReadBlobSeg;
}

export interface ReadBlobResult {
  text: string;
  /** 实际解码后的字节数（截断时为截断后的长度） */
  bytes: number;
  /** 实际使用的文件是否 gzip（可能与索引标记不同） */
  gzip: boolean;
  /** 是否因上限被截断 */
  capped: boolean;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function dashcamMaxBlobBytes(): number {
  return envInt("DASHCAM_MAX_BLOB_BYTES", DEFAULT_MAX_BLOB_BYTES, 1_024, HARD_MAX_BLOB_BYTES);
}

export function dashcamRawPreviewBytes(): number {
  return envInt("DASHCAM_RAW_PREVIEW_BYTES", 256 * 1024, 1_024, HARD_MAX_BLOB_BYTES);
}

/** 读文件前 `max` 字节；文件更大则标记 `capped`（不把整文件读进内存）。 */
async function readFileCapped(
  path: string,
  max: number,
): Promise<{ buffer: Buffer; capped: boolean }> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= max) {
      return { buffer: await handle.readFile(), capped: false };
    }
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return { buffer: buffer.subarray(0, bytesRead), capped: true };
  } finally {
    await handle.close();
  }
}

/** 流式解压并在 `max` 处截断（`zlib.gunzip` 的 `maxOutputLength` 一超限就整体报错，拿不到半截）。 */
function gunzipCapped(buffer: Buffer, max: number): Promise<{ text: string; capped: boolean }> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remain = max - total;
      if (chunk.length >= remain) {
        chunks.push(chunk.subarray(0, remain));
        settled = true;
        gunzip.destroy();
        resolve({ text: Buffer.concat(chunks).toString("utf8"), capped: true });
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    gunzip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8"), capped: false });
    });
    gunzip.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    gunzip.end(buffer);
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * 读取一次请求的 req 或 res 正文。
 * `seg` 存在走段路径；否则 `gzip` 来自索引的 `qz` / `rz`，标记与实际文件不符时自动回退一次。
 */
export async function readDashcamBlob(input: ReadBlobInput): Promise<ReadBlobResult> {
  if (input.seg !== undefined) {
    return readFromPack(input, input.seg);
  }
  const max = dashcamMaxBlobBytes();
  const candidates: boolean[] = input.gzip ? [true, false] : [false, true];
  let missing = true;
  let lastError: unknown;

  for (const gzip of candidates) {
    const path = dashcamBlobPath(input.dir, {
      date: input.date,
      fp: input.fp,
      trace: input.trace,
      kind: input.kind,
      gz: gzip,
    });

    let raw: { buffer: Buffer; capped: boolean };
    try {
      raw = await readFileCapped(path, max);
    } catch (error) {
      if (isMissing(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }

    missing = false;
    if (!gzip) {
      return {
        text: raw.buffer.toString("utf8"),
        bytes: raw.buffer.length,
        gzip: false,
        capped: raw.capped,
      };
    }

    try {
      const decoded = await gunzipCapped(raw.buffer, max);
      return {
        text: decoded.text,
        bytes: Buffer.byteLength(decoded.text, "utf8"),
        gzip: true,
        capped: decoded.capped || raw.capped,
      };
    } catch {
      // 标记为 gz 但内容不是 gzip（损坏/截断）：按记录缺失降级（外溢会把
      // 畸形文件变成 500），回退到另一后缀
      lastError = new DashcamBlobMissingError("正文解压失败");
      continue;
    }
  }

  if (missing) throw new DashcamBlobMissingError();
  throw lastError instanceof Error ? lastError : new DashcamBlobMissingError();
}

/**
 * 段式打包读取（D-P5）：1 次 open，先 pread 定长头再按需 pread 目标侧 payload。
 * 头部不符 / ln 与索引不一致 / payload 被截断（崩溃半条或段损坏）一律按 missing 处理。
 */
async function readFromPack(input: ReadBlobInput, seg: ReadBlobSeg): Promise<ReadBlobResult> {
  const max = dashcamMaxBlobBytes();
  const path = dashcamPackPath(input.dir, {
    date: input.date,
    fp: input.fp,
    seg: seg.name,
  });

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    // 段已被清理 / 从未存在：与旧布局的 missing 语义一致（路由映射 404）
    if (isMissing(error)) throw new DashcamBlobMissingError();
    throw error;
  }
  try {
    const head = Buffer.alloc(PACK_HEADER_BYTES);
    const headRead = await handle.read(head, 0, PACK_HEADER_BYTES, seg.off);
    if (
      headRead.bytesRead < PACK_HEADER_BYTES ||
      head.toString("latin1", 0, 4) !== PACK_MAGIC
    ) {
      throw new DashcamBlobMissingError("段记录头部损坏");
    }
    const reqLen = head.readUInt32LE(4);
    const resLen = head.readUInt32LE(8);
    const flags = head.readUInt16LE(12);
    if (seg.ln !== undefined && seg.ln !== PACK_HEADER_BYTES + reqLen + resLen) {
      throw new DashcamBlobMissingError("段记录与索引长度不一致");
    }

    const isReq = input.kind === "req";
    const diskLen = isReq ? reqLen : resLen;
    const gz = (flags & (isReq ? PACK_FLAG_REQ_GZ : PACK_FLAG_RES_GZ)) !== 0;
    const sliceOff = seg.off + PACK_HEADER_BYTES + (isReq ? 0 : reqLen);
    const wanted = Math.min(diskLen, max);
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, sliceOff);
    if (bytesRead < wanted) {
      throw new DashcamBlobMissingError("段记录被截断");
    }
    const slice = buffer.subarray(0, bytesRead);
    const capped = diskLen > wanted;

    if (!gz) {
      return {
        text: slice.toString("utf8"),
        bytes: slice.length,
        gzip: false,
        capped,
      };
    }
    let decoded: Awaited<ReturnType<typeof gunzipCapped>>;
    try {
      decoded = await gunzipCapped(slice, max);
    } catch {
      // 段内 gzip 损坏：按记录缺失降级（与头部损坏同语义），不让错误外溢为 500
      throw new DashcamBlobMissingError("段记录解压失败");
    }
    return {
      text: decoded.text,
      bytes: Buffer.byteLength(decoded.text, "utf8"),
      gzip: true,
      capped: decoded.capped || capped,
    };
  } finally {
    await handle.close();
  }
}
