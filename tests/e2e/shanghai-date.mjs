/** 东八区自然日 YYYY-MM-DD（与 src/server/dashcam/paths.ts 的 dashcamDateOf 同口径）。 */
export function shanghaiDateOf(epochSeconds) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
