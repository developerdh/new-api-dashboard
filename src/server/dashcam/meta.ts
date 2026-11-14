/**
 * 采集端抽样状态（`DASHCAM_DIR/meta.json`，D-P2）。
 *
 * 代理每次启动把当前抽样配置覆盖写入 meta.json，看板只读读取后展示统一口径提示，
 * 避免看板/代理两处配置漂移。文件缺失 = 视为未开启（兼容未升级的旧代理）；
 * 解析失败同样按未开启处理——提示缺失只影响展示，绝不影响列表本身。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DashcamSamplingMeta {
  enabled: boolean;
  modulus: number;
  keep: number;
}

function toNonNegativeInt(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

/** 读抽样状态；缺失 / 损坏 / 字段异常一律返回 null（= 未开启）。 */
export async function readSamplingMeta(dir: string): Promise<DashcamSamplingMeta | null> {
  let raw: string;
  try {
    // meta.json 固定在记录根目录（代理侧 writeSamplingMeta 写入）；缺失即旧代理
    raw = await readFile(join(dir, "meta.json"), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const modulus = toNonNegativeInt(record.sample_modulus);
  const keep = toNonNegativeInt(record.sample_keep);
  if (modulus === null || keep === null) return null;
  // 与代理侧 loadConfig 的校验同口径：开启要求 modulus > 0 且 1 ≤ keep ≤ modulus
  const enabled = modulus > 0 && record.sampling_enabled === true && keep >= 1 && keep <= modulus;
  return { enabled, modulus, keep };
}
