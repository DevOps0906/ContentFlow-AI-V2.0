import { test } from "node:test";
import assert from "node:assert/strict";
import { dbToRevenue, parseRevenueBatch, toDbRows, MAX_ROWS_PER_REQUEST } from "../src/lib/revenue-db";
import { rowKey, type RevenueRow } from "../src/lib/revenue";

const row: RevenueRow = {
  source: "AdSense", status: "estimated", currency: "KRW", date: "2026-11-01",
  page: "https://Blog.example/a/", revenue: 100.5, pageviews: 300, impressions: null, clicks: null,
  importedAt: "2026-11-06T00:00:00Z",
  timezone: "Asia/Seoul", periodStart: "2026-11-01", periodEnd: "2026-11-02",
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
    { rows: [{ ...row, timezone: null }] },
    { rows: [{ ...row, timezone: "Mars/Base" }] },
    { rows: [{ ...row, periodStart: null }] },
    { rows: [{ ...row, periodEnd: "11/02" }] },
    { rows: [{ ...row, periodStart: "2026-11-03", periodEnd: "2026-11-02" }] },
    { rows: [{ ...row, date: "2026-10-31" }] },
    { rows: Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, () => row) },
  ];
  for (const b of bad) assert.throws(() => parseRevenueBatch(b), JSON.stringify(b)?.slice(0, 40));
  assert.equal(parseRevenueBatch({ rows: [row] }).length, 1);
});

test("database rows map back, numeric strings included, and missing stays null", () => {
  const out = dbToRevenue({
    source: "AdSense", status: "finalized", currency: "USD", report_date: "2026-11-01", page: "",
    revenue: "12.3400", pageviews: "500", impressions: null, clicks: null, created_at: "2026-11-06T00:00:00Z",
    timezone: "UTC", period_start: "2026-11-01", period_end: "2026-11-30",
  });
  assert.equal(out.revenue, 12.34);
  assert.equal(out.pageviews, 500);
  assert.equal(out.impressions, null);
  assert.equal(out.date, "2026-11-01");
  assert.equal(out.importedAt, "2026-11-06T00:00:00Z");
  assert.deepEqual([out.timezone, out.periodStart, out.periodEnd], ["UTC", "2026-11-01", "2026-11-30"]);
});

test("the time zone and period reach the database row and the key", () => {
  const [db] = toDbRows(parseRevenueBatch({ rows: [row] }), "ws", "u");
  assert.deepEqual([db.timezone, db.period_start, db.period_end], ["Asia/Seoul", "2026-11-01", "2026-11-02"]);
  assert.notEqual(db.row_key, toDbRows([{ ...row, timezone: "UTC" }], "ws", "u")[0].row_key);
});
