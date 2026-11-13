// Blog usage (peak metering) and the overage notice of the multi-blog billing plan (CF-22).
// The database triggers (0019) enforce the same limits; everything here is guidance for the screen.

/** Wording version of the overage notice. Must equal `notice_version` in the 0019 audit payload. */
export const OVERAGE_NOTICE_VERSION = "v1";

export type BlogUsageEvent = "activate" | "archive";

/** Highest number of blogs active at the same time while replaying `events` (archived ones do not count). */
export function peakActive(events: readonly BlogUsageEvent[], initial = 0): number {
  let active = Math.max(0, initial);
  let peak = active;
  for (const e of events) {
    active = e === "activate" ? active + 1 : Math.max(0, active - 1);
    if (active > peak) peak = active;
  }
  return peak;
}

/** Slots above the included number, based on the peak and not on the count at the end of the period. */
export const overageSlots = (peak: number, included: number) => Math.max(0, peak - included);

export type BlogUsageRole = "owner" | "admin" | "editor" | "viewer" | string;
export type BlogUsage = {
  active: number;
  included: number;
  max: number;
  peak: number;
  overageSlots: number;
  overageAllowed: boolean;
  graceUntil: string | null;
  graceActiveCap: number | null;
  role: BlogUsageRole;
};

export type EntitlementRow = {
  included_blogs: number;
  max_blogs: number;
  overage_allowed: boolean;
  grace_until: string | null;
  grace_active_cap: number | null;
};

const KST_MS = 9 * 3_600_000;
/** `YYYY-MM` of the instant in Korea time (the billing month is a KST calendar month). */
export const kstMonth = (value: string | Date) => new Date(new Date(value).getTime() + KST_MS).toISOString().slice(0, 7);

/** Usage for the response of `GET /api/blogs/usage`. No snapshot row this month: the active count is the peak. */
export function buildUsage(
  ent: EntitlementRow,
  active: number,
  snapshot: { period_start: string; peak_active: number } | null,
  role: string,
  now: Date = new Date(),
): BlogUsage {
  const snapPeak = snapshot && kstMonth(snapshot.period_start) === kstMonth(now) ? snapshot.peak_active : 0;
  const peak = Math.max(active, snapPeak);
  return {
    active,
    included: ent.included_blogs,
    max: ent.max_blogs,
    peak,
    overageSlots: overageSlots(peak, ent.included_blogs),
    overageAllowed: ent.overage_allowed,
    graceUntil: ent.grace_until,
    graceActiveCap: ent.grace_active_cap,
    role,
  };
}

export function parseUsage(input: unknown): BlogUsage | null {
  const u = (input ?? {}) as Record<string, unknown>;
  const nums = ["active", "included", "max", "peak", "overageSlots"] as const;
  if (nums.some((k) => typeof u[k] !== "number" || !Number.isFinite(u[k] as number))) return null;
  if (typeof u.overageAllowed !== "boolean" || typeof u.role !== "string") return null;
  return {
    active: u.active as number,
    included: u.included as number,
    max: u.max as number,
    peak: u.peak as number,
    overageSlots: u.overageSlots as number,
    overageAllowed: u.overageAllowed,
    graceUntil: typeof u.graceUntil === "string" ? u.graceUntil : null,
    graceActiveCap: typeof u.graceActiveCap === "number" ? u.graceActiveCap : null,
    role: u.role,
  };
}

export type AddGate = "ok" | "confirm" | "limit" | "plan" | "owner";

/** What happens when one more blog becomes active (add or restore). Same order as the 0019 trigger. */
export function addGate(u: BlogUsage, now: Date = new Date()): AddGate {
  const next = u.active + 1;
  // Grace exempts only up to the frozen cap; anything above takes the normal path.
  if (u.graceUntil && new Date(u.graceUntil).getTime() > now.getTime() && u.graceActiveCap !== null && next <= u.graceActiveCap) return "ok";
  if (!u.overageAllowed && next > u.included) return "plan";
  if (next > u.max) return "limit";
  if (next > u.included) return u.role === "owner" ? "confirm" : "owner";
  return "ok";
}

export const GATE_MESSAGES: Record<Exclude<AddGate, "ok" | "confirm">, string> = {
  limit: "이 플랜에서 만들 수 있는 최대 블로그 수에 도달했어요. 사용하지 않는 계정을 보관하거나 플랜 변경을 확인해주세요.",
  plan: "현재 플랜은 포함된 블로그 수까지만 사용할 수 있어요. 더 추가하려면 플랜 변경이 필요해요(결제 준비 중).",
  owner: "포함된 블로그 수를 넘는 추가는 소유자만 할 수 있어요. 소유자에게 요청해주세요.",
};

export const BLOG_LIMIT_CODES = [
  "BLOG_LIMIT_CONFIRM_REQUIRED",
  "BLOG_LIMIT_REACHED",
  "PLAN_NOT_ALLOWED",
  "FORBIDDEN_ROLE",
] as const;
export type BlogLimitCode = (typeof BLOG_LIMIT_CODES)[number];

const LIMIT_RESPONSES: Record<BlogLimitCode, { status: number; message: string }> = {
  BLOG_LIMIT_CONFIRM_REQUIRED: {
    status: 409,
    message: "포함된 블로그 수를 넘어 추가 요금이 발생할 수 있어요. 내용을 확인한 뒤 다시 진행해주세요.",
  },
  BLOG_LIMIT_REACHED: { status: 409, message: GATE_MESSAGES.limit },
  PLAN_NOT_ALLOWED: { status: 409, message: GATE_MESSAGES.plan },
  FORBIDDEN_ROLE: { status: 403, message: GATE_MESSAGES.owner },
};

/** Maps the database error (`raise exception '<code>'`, message = code) to an API response, or null. */
export function mapBlogLimitError(error: { message?: string }) {
  const code = BLOG_LIMIT_CODES.find((c) => (error.message ?? "").includes(c));
  return code ? { code, ...LIMIT_RESPONSES[code] } : null;
}

/** `acknowledgeOverage` of a request body: only an explicit `true` counts. */
export const parseAcknowledge = (input: unknown) => ((input ?? {}) as Record<string, unknown>).acknowledgeOverage === true;

/** `YYYY-MM-DD` of the instant in Korea time. */
export const kstDate = (value: string | Date) => new Date(new Date(value).getTime() + KST_MS).toISOString().slice(0, 10);
/** The grace end to show, or null when there is no grace running. */
export const graceLabel = (u: BlogUsage, now: Date = new Date()) =>
  u.graceUntil && new Date(u.graceUntil).getTime() > now.getTime() ? `유예 ~${kstDate(u.graceUntil)}(KST)` : null;
