// Display dates in a fixed zone so server (UTC container) and browser render the same text.
export const DISPLAY_TZ = "Asia/Seoul";

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" in the display zone. */
export function dayKey(d: Date | string | number): string {
  return dayFmt.format(new Date(d));
}

/** "2026. 11. 12." style date in the display zone. */
export function formatDate(d: Date | string | number): string {
  return new Date(d).toLocaleDateString("ko-KR", { timeZone: DISPLAY_TZ });
}

/** "M.D" label for a "YYYY-MM-DD" key. */
export function shortDay(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(m)}.${Number(d)}`;
}

/** Last `n` day keys (oldest first, today last) in the display zone. */
export function lastDayKeys(n: number, now: Date | number = new Date()): string[] {
  const t = new Date(now).getTime();
  return Array.from({ length: n }, (_, i) => dayKey(t - (n - 1 - i) * 86_400_000));
}
