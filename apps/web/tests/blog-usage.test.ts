import { test } from "node:test";
import assert from "node:assert/strict";
import { addGate, graceLabel, buildUsage, mapBlogLimitError, overageSlots, parseAcknowledge, peakActive, type BlogUsage } from "../src/lib/blog-usage";

const A = "activate" as const;
const R = "archive" as const;

test("peak examples of the plan (section 4)", () => {
  // 1: N=3, two stay active
  assert.equal(peakActive([A, A]), 2);
  assert.equal(overageSlots(2, 3), 0);
  // 2: five active, two archived later -> peak 5, not the 3 at the end
  assert.equal(peakActive([A, A, A, A, A, R, R]), 5);
  assert.equal(overageSlots(5, 3), 2);
  // 3: replacing A by B never raises the simultaneous count
  assert.equal(peakActive([A, A, A, R, A]), 3);
  assert.equal(overageSlots(3, 3), 0);
});

test("peakActive starts from the current active count and never goes below zero", () => {
  assert.equal(peakActive([R, A], 1), 1);
  assert.equal(peakActive([R, R]), 0);
  assert.equal(peakActive([A], 3), 4);
});

const usage = (o: Partial<BlogUsage> = {}): BlogUsage => ({
  active: 2, included: 3, max: 10, peak: 2, overageSlots: 0, overageAllowed: true, graceUntil: null, graceActiveCap: null, role: "owner", ...o,
});

test("addGate follows the trigger order", () => {
  assert.equal(addGate(usage()), "ok");
  assert.equal(addGate(usage({ active: 3 })), "confirm");
  assert.equal(addGate(usage({ active: 3, role: "admin" })), "owner");
  assert.equal(addGate(usage({ active: 10 })), "limit");
  assert.equal(addGate(usage({ active: 1, included: 1, max: 1, overageAllowed: false })), "plan");
  const now = new Date("2026-11-13T00:00:00Z");
  const grace = { graceUntil: "2026-12-01T00:00:00Z", graceActiveCap: 4 };
  assert.equal(addGate(usage({ active: 3, ...grace }), now), "ok");
  assert.equal(addGate(usage({ active: 4, ...grace }), now), "confirm");
  assert.equal(addGate(usage({ active: 4, role: "admin", ...grace }), now), "owner");
  assert.equal(addGate(usage({ active: 3, graceUntil: "2026-11-01T00:00:00Z", graceActiveCap: 4 }), now), "confirm");
  assert.equal(addGate(usage({ active: 10, ...grace }), now), "limit");
  assert.equal(graceLabel(usage(grace), now), "유예 ~2026-12-01(KST)");
});

test("buildUsage uses the current active count as peak when this month has no snapshot", () => {
  const ent = { included_blogs: 3, max_blogs: 10, overage_allowed: true, grace_until: null, grace_active_cap: null };
  const now = new Date("2026-11-13T03:00:00Z");
  assert.equal(buildUsage(ent, 2, null, "owner", now).peak, 2);
  assert.equal(buildUsage(ent, 3, { period_start: "2026-11-01", peak_active: 5 }, "owner", now).overageSlots, 2);
  // last month's row (KST boundary: 2026-10-31T15:00Z is already November in Korea)
  assert.equal(buildUsage(ent, 3, { period_start: "2026-10-31T15:00:00+00:00", peak_active: 5 }, "owner", now).peak, 5);
  assert.equal(buildUsage(ent, 3, { period_start: "2026-10-01", peak_active: 9 }, "owner", now).peak, 3);
});

test("database errors map to the API contract", () => {
  assert.deepEqual(
    [mapBlogLimitError({ message: "BLOG_LIMIT_CONFIRM_REQUIRED" })?.status, mapBlogLimitError({ message: "BLOG_LIMIT_REACHED" })?.status,
      mapBlogLimitError({ message: "PLAN_NOT_ALLOWED" })?.status, mapBlogLimitError({ message: "FORBIDDEN_ROLE" })?.status],
    [409, 409, 409, 403],
  );
  assert.equal(mapBlogLimitError({ message: "other" }), null);
  assert.equal(parseAcknowledge({ acknowledgeOverage: true }), true);
  assert.equal(parseAcknowledge({ acknowledgeOverage: "true" }), false);
});
