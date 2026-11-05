import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importRevenue,
  pageSummaries,
  parseRevenue,
  summarize,
  formatMoney,
  type RevenueRow,
} from "../src/lib/revenue";
import type { Article } from "../src/lib/content";

const NOW = new Date("2026-11-06T00:00:00Z");
const opts = { source: "AdSense", status: "estimated" as const, currency: "krw", now: NOW };
const csv = (s: string) => s.trim().replace(/^ +/gm, "");

test("imports a report with Korean headers, thousands separators and a default currency", () => {
  const r = importRevenue(csv(`
    날짜,페이지,수익,조회수,클릭
    2026-11-01,https://blog.example/a/,"1,200.5","3,000",10
    2026/11/02,/b,300,,
  `), [], opts);
  assert.equal(r.added, 2);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.rows[0].revenue, 1200.5);
  assert.equal(r.rows[0].pageviews, 3000);
  assert.equal(r.rows[0].currency, "KRW");
  assert.equal(r.rows[1].date, "2026-11-02");
  // A blank cell is missing data, not zero.
  assert.equal(r.rows[1].pageviews, null);
  assert.equal(r.rows[1].clicks, null);
});

test("invalid rows are reported by line and do not abort the import", () => {
  const r = importRevenue(csv(`
    date,page,revenue
    2026-13-40,/a,10
    2026-11-01,/a,abc
    2026-11-01,/a,-5
    2026-12-31,/a,10
    2026-11-01,/ok,10
    2026-11-02,/empty,
  `), [], opts);
  assert.equal(r.added, 1);
  assert.deepEqual(r.invalid.map((i) => i.line), [2, 3, 4, 5, 7]);
});

test("headers, columns, source, status and currency are validated", () => {
  assert.throws(() => importRevenue("date,page\n2026-11-01,/a", [], opts), /열/);
  assert.throws(() => importRevenue("page,revenue\n/a,1", [], opts), /날짜/);
  assert.throws(() => importRevenue("date,revenue", [], opts), /데이터 행/);
  assert.throws(() => importRevenue("date,revenue\n2026-11-01,1", [], { ...opts, source: " " }));
  assert.throws(() => importRevenue("date,revenue\n2026-11-01,1", [], { ...opts, currency: "원" }));
  assert.throws(() => importRevenue("date,revenue\n2026-11-01,1", [], { ...opts, status: "x" as never }));
  assert.throws(() => importRevenue("x".repeat(2_000_001), [], opts));
});

test("re-importing the same report never double counts, even with different spelling of the page", () => {
  const first = importRevenue("date,page,revenue\n2026-11-01,https://Blog.example/a/,100", [], opts);
  const again = importRevenue("date,page,revenue\n2026-11-01,https://blog.example/a,100\n2026-11-02,https://blog.example/a,50", first.rows, opts);
  assert.equal(again.added, 1);
  assert.equal(again.duplicates, 1);
  assert.equal(summarize(again.rows)[0].revenue, 150);
  // Within one file too.
  const dup = importRevenue("date,revenue\n2026-11-01,1\n2026-11-01,1", [], opts);
  assert.equal(dup.added, 1);
  assert.equal(dup.duplicates, 1);
});

test("estimated and finalized, and different currencies, are never added together", () => {
  let rows: RevenueRow[] = importRevenue("date,revenue\n2026-11-01,100", [], opts).rows;
  rows = importRevenue("date,revenue\n2026-11-01,90", rows, { ...opts, status: "finalized" }).rows;
  rows = importRevenue("date,revenue\n2026-11-01,5", rows, { ...opts, currency: "USD" }).rows;
  const s = summarize(rows);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => [x.status, x.currency, x.revenue]).sort(), [
    ["estimated", "KRW", 100],
    ["estimated", "USD", 5],
    ["finalized", "KRW", 90],
  ]);
});

test("a site total and the page rows of the same day are never added together", () => {
  const r = importRevenue(csv(`
    date,page,revenue,pageviews
    2026-11-01,,1000,500
    2026-11-01,/a,600,300
    2026-11-01,/b,400,200
    2026-11-02,/a,50,25
    2026-11-02,/b,30,15
  `), [], opts);
  const [s] = summarize(r.rows);
  // Day 1 uses the site total only (1000); day 2 has no site row, so pages are used (80).
  assert.equal(s.revenue, 1080);
  assert.equal(s.pageviews, 540);
  assert.equal(s.siteDays, 1);
  assert.equal(s.pageDays, 1);
  assert.equal(s.days, 2);
});

test("RPM uses only rows with revenue and page views together, otherwise N/A", () => {
  const withBoth = summarize(importRevenue("date,revenue,pageviews\n2026-11-01,200,1000\n2026-11-02,100,1000", [], opts).rows)[0];
  assert.equal(withBoth.rpm, 150);
  // Revenue from a day without page views does not inflate RPM.
  const mixed = summarize(importRevenue("date,page,revenue,pageviews\n2026-11-01,/a,100,1000\n2026-11-02,/a,900,", [], opts).rows)[0];
  assert.equal(mixed.revenue, 1000);
  assert.equal(mixed.rpm, 100);
  assert.equal(summarize(importRevenue("date,revenue\n2026-11-01,100", [], opts).rows)[0].rpm, null);
  assert.equal(summarize(importRevenue("date,revenue,pageviews\n2026-11-01,100,0", [], opts).rows)[0].rpm, null);
});

test("missing totals stay N/A instead of 0", () => {
  const s = summarize(importRevenue("date,pageviews\n2026-11-01,100", [], opts).rows)[0];
  assert.equal(s.revenue, null);
  assert.equal(formatMoney(s.revenue, "KRW"), "N/A");
  assert.equal(formatMoney(1234.5, "USD"), "1,234.50 USD");
  assert.equal(formatMoney(1234.4, "KRW"), "1,234 KRW");
});

test("page revenue is linked to articles by WordPress URL and sorted by revenue", () => {
  const article = {
    id: "1", title: "글", keyword: "k", templateId: "T01", platform: "wordpress" as const, body: "b",
    sourceUrl: "https://s.example", status: "published" as const, updatedAt: "2026-11-01T00:00:00Z",
    remote: { postId: 1, url: "https://blog.example/hello/", syncedAt: "2026-11-01T00:00:00Z" },
  } as Article;
  const r = importRevenue("date,page,revenue\n2026-11-01,https://blog.example/hello,10\n2026-11-02,https://blog.example/hello/,5\n2026-11-01,https://blog.example/other,50\n2026-11-01,,999", [], opts);
  const pages = pageSummaries(r.rows, [article]);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].page, "https://blog.example/other");
  assert.equal(pages[0].article, null);
  assert.equal(pages[1].revenue, 15);
  assert.equal(pages[1].article?.id, "1");
});

test("stored revenue is validated and corrupt data is rejected, not replaced", () => {
  const rows = importRevenue("date,revenue\n2026-11-01,10", [], opts).rows;
  assert.deepEqual(parseRevenue(JSON.stringify(rows)), rows);
  assert.deepEqual(parseRevenue(null), []);
  assert.throws(() => parseRevenue("{bad"));
  assert.throws(() => parseRevenue(JSON.stringify([{ ...rows[0], revenue: -1 }])));
  assert.throws(() => parseRevenue(JSON.stringify([{ ...rows[0], status: "x" }])));
});