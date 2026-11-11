import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COST_ENTRY_DIGITS,
  RUN_ESTIMATE_DIGITS,
  costCategories,
  dbToCost,
  localDay,
  parseCostEntry,
  saveCostEntry,
  summarizeCosts,
  summarizeRunEstimates,
  toDbCost,
  type AgentRunCostRow,
} from "../src/lib/costs";
import { formatMoney } from "../src/lib/revenue";
import { canRecordCosts, roles } from "../src/lib/team";
import { CostLedger } from "../src/components/cost-ledger";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-11-06T00:00:00Z");
const valid = { category: "hosting", amount: "1,200.5", currency: "usd", occurredOn: "2026-11-01", note: " 서버 " };
const sql = readFileSync(new URL("../../../supabase/migrations/0012_costs_improvements_revenue_period.sql", import.meta.url), "utf8");

test("a cost entry is validated and normalized", () => {
  assert.deepEqual(parseCostEntry(valid, NOW), {
    category: "hosting", amount: 1200.5, currency: "USD", occurredOn: "2026-11-01", note: "서버",
  });
  const bad = [
    { ...valid, category: "x" },
    { ...valid, amount: "" },
    { ...valid, amount: "0" },
    { ...valid, amount: "-1" },
    { ...valid, amount: "1.23456" },
    { ...valid, amount: "1e3" },
    { ...valid, currency: "원" },
    { ...valid, occurredOn: "2026-13-01" },
    { ...valid, occurredOn: "2026-02-30" },
    { ...valid, occurredOn: "2026-12-31" },
    { ...valid, note: "x".repeat(501) },
    null,
  ];
  for (const b of bad) assert.throws(() => parseCostEntry(b, NOW), JSON.stringify(b)?.slice(0, 40));
});

test("author and workspace come from the session; provenance and AI links can not be supplied", () => {
  const db = toDbCost(
    parseCostEntry({ ...valid, provenance: "model", agent_run_id: "x", workspace_id: "other", created_by: "other" }, NOW),
    "ws", "user",
  );
  assert.equal(db.workspace_id, "ws");
  assert.equal(db.created_by, "user");
  assert.ok(!("provenance" in db));
  assert.ok(!JSON.stringify(db).includes("agent_run"));
  assert.ok(!/agent_run_id/.test(sql.split("create table cost_entries")[1].split(");")[0]), "ledger table has no AI link");
});

test("totals never mix currencies and an empty ledger has no total", () => {
  assert.deepEqual(summarizeCosts([]), []);
  assert.deepEqual(
    summarizeCosts([
      { amount: 10.5, currency: "USD" },
      { amount: 1000, currency: "KRW" },
      { amount: 0.1, currency: "USD" },
      { amount: 0.2, currency: "USD" },
    ]),
    [
      { currency: "KRW", total: 1000, count: 1 },
      { currency: "USD", total: 10.8, count: 3 },
    ],
  );
});

test("AI call estimates stay apart: they are not ledger totals and unpriced calls are not 0", () => {
  const runs: AgentRunCostRow[] = [
    { id: "1", cost_estimate: "0.5", cost_currency: "USD" },
    { id: "2", cost_estimate: 0.25, cost_currency: "USD" },
    { id: "3", cost_estimate: 100, cost_currency: "KRW" },
    { id: "4", cost_estimate: null, cost_currency: null },
  ];
  const ledger = [{ amount: 10, currency: "USD" }];
  const estimates = summarizeRunEstimates(runs);
  assert.deepEqual(estimates, {
    runs: 4,
    unpriced: 1,
    byCurrency: [
      { currency: "KRW", total: 100, count: 1 },
      { currency: "USD", total: 0.75, count: 2 },
    ],
  });
  // The ledger total is the manual amount alone, however many runs exist.
  assert.deepEqual(summarizeCosts(ledger), [{ currency: "USD", total: 10, count: 1 }]);
  assert.deepEqual(summarizeRunEstimates([]), { runs: 0, unpriced: 0, byCurrency: [] });
});

test("database rows map back, numeric strings included", () => {
  const c = dbToCost({
    id: "1", category: "model", amount: "12.5000", currency: "USD", occurred_on: "2026-11-01", note: null, created_at: "t",
  });
  assert.equal(c.amount, 12.5);
  assert.equal(c.occurredOn, "2026-11-01");
  assert.equal(c.note, null);
});

test("categories match the database, and only owner/admin record costs", () => {
  const listed = sql.match(/category in \(([^)]*)\)/)![1];
  assert.deepEqual([...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), [...costCategories].sort());
  assert.deepEqual(roles.filter((r) => canRecordCosts(r)), ["owner", "admin"]);
});

test("today is the operator's local date, not the UTC date", () => {
  assert.equal(localDay(new Date(2026, 10, 12, 0, 30)), "2026-11-12");
  assert.equal(localDay(new Date(2026, 10, 12, 23, 30)), "2026-11-12");
  assert.equal(localDay(new Date(2026, 0, 5, 12)), "2026-01-05");
});

function costSteps(save: () => Promise<unknown>, reload: () => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      save: () => (calls.push("save"), save()),
      clearForm: () => void calls.push("clear"),
      reload: () => (calls.push("reload"), reload()),
    },
  };
}

test("a refresh that fails after a stored cost clears the form and does not read as a failed save", async () => {
  const { calls, steps } = costSteps(async () => ({}), async () => {
    throw new Error("원가 정보를 불러오지 못했습니다.");
  });
  const message = await saveCostEntry(steps);
  assert.deepEqual(calls, ["save", "clear", "reload"]);
  assert.match(message, /^기록했지만/);
  assert.match(message, /다시 입력하지/);
});

test("a refused save keeps the form and does not refresh", async () => {
  const { calls, steps } = costSteps(async () => {
    throw new Error("저장 거절");
  }, async () => ({}));
  assert.equal(await saveCostEntry(steps), "저장 거절");
  assert.deepEqual(calls, ["save"]);
});

test("a stored cost clears the form and refreshes", async () => {
  const { calls, steps } = costSteps(async () => ({}), async () => ({}));
  assert.equal(await saveCostEntry(steps), "기록했어요.");
  assert.deepEqual(calls, ["save", "clear", "reload"]);
});

test("costs keep the stored precision so a small amount is not shown as 0", () => {
  assert.equal(formatMoney(0.0004, "USD", COST_ENTRY_DIGITS), "0.0004 USD");
  assert.equal(formatMoney(0.4, "KRW", COST_ENTRY_DIGITS), "0.4 KRW");
  assert.equal(formatMoney(0.00000123, "USD", RUN_ESTIMATE_DIGITS), "0.00000123 USD");
  assert.equal(formatMoney(12.5, "USD", COST_ENTRY_DIGITS), "12.50 USD");
  assert.equal(formatMoney(1000, "KRW", COST_ENTRY_DIGITS), "1,000 KRW");
  assert.equal(formatMoney(0.4, "KRW"), "0 KRW", "revenue screens keep their rounding");
});

test("local mode shows the account-only empty state and does not load", () => {
  const html = renderToStaticMarkup(createElement(CostLedger, { account: false }));
  assert.match(html, /계정 모드에서 사용 가능/);
  assert.doesNotMatch(html, /<form/);
});
