import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
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
});
