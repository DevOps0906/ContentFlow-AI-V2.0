import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dbToImprovement,
  improvementError,
  improvementStates,
  isOverdue,
  parseImprovement,
  parseImprovementUpdate,
  targetUrlAfterPick,
  toDbImprovement,
} from "../src/lib/improvements";
import { canManageImprovements, roles } from "../src/lib/team";
import { ImprovementQueue } from "../src/components/improvement-queue";

const A = "30000000-0000-4000-8000-0000000000f6";
const U = "00000000-0000-4000-8000-0000000000a2";
const valid = {
  articleId: A, targetUrl: "https://blog.example/a", evidence: " CTR 0.4% ",
  observedFrom: "2026-10-01", observedTo: "2026-10-31", assigneeId: U, reviewAt: "2026-12-01",
};
test("the auto-filled URL follows the article; a typed URL stays", () => {
  const a = "https://blog.example/a";
  const b = "https://blog.example/b";
  assert.equal(targetUrlAfterPick("", undefined, a), a);
  assert.equal(targetUrlAfterPick(a, a, b), b);
  assert.equal(targetUrlAfterPick(a, a, undefined), "", "an article with no public URL clears the old one");
  assert.equal(targetUrlAfterPick("https://typed.example/x", a, undefined), "https://typed.example/x");
  assert.equal(targetUrlAfterPick("https://typed.example/x", undefined, undefined), "https://typed.example/x");
});

const sql = readFileSync(new URL("../../../supabase/migrations/0012_costs_improvements_revenue_period.sql", import.meta.url), "utf8");

test("a task needs evidence, a target, an observation period, an assignee and a review date", () => {
  assert.equal(parseImprovement(valid).evidence, "CTR 0.4%");
  const bad = [
    { ...valid, articleId: "x" },
    { ...valid, targetUrl: "" },
    { ...valid, targetUrl: "javascript:alert(1)" },
    { ...valid, targetUrl: `https://x.example/${"a".repeat(2000)}` },
    { ...valid, evidence: "   " },
    { ...valid, evidence: "x".repeat(2001) },
    { ...valid, observedFrom: "" },
    { ...valid, observedFrom: "2026-11-01" },
    { ...valid, observedTo: "2026-02-30" },
    { ...valid, assigneeId: "" },
    { ...valid, reviewAt: "" },
    null,
  ];
  for (const b of bad) assert.throws(() => parseImprovement(b), JSON.stringify(b)?.slice(0, 60));
});

test("workspace, author and result are never taken from the browser", () => {
  const db = toDbImprovement(
    parseImprovement({ ...valid, workspace_id: "other", created_by: "other", state: "done", resultVersion: 9, effect: "CTR up" }),
    "ws", "user",
  );
  assert.equal(db.workspace_id, "ws");
  assert.equal(db.created_by, "user");
  assert.ok(!("state" in db));
  assert.ok(!("result_version" in db));
  assert.ok(!JSON.stringify(db).includes("CTR up"));
});

test("progress updates validate the state and require a version to finish", () => {
  const base = { id: A, assigneeId: U };
  assert.deepEqual(parseImprovementUpdate({ ...base, state: "in_progress", resultVersion: "" }), {
    ...base, state: "in_progress", resultVersion: null,
  });
  assert.equal(parseImprovementUpdate({ ...base, state: "done", resultVersion: "3" }).resultVersion, 3);
  const bad = [
    { ...base, state: "done" },
    { ...base, state: "done", resultVersion: "" },
    { ...base, state: "open", resultVersion: "1.5" },
    { ...base, state: "open", resultVersion: 0 },
    { ...base, state: "shipped" },
    { ...base, state: "open", id: "x" },
    { ...base, state: "open", assigneeId: "" },
  ];
  for (const b of bad) assert.throws(() => parseImprovementUpdate(b), JSON.stringify(b));
});

test("the queue stores no outcome claim and no publishing hook", () => {
  const table = sql.split("create table improvement_tasks")[1].split(");")[0];
  assert.doesNotMatch(table, /effect|uplift|impact|publish/i);
});

test("states match the database and viewers can only read", () => {
  const listed = sql.match(/state in \(([^)]*)\)/)![1];
  assert.deepEqual([...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), [...improvementStates].sort());
  assert.deepEqual(roles.filter((r) => canManageImprovements(r)), ["owner", "admin", "editor", "reviewer"]);
});

test("only unfinished tasks past their review date are overdue", () => {
  assert.equal(isOverdue({ state: "open", reviewAt: "2026-11-01" }, "2026-11-02"), true);
  assert.equal(isOverdue({ state: "in_progress", reviewAt: "2026-11-02" }, "2026-11-02"), false);
  assert.equal(isOverdue({ state: "done", reviewAt: "2026-11-01" }, "2026-11-02"), false);
  assert.equal(isOverdue({ state: "cancelled", reviewAt: "2026-11-01" }, "2026-11-02"), false);
});

test("database rows map back and foreign key refusals get their own message", () => {
  const t = dbToImprovement({
    id: "1", article_id: A, target_url: "https://x", evidence: "e", observed_from: "2026-10-01", observed_to: "2026-10-02",
    assignee_id: null, review_at: "2026-12-01", state: "open", result_version: null, created_at: "c", updated_at: "u",
  });
  assert.equal(t.assigneeId, null);
  assert.equal(t.articleId, A);
  assert.equal(improvementError({ code: "23503" })?.status, 422);
  assert.equal(improvementError({ code: "23514" }), null);
});

test("local mode shows the account-only empty state", () => {
  const html = renderToStaticMarkup(createElement(ImprovementQueue, { account: false, articles: [] }));
  assert.match(html, /계정 모드에서 사용 가능/);
  assert.doesNotMatch(html, /<form/);
});
