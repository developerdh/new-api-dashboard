/**
 * 用户展示名公共件（前端/图表/导出共用，无服务端依赖）。
 *
 * New API 的 `users.username` 是账号（如 `alice`），`users.display_name` 是昵称（如 `爱丽丝`）。
 * 统一口径：**昵称优先作主名称，账号作为次要信息保留**（对账、搜索、同名区分需要），
 * 两者都缺失时回落到「用户 N」。昵称与账号只在展示层组合，后端字段不改名、不覆盖。
 */
export interface UserIdentityLabel {
  userId: number;
  username?: string | null;
  displayName?: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** 主名称：昵称 → 账号 → 「用户 N」。用于图表轴、表格主行、卡片标题。 */
export function primaryUserLabel(user: UserIdentityLabel): string {
  const displayName = clean(user.displayName);
  if (displayName !== "") return displayName;
  const username = clean(user.username);
  if (username !== "") return username;
  return `用户 ${user.userId}`;
}

/**
 * 次要信息：昵称存在且与账号不同时返回账号，否则空串。
 * 用于主名称旁的灰色小字，避免昵称完全替换账号后无法对账。
 */
export function secondaryUserLabel(user: UserIdentityLabel): string {
  const displayName = clean(user.displayName);
  const username = clean(user.username);
  if (displayName === "" || username === "" || displayName === username) return "";
  return username;
}

/** 紧凑全称（tooltip / 标题）：`爱丽丝（alice）`；无昵称时只返回账号。 */
export function fullUserLabel(user: UserIdentityLabel): string {
  const secondary = secondaryUserLabel(user);
  const primary = primaryUserLabel(user);
  return secondary === "" ? primary : `${primary}（${secondary}）`;
}
