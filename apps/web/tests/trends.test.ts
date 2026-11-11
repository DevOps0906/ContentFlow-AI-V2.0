import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_CATEGORIES,
  analyzeTrends,
  categoryValue,
  dbToTrend,
  ideaBlogId,
  importTrends,
  latestTrends,
  NO_SPREAD_SCORE,
  parseTrendBatch,
  periodStart,
  scoreTrends,
  TREND_COLUMNS,
  TREND_CONFLICT,
  TREND_LIMITS,
  trendBars,
  trendCategories,
  trendFromForm,
  trendInsights,
  trendsToDbRows,
  type KeywordTrend,
} from "../src/lib/trends";
import { ALL_BLOGS, UNCLASSIFIED_BLOGS, type Blog } from "../src/lib/blogs";
import { CategoryBars, TrendsView, TrendTable } from "../src/components/trends";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../../../supabase/migrations/0016_keyword_trends.sql");
const NOW = new Date("2026-11-11T12:00:00Z");
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";

let seq = 0;
const trend = (over: Partial<KeywordTrend> = {}): KeywordTrend => ({
  id: `t${++seq}`,
  blogId: B1,
  keyword: `키워드${seq}`,
  category: "여행",
  monthlySearches: 1000,
  growthPct: 10,
  documentCount: 500,
  source: "블랙키위",
  measuredOn: "2026-11-01",
  ...over,
});
const opts = { blogId: B1, source: "블랙키위", measuredOn: "2026-11-01", now: NOW };

test("limits and conflict columns match the migration", () => {
  assert.match(migration, new RegExp(`growth_pct between ${TREND_LIMITS.growthMin} and ${TREND_LIMITS.growthMax}`));
  assert.match(migration, new RegExp(`length\\(btrim\\(keyword\\)\\) between 1 and ${TREND_LIMITS.keyword}`));
  assert.match(migration, new RegExp(`length\\(btrim\\(category\\)\\) <= ${TREND_LIMITS.category}`));
  assert.match(migration, new RegExp(`length\\(btrim\\(source\\)\\) between 1 and ${TREND_LIMITS.source}`));
  assert.match(migration, new RegExp(`unique nulls not distinct \\(${TREND_CONFLICT.split(",").join(", ")}\\)`));
  for (const c of TREND_COLUMNS.split(",")) assert.match(migration, new RegExp(`\\n  ${c} `), c);
});

test("CSV values: blanks and N/A stay missing, zero stays zero, signs and percent are read", () => {
  const csv = "키워드,카테고리,월간 검색량,검색 증가율,문서 수\n제주 여행,여행,\"12,000\",-3.456%,0\n부산 맛집,맛집,,N/A,7\n";
  const r = importTrends(csv, [], opts);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.added, 2);
  assert.deepEqual(r.rows[0], {
    blogId: B1, keyword: "제주 여행", category: "여행", monthlySearches: 12000, growthPct: -3.46, documentCount: 0, source: "블랙키위", measuredOn: "2026-11-01",
  });
  assert.deepEqual([r.rows[1].monthlySearches, r.rows[1].growthPct, r.rows[1].documentCount], [null, null, 7]);
});

test("CSV rows with no value, bad numbers or bad dates are reported by line", () => {
  const csv = [
    "keyword,volume,growth,documents,date",
    "a,,,,2026-11-01",
    "b,1.5,1,1,2026-11-01",
    "c,1,-101,1,2026-11-01",
    "d,1,1,1,2026-12-30",
    ",1,1,1,2026-11-01",
    "e,1,1,1,",
  ].join("\n");
  const r = importTrends(csv, [], opts);
  assert.deepEqual(r.invalid.map((i) => i.line), [2, 3, 4, 5, 6]);
  assert.equal(r.rows[0].measuredOn, "2026-11-01"); // a blank date cell takes the form date
  assert.throws(() => importTrends("volume\n1", [], opts), /키워드/);
  assert.throws(() => importTrends("keyword,category\na,b", [], opts), /하나 이상/);
});

test("importing the same file again adds nothing, and changed values keep the stored ones", () => {
  const csv = "keyword,volume,growth,documents\n제주 여행,100,5,10\n제주  여행,100,5,10\n";
  const first = importTrends(csv, [], opts);
  assert.equal(first.added, 1);
  assert.equal(first.duplicates, 1); // the same keyword twice in one file
  const stored = first.rows.map((t, i) => ({ ...t, id: `s${i}` }));
  const again = importTrends(csv, stored, opts);
  assert.deepEqual([again.added, again.duplicates, again.conflicts, again.rows.length], [0, 2, 0, 0]);
  const changed = importTrends("keyword,volume\n제주 여행,999\n", [{ ...stored[0], growthPct: null, documentCount: null }], opts);
  assert.deepEqual([changed.added, changed.conflicts], [0, 1]);
  // another account, tool or date is another measurement
  assert.equal(importTrends(csv, stored, { ...opts, blogId: null }).added, 1);
  assert.equal(importTrends(csv, stored, { ...opts, source: "다른 도구" }).added, 1);
  assert.equal(importTrends(csv, stored, { ...opts, measuredOn: "2026-11-02" }).added, 1);
});

test("a hand-typed row keeps blank numbers missing and needs one value", () => {
  const base = { blogId: null, keyword: " 캠핑 ", category: "", monthlySearches: "", growthPct: "0", documentCount: "", source: "도구", measuredOn: "2026-11-01" };
  const row = trendFromForm(base, NOW);
  assert.deepEqual([row.keyword, row.monthlySearches, row.growthPct, row.documentCount], ["캠핑", null, 0, null]);
  assert.throws(() => trendFromForm({ ...base, growthPct: "" }, NOW), /하나 이상/);
  assert.throws(() => trendFromForm({ ...base, source: " " }, NOW), /출처/);
  assert.throws(() => trendFromForm({ ...base, measuredOn: "2026-12-31" }, NOW), /측정일/);
});

test("the server checks every row and drops unknown fields", () => {
  const ok = { blogId: B1, keyword: "a", category: "", monthlySearches: 1, growthPct: null, documentCount: null, source: "s", measuredOn: "2026-11-01" };
  const [row] = parseTrendBatch({ rows: [{ ...ok, workspace_id: B2, created_by: B2, id: B2 }] }, NOW);
  assert.deepEqual(row, ok);
  const db = trendsToDbRows([row], "ws", "user")[0];
  assert.equal(db.workspace_id, "ws");
  assert.equal(db.created_by, "user");
  for (const bad of [
    { ...ok, blogId: "x" },
    { ...ok, blogId: undefined },
    { ...ok, monthlySearches: -1 },
    { ...ok, monthlySearches: 1.5 },
    { ...ok, monthlySearches: "1" },
    { ...ok, monthlySearches: undefined },
    { ...ok, growthPct: Number.NaN },
    { ...ok, monthlySearches: null },
    { ...ok, keyword: " " },
    { ...ok, measuredOn: "2027-01-01" },
  ])
    assert.throws(() => parseTrendBatch({ rows: [bad] }, NOW), JSON.stringify(bad));
  assert.throws(() => parseTrendBatch({ rows: [] }, NOW));
  assert.throws(() => parseTrendBatch({ rows: Array(1001).fill(ok) }, NOW));
});

test("stored numbers come back as numbers and missing values as null", () => {
  const t = dbToTrend({
    id: "i", blog_id: null, keyword: "k", category: "", monthly_searches: "1200", growth_pct: "-3.50", document_count: null, source: "s", measured_on: "2026-11-01",
  });
  assert.deepEqual([t.monthlySearches, t.growthPct, t.documentCount, t.blogId], [1200, -3.5, null, null]);
});

test("the score follows the weights within one group", () => {
  const a = trend({ keyword: "a", growthPct: 0, monthlySearches: 0, documentCount: 100 });
  const b = trend({ keyword: "b", growthPct: 50, monthlySearches: 500, documentCount: 50 });
  const c = trend({ keyword: "c", growthPct: 100, monthlySearches: 1000, documentCount: 0 });
  const g = trend({ keyword: "g", growthPct: 100, monthlySearches: 0, documentCount: 100 });
  const s = new Map(scoreTrends([a, b, c, g]).map((t) => [t.keyword, t]));
  assert.equal(s.get("c")!.score, 100);
  assert.equal(s.get("a")!.score, 0);
  assert.equal(s.get("b")!.score, 50);
  assert.equal(s.get("g")!.score, 40); // growth only: its 0.4 weight
  assert.deepEqual(["c", "b", "g", "a"].map((k) => s.get(k)!.rank), [1, 2, 3, 4]);
});

test("one row or equal values give the neutral score instead of dividing by zero", () => {
  const [only] = scoreTrends([trend({ growthPct: 7, monthlySearches: 3, documentCount: 9 })]);
  assert.equal(only.score, NO_SPREAD_SCORE);
  assert.equal(only.rank, 1);
  const same = scoreTrends([trend({ keyword: "x" }), trend({ keyword: "y" })]);
  assert.deepEqual(same.map((t) => [t.score, t.rank]), [[50, 1], [50, 1]]);
  // only the document count is flat: it contributes its neutral half
  const part = new Map(scoreTrends([trend({ keyword: "lo", growthPct: 0, monthlySearches: 0 }), trend({ keyword: "hi", growthPct: 10, monthlySearches: 10 })]).map((t) => [t.keyword, t.score]));
  assert.equal(part.get("hi"), 85);
  assert.equal(part.get("lo"), 15);
  for (const t of scoreTrends([trend({ growthPct: -100 }), trend({ growthPct: 1_000_000 })])) assert.ok(t.score! >= 0 && t.score! <= 100);
});

test("a missing input makes the score N/A and does not move the scale of the others", () => {
  const rows = [
    trend({ keyword: "a", monthlySearches: 0 }),
    trend({ keyword: "b", monthlySearches: 100 }),
    trend({ keyword: "gap", monthlySearches: 1_000_000, growthPct: null }),
  ];
  const s = new Map(scoreTrends(rows).map((t) => [t.keyword, t]));
  assert.equal(s.get("gap")!.score, null);
  assert.equal(s.get("gap")!.rank, null);
  assert.deepEqual(s.get("gap")!.missing, ["검색 증가율"]);
  assert.equal(s.get("b")!.score, 65); // 0.4×50 + 0.3×100 + 0.3×50
  assert.equal(s.get("a")!.score, 35);
  assert.equal(scoreTrends(rows).at(-1)!.keyword, "gap"); // N/A rows come last
  // zero is a value, not a gap
  assert.notEqual(scoreTrends([trend({ monthlySearches: 0, growthPct: 0, documentCount: 0 })])[0].score, null);
});

test("blogs, categories and tools are scored apart", () => {
  const rows = [
    trend({ keyword: "x", monthlySearches: 10 }),
    trend({ keyword: "y", monthlySearches: 20 }),
    trend({ keyword: "x", blogId: B2, monthlySearches: 1 }),
    trend({ keyword: "x", blogId: null, monthlySearches: 1 }),
    trend({ keyword: "x", category: "맛집", monthlySearches: 1 }),
    trend({ keyword: "x", source: "다른 도구", monthlySearches: 99999 }),
  ];
  const s = scoreTrends(rows);
  assert.equal(new Set(s.map((t) => t.group)).size, 5);
  assert.equal(s.filter((t) => t.rank === 1).length, 5);
  assert.equal(s.find((t) => t.source === "다른 도구")!.score, NO_SPREAD_SCORE);
});

test("only the latest measurement in the period counts", () => {
  const old = trend({ keyword: "k", measuredOn: "2026-08-01", monthlySearches: 1 });
  const fresh = trend({ keyword: " K ", measuredOn: "2026-11-01", monthlySearches: 2 });
  assert.deepEqual(latestTrends([old, fresh]).map((t) => t.id), [fresh.id]);
  assert.equal(periodStart("30", "2026-11-11"), "2026-10-13");
  assert.equal(periodStart("all", "2026-11-11"), null);
  const f = { blog: ALL_BLOGS, category: ALL_CATEGORIES, today: "2026-11-11" };
  assert.deepEqual(analyzeTrends([old], { ...f, period: "30" }), []);
  assert.equal(analyzeTrends([old], { ...f, period: "180" }).length, 1);
});

test("filters narrow by account, unclassified and category", () => {
  const rows = [trend({ blogId: B1 }), trend({ blogId: null, category: "" }), trend({ blogId: B2, category: "맛집" })];
  const f = { blog: ALL_BLOGS, category: ALL_CATEGORIES, period: "all" as const, today: "2026-11-11" };
  assert.equal(analyzeTrends(rows, f).length, 3);
  assert.deepEqual(analyzeTrends(rows, { ...f, blog: UNCLASSIFIED_BLOGS }).map((t) => t.blogId), [null]);
  assert.deepEqual(analyzeTrends(rows, { ...f, category: categoryValue(" 맛집 ") }).map((t) => t.blogId), [B2]);
  assert.deepEqual(trendCategories(rows).map((c) => c.label), ["맛집", "여행", "카테고리 없음"]);
  assert.deepEqual(trendCategories(rows, B1).map((c) => c.label), ["여행"]);
  // a category literally called "all" is not the "all" option
  assert.notEqual(categoryValue("all"), ALL_CATEGORIES);
});

test("insight cards show N/A without data and never compare different tools", () => {
  assert.deepEqual(trendInsights([]).map((i) => i.value), ["N/A", "N/A", "N/A"]);
  const one = scoreTrends([
    trend({ keyword: "fast", growthPct: 90, documentCount: 900 }),
    trend({ keyword: "quiet", growthPct: 1, documentCount: 3 }),
  ]);
  assert.deepEqual(trendInsights(one).map((i) => i.value), ["fast", "fast", "quiet"]);
  const mixed = scoreTrends([trend({ keyword: "a" }), trend({ keyword: "b", source: "다른 도구" })]);
  assert.deepEqual(trendInsights(mixed).map((i) => i.value), ["표 참고", "표 참고", "표 참고"]);
  const gaps = scoreTrends([trend({ growthPct: null, documentCount: null })]);
  assert.deepEqual(trendInsights(gaps).map((i) => i.value), ["N/A", "N/A", "N/A"]);
});

test("category bars average the scored rows and show N/A rather than zero", () => {
  const bars = trendBars(scoreTrends([
    trend({ keyword: "a", growthPct: 0 }),
    trend({ keyword: "b", growthPct: 10 }),
    trend({ keyword: "c", growthPct: null }),
    trend({ keyword: "d", category: "빈칸", documentCount: null }),
  ]));
  assert.deepEqual(bars.map((b) => [b.category, b.average, b.scored, b.total]), [["여행", 50, 2, 3], ["빈칸", null, 0, 1]]);
  const html = renderToStaticMarkup(createElement(CategoryBars, { bars, blogs: [], showBlog: true }));
  assert.match(html, /계정 정보 없음 · 빈칸 · 블랙키위/);
  assert.match(html, /N\/A/);
  assert.doesNotMatch(html, /width:0%/);
});

const blog = (id: string, status: Blog["status"]): Blog => ({ id, platform: "naver", domain: "a.example", displayName: "A", status, createdAt: "t" });

test("a new article takes over an active account only", () => {
  assert.equal(ideaBlogId(B1, [blog(B1, "active")]), B1);
  assert.equal(ideaBlogId(B1, [blog(B1, "archived")]), undefined);
  assert.equal(ideaBlogId(null, [blog(B1, "active")]), undefined);
});

test("the table labels every cell for the mobile card layout and shows N/A", () => {
  const rows = scoreTrends([trend({ keyword: "빈값", growthPct: null, monthlySearches: 0 })]);
  const props = { rows, blogs: [blog(B1, "active")], creating: null, onCreate: () => {}, onRemove: () => {} };
  const html = renderToStaticMarkup(createElement(TrendTable, { ...props, canWrite: true }));
  assert.equal((html.match(/data-label=/g) ?? []).length, 10);
  assert.match(html, /data-label="검색 증가율">N\/A</);
  assert.match(html, /data-label="월간 검색량">0</);
  assert.match(html, /data-label="기회 점수"[^>]*><b>N\/A<\/b>/);
  assert.match(html, /글 만들기/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TrendTable, { ...props, canWrite: false })), /글 만들기|삭제/);
});

test("local mode explains the account requirement and claims no connection", () => {
  const save = async () => { throw new Error("unused"); };
  const local = renderToStaticMarkup(createElement(TrendsView, { account: false, ready: true, save }));
  assert.match(local, /계정 모드에서 사용 가능/);
  assert.doesNotMatch(local, /연결됨/);
  const account = renderToStaticMarkup(createElement(TrendsView, { account: true, ready: true, save }));
  assert.match(account, /가설/);
  assert.match(account, /<label for="blog-filter">블로그 계정<\/label>/);
  assert.doesNotMatch(account, /연결됨/);
});

test("the menu links to the trends page", () => {
  assert.match(read("../src/components/shell.tsx"), /href: "\/trends", label: "트렌드 분석"/);
});
