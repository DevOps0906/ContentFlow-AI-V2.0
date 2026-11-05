import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  afterEdit,
  cmsOnlyStates,
  localActions,
  phaseOf,
  phases,
  canTransition,
  lifecycleLabels,
  lifecycleStates,
  localToLifecycle,
  nextStates,
  requiresApproval,
  transition,
  type LifecycleState,
} from "../src/lib/lifecycle";

test("lifecycle states match the article_state enum in the DB migration", () => {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/0001_core_tenancy.sql", import.meta.url),
    "utf8",
  );
  const m = sql.match(/create type article_state as enum \(([^)]*)\)/);
  assert.ok(m, "article_state enum not found");
  const dbStates = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...lifecycleStates].sort(), dbStates.sort());
  for (const s of lifecycleStates) assert.ok(lifecycleLabels[s]);
});

test("every state is reachable from idea", () => {
  const seen = new Set<LifecycleState>(["idea"]);
  const queue: LifecycleState[] = ["idea"];
  while (queue.length)
    for (const n of nextStates(queue.shift()!))
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  assert.deepEqual([...seen].sort(), [...lifecycleStates].sort());
});

test("approval cannot be skipped on any path to approval-gated states", () => {
  // Remove `approved` and nothing gated may stay reachable from idea.
  const seen = new Set<LifecycleState>(["idea"]);
  const queue: LifecycleState[] = ["idea"];
  while (queue.length)
    for (const n of nextStates(queue.shift()!))
      if (n !== "approved" && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  for (const s of requiresApproval) assert.ok(!seen.has(s), `${s} reachable without approval`);
});

test("invalid transitions are rejected", () => {
  assert.throws(() => transition("drafting", "approved"));
  assert.throws(() => transition("idea", "published"));
  assert.ok(!canTransition("publish_failed", "published"));
  // Draft creation is not publication; an operator must confirm.
  assert.ok(!canTransition("publishing", "published"));
  assert.ok(canTransition("draft_created", "published"));
  assert.equal(transition("qa_pending", "approval_pending"), "approval_pending");
});

test("editing approved content returns to drafting", () => {
  for (const s of ["approved", "export_ready"] as const) assert.ok(canTransition(s, "drafting"));
  assert.equal(localToLifecycle("draft"), "drafting");
  assert.equal(localToLifecycle("approved"), "approved");
  for (const s of requiresApproval) assert.equal(afterEdit(s), "drafting");
  assert.equal(afterEdit("briefing"), "briefing");
});

test("local actions never offer CMS-only transitions as available", () => {
  for (const s of lifecycleStates)
    for (const a of localActions(s)) {
      assert.ok(canTransition(s, a.to));
      assert.equal(a.available, !cmsOnlyStates.includes(a.to));
    }
  // Manual path works without a CMS: export_ready → manual_pending → published.
  assert.ok(localActions("export_ready").some((a) => a.to === "manual_pending" && a.available));
  assert.ok(localActions("manual_pending").some((a) => a.to === "published" && a.available));
  assert.ok(localActions("export_ready").some((a) => a.to === "publishing" && !a.available));
});

test("with a CMS connection only sending (and closing a stuck send) becomes available", () => {
  const cms = { cmsConnected: true };
  const on = (s: Parameters<typeof localActions>[0]) =>
    localActions(s, cms).filter((a) => a.available).map((a) => a.to);
  assert.ok(on("export_ready").includes("publishing"));
  assert.ok(on("publish_failed").includes("publishing"));
  // Results of a send are decided by the server response, never picked by hand.
  assert.ok(!on("publishing").includes("draft_created"));
  assert.deepEqual(on("publishing"), ["publish_failed"]);
  assert.ok(!localActions("export_ready").some((a) => a.to === "publishing" && a.available));
});

test("every state belongs to exactly one of the 5 phases", () => {
  for (const s of lifecycleStates) assert.ok(phases.includes(phaseOf(s)));
  assert.deepEqual(
    phases.map((p) => lifecycleStates.filter((s) => phaseOf(s) === p).length),
    [3, 4, 2, 5, 2],
  );
});
