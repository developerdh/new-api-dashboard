/**
 * blob 读取：按索引的 `qz` / `rz` 决定是否解压，**不猜后缀**。
 *
 * 上限：`AUDIT_MAX_BLOB_BYTES`（默认 16 MiB，解压后）为硬顶。采集侧上限是 128 MiB，
 * 直接整段读入 + `JSON.parse` 会让单次请求吃掉数百 MB 内存，故读取层先截断再交给归一化。
 *
 * 兼容：索引在 rename 之后追加，理论上有极小窗口出现标记与实际文件不符，
 * 因此标记为 `.gz` 但文件不存在、或解压失败时，回退试一次另一后缀。
 */
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";

import { auditBlobPath } from "./paths";

/** 默认单文件读取上限（解压后）。 */
export const DEFAULT_MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** 与采集侧 `MAX_REQUEST_BYTES` 对齐的硬上限。 */
export const HARD_MAX_BLOB_BYTES = 128 * 1024 * 1024;

export class AuditBlobMissingError extends Error {
  readonly code = "not_found";

  constructor(message = "审计正文不存在") {
    super(message);
    this.name = "AuditBlobMissingError";
  }
}

export interface ReadBlobInput {
  dir: string;
  date: string;
  fp: string;
  trace: string;
  kind: "req" | "res";
  gzip: boolean;
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

export function auditMaxBlobBytes(): number {
  return envInt("AUDIT_MAX_BLOB_BYTES", DEFAULT_MAX_BLOB_BYTES, 1_024, HARD_MAX_BLOB_BYTES);
}

export function auditRawPreviewBytes(): number {
  return envInt("AUDIT_RAW_PREVIEW_BYTES", 256 * 1024, 1_024, HARD_MAX_BLOB_BYTES);
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
 * `gzip` 来自索引的 `qz` / `rz`；标记与实际文件不符时自动回退一次。
 */
export async function readAuditBlob(input: ReadBlobInput): Promise<ReadBlobResult> {
  const max = auditMaxBlobBytes();
  const candidates: boolean[] = input.gzip ? [true, false] : [false, true];
  let missing = true;
  let lastError: unknown;

  for (const gzip of candidates) {
    const path = auditBlobPath(input.dir, {
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
    } catch (error) {
      // 标记为 gz 但内容不是 gzip：回退到另一后缀
      lastError = error;
      continue;
    }
  }

  if (missing) throw new AuditBlobMissingError();
  throw lastError instanceof Error ? lastError : new AuditBlobMissingError();
}
