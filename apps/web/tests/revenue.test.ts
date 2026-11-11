import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importRevenue,
  pageSummaries,
  parseRevenue,
  summarize,
  formatMoney,
  findOverlap,
  normalizeTimezone,
  revenueSendNotice,
  sendRevenueChunks,
  type RevenueRow,
} from "../src/lib/revenue";
import type { Article } from "../src/lib/content";

const NOW = new Date("2026-11-06T00:00:00Z");
const opts = { source: "AdSense", status: "estimated" as const, currency: "krw", timezone: "Asia/Seoul", now: NOW };
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
  const again = importRevenue("date,page,revenue\n2026-11-01,https://blog.example/a,100", first.rows, opts);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(summarize(again.rows)[0].revenue, 100);
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

test("a confirmed public URL wins over a remote draft link, which stays a fallback", () => {
  const base = { id: "1", title: "글", keyword: "k", templateId: "T01", platform: "wordpress", body: "", sourceUrl: "", status: "published", updatedAt: "t" } as Article;
  const published = { ...base, id: "pub", publishedUrl: "https://blog.example/live", remote: { postId: 1, url: "https://blog.example/draft-a", syncedAt: "t" } } as Article;
  const draftOnly = { ...base, id: "draft", remote: { postId: 2, url: "https://blog.example/live", syncedAt: "t" } } as Article;
  const fallback = { ...base, id: "fallback", remote: { postId: 3, url: "https://blog.example/old", syncedAt: "t" } } as Article;
  const r = importRevenue("date,page,revenue\n2026-11-01,https://blog.example/live,10\n2026-11-01,https://blog.example/old,5", [], opts);
  for (const list of [[published, draftOnly, fallback], [draftOnly, published, fallback]]) {
    const pages = pageSummaries(r.rows, list);
    assert.equal(pages.find((p) => p.page.endsWith("/live"))?.article?.id, "pub");
    assert.equal(pages.find((p) => p.page.endsWith("/old"))?.article?.id, "fallback");
  }
});

test("page totals stay apart per source and name it", () => {
  let rows = importRevenue("date,page,revenue\n2026-11-01,/a,10", [], opts).rows;
  rows = importRevenue("date,page,revenue\n2026-11-01,/a,3", rows, { ...opts, source: "Kakao" }).rows;
  assert.deepEqual(pageSummaries(rows, []).map((p) => [p.source, p.revenue]), [["AdSense", 10], ["Kakao", 3]]);
});

test("a send that stops part way still refreshes and reports what was stored", async () => {
  const rows = importRevenue("date,revenue\n2026-11-01,1\n2026-11-02,2\n2026-11-03,3", [], opts).rows;
  let reloads = 0;
  const sent: number[] = [];
  const r = await sendRevenueChunks(
    rows,
    async (chunk) => {
      sent.push(chunk.length);
      if (sent.length === 2) throw new Error("두 번째 묶음 실패");
      return { added: 2, duplicates: 0 };
    },
    async () => void reloads++,
    2,
  );
  assert.deepEqual(sent, [2, 1]);
  assert.equal(reloads, 1);
  assert.deepEqual(r, { added: 2, duplicates: 0, failure: "두 번째 묶음 실패", reloaded: true });
  assert.match(revenueSendNotice(r), /두 번째 묶음 실패 저장이 확인된 행은 2행/);
  assert.match(revenueSendNotice(r), /다시 가져오면/);
});

test("a send notice is empty on success and honest when nothing was stored or the refresh failed", async () => {
  const ok = await sendRevenueChunks([], async () => ({}), async () => ({}));
  assert.deepEqual(ok, { added: 0, duplicates: 0, failure: null, reloaded: true });
  assert.equal(revenueSendNotice(ok), "");
  const refused = revenueSendNotice({ added: 0, duplicates: 0, failure: "기간 겹침", reloaded: true });
  assert.match(refused, /0행/);
  assert.doesNotMatch(refused, /다시 가져오면/);
  const stale = await sendRevenueChunks([], async () => ({}), async () => {
    throw new Error("x");
  });
  assert.match(revenueSendNotice(stale), /새로고침/);
});

test("stored revenue is validated and corrupt data is rejected, not replaced", () => {
  const rows = importRevenue("date,revenue\n2026-11-01,10", [], opts).rows;
  assert.deepEqual(parseRevenue(JSON.stringify(rows)), rows);
  assert.deepEqual(parseRevenue(null), []);
  assert.throws(() => parseRevenue("{bad"));
  assert.throws(() => parseRevenue(JSON.stringify([{ ...rows[0], revenue: -1 }])));
  assert.throws(() => parseRevenue(JSON.stringify([{ ...rows[0], status: "x" }])));
});

const report = "date,page,revenue\n2026-11-01,,100\n2026-11-05,,50";

test("the time zone and the file's whole period are kept on every row", () => {
  const r = importRevenue(report, [], opts);
  assert.deepEqual(r.rows.map((x) => [x.date, x.timezone, x.periodStart, x.periodEnd]), [
    ["2026-11-01", "Asia/Seoul", "2026-11-01", "2026-11-05"],
    ["2026-11-05", "Asia/Seoul", "2026-11-01", "2026-11-05"],
  ]);
  assert.throws(() => importRevenue(report, [], { ...opts, timezone: "Mars/Base" }), /시간대/);
  assert.throws(() => importRevenue(report, [], { ...opts, timezone: " " }), /시간대/);
  assert.equal(normalizeTimezone("not a zone"), null);
  // Invalid lines do not stretch the period.
  const trimmed = importRevenue("date,revenue\n2026-11-02,1\n2026-11-03,x", [], opts);
  assert.equal(trimmed.rows[0].periodEnd, "2026-11-02");
});

test("re-importing the identical period is skipped and changes nothing", () => {
  const first = importRevenue(report, [], opts);
  const again = importRevenue(report, first.rows, opts);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 2);
  assert.equal(again.conflicts, 0);
  assert.equal(again.rows.length, 2);
  assert.equal(summarize(again.rows)[0].revenue, 150);
});

test("the same period with different values keeps the stored value and says so", () => {
  const first = importRevenue(report, [], opts);
  const changed = importRevenue("date,page,revenue\n2026-11-01,,999\n2026-11-05,,50", first.rows, opts);
  assert.equal(changed.added, 0);
  assert.equal(changed.duplicates, 1);
  assert.equal(changed.conflicts, 1);
  assert.equal(summarize(changed.rows)[0].revenue, 150);
});

test("a partly overlapping period is refused as a whole, nothing is added", () => {
  const first = importRevenue(report, [], opts);
  const overlaps = [
    "date,page,revenue\n2026-11-04,,1\n2026-11-06,,1", // extends past the end
    "date,page,revenue\n2026-10-30,,1\n2026-11-01,,1", // touches the first day
    "date,page,revenue\n2026-11-02,,1\n2026-11-03,,1", // inside
    "date,page,revenue\n2026-10-30,,1\n2026-11-06,,1", // encloses
  ];
  for (const csvText of overlaps) assert.throws(() => importRevenue(csvText, first.rows, opts), /일부만 겹쳐/);
  assert.equal(first.rows.length, 2);
});

test("adjacent periods and different reports are not an overlap", () => {
  const first = importRevenue(report, [], opts).rows;
  const adjacent = "date,page,revenue\n2026-11-06,,1";
  assert.equal(importRevenue(adjacent, first, opts).added, 1);
  const inside = "date,page,revenue\n2026-11-02,,1";
  assert.equal(importRevenue(inside, first, { ...opts, status: "finalized" }).added, 1);
  assert.equal(importRevenue(inside, first, { ...opts, currency: "USD" }).added, 1);
  assert.equal(importRevenue(inside, first, { ...opts, source: "Other" }).added, 1);
  assert.equal(importRevenue(inside, first, { ...opts, timezone: "UTC" }).added, 1);
  // A page report over the same days is a different report from the site total.
  assert.equal(importRevenue("date,page,revenue\n2026-11-02,/a,1", first, opts).added, 1);
  // The source name is matched without regard to case.
  assert.throws(() => importRevenue(inside, first, { ...opts, source: "adsense" }), /일부만 겹쳐/);
});

test("different time zones are never added together", () => {
  let rows = importRevenue("date,revenue\n2026-11-01,100", [], opts).rows;
  rows = importRevenue("date,revenue\n2026-11-01,70", rows, { ...opts, timezone: "UTC" }).rows;
  const s = summarize(rows);
  assert.deepEqual(s.map((x) => [x.timezone, x.revenue]), [["Asia/Seoul", 100], ["UTC", 70]]);
  rows = importRevenue("date,page,revenue\n2026-11-02,/a,1", [], opts).rows;
  rows = importRevenue("date,page,revenue\n2026-11-02,/a,2", rows, { ...opts, timezone: "UTC" }).rows;
  assert.deepEqual(pageSummaries(rows, []).map((p) => p.revenue).sort(), [1, 2]);
});

test("older rows with no recorded time zone stay unknown and block overlapping dates", () => {
  const legacy = { source: "AdSense", status: "estimated", currency: "KRW", date: "2026-11-02", page: "", revenue: 7, pageviews: null, impressions: null, clicks: null, importedAt: "2026-11-03T00:00:00Z" };
  const [read] = parseRevenue(JSON.stringify([legacy]));
  assert.equal(read.timezone, null);
  assert.equal(read.periodStart, null);
  assert.equal(summarize([read])[0].timezone, null);
  assert.throws(() => importRevenue(report, [read], opts), /기록이 없는/);
  // Outside its date there is nothing to confuse.
  assert.equal(importRevenue("date,revenue\n2026-11-03,1", [read], opts).added, 1);
  assert.equal(findOverlap([read], [{ source: "x", status: "estimated", currency: "KRW", page: "" }], { timezone: "UTC", periodStart: "2026-11-02", periodEnd: "2026-11-02" }), null);
});
