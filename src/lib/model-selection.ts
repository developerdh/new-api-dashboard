/**
 * 模型多选限制（FE-M2-04）：趋势最多同时选择 10 个模型（与 `/api/models/trend` 的 models 上限一致）。
 * 纯函数便于单测：第 11 个选择不生效（返回原数组引用）。
 */
export const TREND_MODEL_MAX = 10;
export const TREND_MODEL_DEFAULT = 5;

/** 切换某个模型：已选则移除；未选且未达上限则追加；达上限时原样返回。 */
export function toggleModelSelection(
  current: string[],
  modelName: string,
  max: number = TREND_MODEL_MAX,
): string[] {
  if (current.includes(modelName)) {
    return current.filter((name) => name !== modelName);
  }
  if (current.length >= max) return current;
  return [...current, modelName];
}

/** 默认选择：按传入顺序取前 N 个（通常是消耗 Top5）。 */
export function defaultModelSelection(
  modelNames: string[],
  count: number = TREND_MODEL_DEFAULT,
): string[] {
  return modelNames.slice(0, Math.max(0, count));
}
