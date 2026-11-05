import { test } from "node:test";
import assert from "node:assert/strict";
import { dbToRevenue, parseRevenueBatch, toDbRows, MAX_ROWS_PER_REQUEST } from "../src/lib/revenue-db";
import { rowKey, type RevenueRow } from "../src/lib/revenue";

const row: RevenueRow = {
  source: "AdSense", status: "estimated", currency: "KRW", date: "2026-11-01",
  page: "https://Blog.example/a/", revenue: 100.5, pageviews: 300, impressions: null, clicks: null,
  importedAt: "2026-11-06T00:00:00Z",
};

test("the dedupe key is computed on the server from the row, not taken from the client", () => {
  const [db] = toDbRows(parseRevenueBatch({ rows: [{ ...row, row_key: "forged" }] }), "ws", "user");
  assert.equal(db.row_key, rowKey(row));
  assert.ok(!JSON.stringify(db).includes("forged"));
  assert.equal(db.workspace_id, "ws");
  assert.equal(db.created_by, "user");
  // same report row spelled differently gets the same key (so the DB skips it)
  assert.equal(toDbRows([{ ...row, page: "https://blog.example/a" }], "ws", "u")[0].row_key, db.row_key);
});

test("invalid batches are rejected with a message", () => {
  const bad = [
    null, {}, { rows: [] }, { rows: "x" },
    { rows: [{ ...row, status: "x" }] },
    { rows: [{ ...row, revenue: -1 }] },
    { rows: [{ ...row, date: "11/01" }] },
    { rows: [{ ...row, currency: "won" }] },
    { rows: [{ ...row, source: " " }] },
    { rows: [{ ...row, revenue: null, pageviews: null }] },
    { rows: [{ ...row, page: "x".repeat(501) }] },
    { rows: Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, () => row) },
  ];
  for (const b of bad) assert.throws(() => parseRevenueBatch(b), JSON.stringify(b)?.slice(0, 40));
  assert.equal(parseRevenueBatch({ rows: [row] }).length, 1);
});

test("database rows map back, numeric strings included, and missing stays null", () => {
  const out = dbToRevenue({
    source: "AdSense", status: "finalized", currency: "USD", report_date: "2026-11-01", page: "",
    revenue: "12.3400", pageviews: "500", impressions: null, clicks: null, created_at: "2026-11-06T00:00:00Z",
  });
  assert.equal(out.revenue, 12.34);
  assert.equal(out.pageviews, 500);
  assert.equal(out.impressions, null);
  assert.equal(out.date, "2026-11-01");
  assert.equal(out.importedAt, "2026-11-06T00:00:00Z");
});
