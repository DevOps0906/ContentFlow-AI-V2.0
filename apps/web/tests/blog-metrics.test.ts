import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dbToMetric,
  importGsc,
  indexSeries,
  METRIC_COLUMNS,
  METRIC_CONFLICT,
  METRIC_LIMITS,
  MAX_METRICS,
  METRIC_TOOLS,
  metricKey,
  metricRowKey,
  trimSpaces,
  metricFromForm,
  parseMetricBatch,
  TOOL_INFO,
  toolGroupsFor,
  toolSummary,
  type MetricSnapshot,
} from "../src/lib/blog-metrics";
import { ALL_BLOGS, UNCLASSIFIED_BLOGS, type Blog } from "../src/lib/blogs";
import { chunkList } from "../src/lib/revenue";
import { BlogMetrics, IndexTrend, MetricTable, ToolBundles } from "../src/components/blog-metrics";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../../../supabase/migrations/0017_blog_metric_snapshots.sql");
const NOW = new Date("2026-11-11T12:00:00Z");
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const blog = (id: string, platform: Blog["platform"]): Blog => ({ id, platform, domain: `${id.slice(0, 4)}.example`, displayName: null, status: "active", createdAt: "t" });

let seq = 0;
const snap = (over: Partial<MetricSnapshot> = {}): MetricSnapshot => ({
  id: `m${String(++seq).padStart(3, "0")}`,
  blogId: B1,
  tool: "bseupi",
  metric: "블로그지수",
  scope: "site",
  dimension: "",
  value: null,
  valueLabel: "준최4",
  unit: "",
  measuredOn: "2026-11-01",
  evidenceUrl: null,
  memo: "",
  ...over,
});
const opts = { blogId: B1, measuredOn: "2026-11-10", evidenceUrl: null, now: NOW };

test("tools, limits and conflict columns match the migration", () => {
  assert.match(migration, new RegExp(`tool in \\(${METRIC_TOOLS.map((t) => `'${t}'`).join(", ")}\\)`));
  assert.match(migration, new RegExp(`length\\(btrim\\(metric\\)\\) between 1 and ${METRIC_LIMITS.metric}`));
  assert.match(migration, new RegExp(`length\\(dimension\\) <= ${METRIC_LIMITS.dimension}`));
  assert.match(migration, new RegExp(`length\\(btrim\\(value_label\\)\\) between 1 and ${METRIC_LIMITS.valueLabel}`));
  assert.match(migration, new RegExp(`length\\(unit\\) <= ${METRIC_LIMITS.unit}`));
  assert.match(migration, new RegExp(`length\\(memo\\) <= ${METRIC_LIMITS.memo}`));
  assert.match(migration, new RegExp(`length\\(evidence_url\\) <= ${METRIC_LIMITS.url}`));
  assert.match(migration, new RegExp(`value between -${METRIC_LIMITS.valueAbs} and ${METRIC_LIMITS.valueAbs}`));
  assert.match(migration, new RegExp(`unique nulls not distinct \\(${METRIC_CONFLICT.split(",").join(", ")}\\)`));
  for (const c of METRIC_COLUMNS.split(",")) assert.match(migration, new RegExp(`\\n  ${c} `), c);
});

test("tools are grouped by platform and only shortcuts carry a link", () => {
  const blogs = [blog(B1, "naver"), blog(B2, "tistory")];
  assert.deepEqual(toolGroupsFor(B1, blogs).map((g) => g.tools), [["bseupi", "blackkiwi", "blogai"]]);
  assert.deepEqual(toolGroupsFor(B2, blogs).map((g) => g.tools), [["gsc", "ubersuggest", "clarity"]]);
  assert.equal(toolGroupsFor(ALL_BLOGS, blogs).length, 2);
  assert.equal(toolGroupsFor(UNCLASSIFIED_BLOGS, blogs).length, 2);
  assert.equal(TOOL_INFO.bseupi.url, null);
  assert.equal(TOOL_INFO.blogai.url, null);
  assert.deepEqual(
    (["blackkiwi", "gsc", "ubersuggest", "clarity"] as const).map((t) => new URL(TOOL_INFO[t].url!).host),
    ["blackkiwi.net", "search.google.com", "neilpatel.com", "clarity.microsoft.com"],
  );
});

const queriesEn = "Top queries,Clicks,Impressions,CTR,Position\n제주 여행,\"1,200\",30000,4%,3.25\nbusan food,0,15,0%,\n";
const queriesKo = "﻿인기 검색어,클릭수,노출수,CTR,게재순위\n제주   여행,1200,30000,4%,3.25\nBUSAN FOOD,0,15,0%,\n";

test("a Search Console query export becomes one value per metric, blanks stay missing", () => {
  const r = importGsc(queriesEn, [], opts);
  assert.equal(r.scope, "query");
  assert.deepEqual(r.invalid, []);
  assert.equal(r.added, 7);
  assert.deepEqual(
    r.rows.slice(0, 4).map((v) => [v.metric, v.value, v.unit]),
    [["클릭수", 1200, "회"], ["노출수", 30000, "회"], ["CTR", 4, "%"], ["평균 게재순위", 3.25, "위"]],
  );
  assert.ok(r.rows.every((v) => v.tool === "gsc" && v.blogId === B1 && v.measuredOn === "2026-11-10" && v.dimension));
  assert.equal(r.rows.filter((v) => v.dimension === "busan food").length, 3, "the blank position is not stored as 0");
  assert.equal(r.rows.find((v) => v.dimension === "busan food" && v.metric === "클릭수")!.value, 0, "a real zero stays zero");
});

test("re-importing the same export in another header language adds nothing", () => {
  const first = importGsc(queriesEn, [], opts);
  const stored = first.rows.map((v, i) => ({ ...v, id: `s${i}` }));
  const again = importGsc(queriesKo, stored, opts);
  assert.deepEqual([again.added, again.duplicates, again.conflicts], [0, 7, 0]);
  const changed = importGsc(queriesKo.replace("1200", "1300"), stored, opts);
  assert.deepEqual([changed.added, changed.conflicts], [0, 1]);
  const twice = importGsc(queriesEn + "제주 여행,1200,30000,4%,3.25\n", [], opts);
  assert.equal(twice.duplicates, 4);
  const otherDay = importGsc(queriesEn, stored, { ...opts, measuredOn: "2026-11-09" });
  assert.equal(otherDay.added, 7);
  const otherBlog = importGsc(queriesEn, stored, { ...opts, blogId: B2 });
  assert.equal(otherBlog.added, 7);
});

test("a page export compares addresses exactly and reports bad lines", () => {
  const csv = "Top pages,Clicks,Impressions\nhttps://a.example/1,3,10\nhttps://a.example/1/,3,10\n,1,1\nhttps://a.example/2,x,1\nhttps://a.example/3,,\n";
  const r = importGsc(csv, [], opts);
  assert.equal(r.scope, "page");
  assert.equal(r.added, 4);
  assert.deepEqual(r.invalid.map((i) => i.line), [4, 5, 6]);
  assert.throws(() => importGsc("Date,Clicks\n2026-11-01,1\n", [], opts), /검색어|페이지/);
  assert.throws(() => importGsc("Top queries,Country\na,KR\n", [], opts), /하나 이상/);
  assert.throws(() => importGsc(queriesEn, [], { ...opts, measuredOn: "2026-12-30" }), /측정일/);
  assert.throws(() => importGsc("x".repeat(2_000_001), [], opts), /2MB/);
});

test("hand entry reads numbers and tool labels and checks the evidence URL", () => {
  const f = { blogId: B1, tool: "bseupi" as const, metric: " 블로그지수 ", value: "준최4", unit: "", measuredOn: "2026-11-01", evidenceUrl: "", memo: "" };
  assert.deepEqual([metricFromForm(f, NOW).value, metricFromForm(f, NOW).valueLabel, metricFromForm(f, NOW).metric], [null, "준최4", "블로그지수"]);
  const n = metricFromForm({ ...f, tool: "clarity", metric: "이탈률", value: "42.5%" }, NOW);
  assert.deepEqual([n.value, n.unit, n.valueLabel], [42.5, "%", null]);
  assert.throws(() => metricFromForm({ ...f, value: " " }, NOW), /값/);
  assert.throws(() => metricFromForm({ ...f, evidenceUrl: "javascript:alert(1)" }, NOW), /근거 URL/);
  assert.equal(metricFromForm({ ...f, evidenceUrl: "https://a.example/x" }, NOW).evidenceUrl, "https://a.example/x");
});

test("the API batch accepts only valid rows", () => {
  const row = { blogId: null, tool: "gsc", metric: "클릭수", scope: "query", dimension: "a", value: 1, valueLabel: null, unit: "회", measuredOn: "2026-11-01", evidenceUrl: null, memo: "" };
  assert.equal(parseMetricBatch({ rows: [row] }, NOW).length, 1);
  assert.throws(() => parseMetricBatch({ rows: [] }, NOW));
  assert.throws(() => parseMetricBatch({ rows: [{ ...row, tool: "naver_api" }] }, NOW), /도구/);
  assert.throws(() => parseMetricBatch({ rows: [{ ...row, value: null }] }, NOW), /하나만/);
  assert.throws(() => parseMetricBatch({ rows: [{ ...row, valueLabel: "x" }] }, NOW), /하나만/);
  assert.throws(() => parseMetricBatch({ rows: [{ ...row, scope: "site" }] }, NOW), /사이트/);
  assert.throws(() => parseMetricBatch({ rows: [{ ...row, blogId: "x" }] }, NOW), /블로그/);
  assert.throws(() => parseMetricBatch({ rows: Array(501).fill(row) }, NOW), /500/);
  assert.deepEqual(dbToMetric({ id: "i", blog_id: null, tool: "gsc", metric: "m", scope: "site", dimension: "", value: "1.5000", value_label: null, unit: "", measured_on: "2026-11-01", evidence_url: null, memo: "" }).value, 1.5);
});

test("tool summaries never add across tools or accounts and show N/A without records", () => {
  const rows = [
    snap({ valueLabel: "준최3", measuredOn: "2026-10-01" }),
    snap({ valueLabel: "준최4", measuredOn: "2026-11-01" }),
    snap({ tool: "gsc", metric: "클릭수", value: 10, valueLabel: null, unit: "회", scope: "query", dimension: "a" }),
    snap({ tool: "gsc", metric: "클릭수", value: 20, valueLabel: null, unit: "회", scope: "query", dimension: "b" }),
  ];
  const b = toolSummary(rows, "bseupi");
  assert.deepEqual(b.items, [{ metric: "블로그지수", value: "준최4", note: "2026-11-01" }]);
  const g = toolSummary(rows, "gsc");
  assert.deepEqual([g.items.length, g.queries], [0, 2], "query rows are counted, never summed into a site total");
  assert.equal(toolSummary(rows, "clarity").count, 0);
  const two = toolSummary([snap(), snap({ blogId: B2, valueLabel: "최적1" })], "bseupi");
  assert.equal(two.items[0].value, "표 참고");
});

test("the blog index trend keeps each tool apart and only compares a tool with itself", () => {
  const series = indexSeries([
    snap({ valueLabel: "준최4", measuredOn: "2026-11-01" }),
    snap({ valueLabel: "준최3", measuredOn: "2026-10-01" }),
    snap({ valueLabel: "준최3", measuredOn: "2026-10-15" }),
    snap({ tool: "other", metric: "블로그 지수", value: 52, valueLabel: null, measuredOn: "2026-10-01" }),
    snap({ tool: "other", metric: "블로그 지수", value: 55.5, valueLabel: null, measuredOn: "2026-11-01" }),
    snap({ metric: "누락 글 수", value: 2, valueLabel: null }),
  ]);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0].points.map((p) => [p.measuredOn, p.value, p.change]), [
    ["2026-10-01", "준최3", "첫 기록"],
    ["2026-10-15", "준최3", "같음"],
    ["2026-11-01", "준최4", "바뀜"],
  ]);
  assert.deepEqual(series[1].points.map((p) => p.change), ["첫 기록", "+3.5"]);
});

test("the screens say what is not official or connected and show N/A", () => {
  const blogs = [blog(B1, "naver")];
  const bundles = renderToStaticMarkup(createElement(ToolBundles, { rows: [], blogs, filter: B1 }));
  assert.match(bundles, /블스피/);
  assert.match(bundles, /블로그AI/);
  assert.match(bundles, /href="https:\/\/blackkiwi.net\/"/);
  assert.equal((bundles.match(/href=/g) ?? []).length, 1, "named-only tools have no link");
  assert.match(bundles, /rel="noopener noreferrer"/);
  assert.match(bundles, /N\/A/);
  assert.doesNotMatch(bundles, /Search Console/);
  assert.doesNotMatch(bundles, /연결됨/);
  const index = renderToStaticMarkup(createElement(IndexTrend, { series: [], blogs }));
  assert.match(index, /공식 지표가 아닙니다/);
  assert.match(index, /계산하지 않습니다/);
  assert.match(index, /N\/A/);
  const local = renderToStaticMarkup(createElement(BlogMetrics, { account: false, blogFilter: ALL_BLOGS }));
  assert.match(local, /계정 모드에서 사용 가능/);
  const account = renderToStaticMarkup(createElement(BlogMetrics, { account: true, blogFilter: ALL_BLOGS }));
  assert.match(account, /Search Console 실적 CSV/);
  assert.match(account, /href="https:\/\/search.google.com\/search-console"/);
  assert.doesNotMatch(account, /연결됨/);
});

test("the record table labels every cell and hides actions from read-only members", () => {
  const rows = [snap({ evidenceUrl: "https://a.example/e", memo: "메모" })];
  const props = { rows, blogs: [blog(B1, "naver")], onRemove: () => {} };
  const html = renderToStaticMarkup(createElement(MetricTable, { ...props, canWrite: true }));
  assert.equal((html.match(/data-label=/g) ?? []).length, 8);
  assert.match(html, /data-label="값"><b>준최4<\/b>/);
  assert.match(html, /삭제/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(MetricTable, { ...props, canWrite: false })), /삭제/);
});

test("the analytics page shows the records under the shared blog filter", () => {
  assert.match(read("../src/components/analytics.tsx"), /<BlogMetrics account=\{mode === "account"\} blogFilter=\{blogFilter\} \/>/);
});

test("a file's same query twice with other values is a conflict, the first stays", () => {
  const csv = "Top queries,Clicks\na,10\nA,10\na,99\n";
  const r = importGsc(csv, [], opts);
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.conflicts, 1);
  assert.equal(r.rows[0].value, 10);
});

test("a row that would pass the limit is left out as a whole, none of its values are added", () => {
  const csv = "Top queries,Clicks,Impressions\na,1,2\nb,3,4\n";
  const existing = Array.from({ length: MAX_METRICS - 3 }, (_, i) => snap({ dimension: `q${i}`, scope: "query", tool: "gsc", metric: "클릭수", value: 1, valueLabel: null, measuredOn: "2026-10-01" }));
  const r = importGsc(csv, existing, opts);
  assert.deepEqual(r.rows.map((x) => x.dimension), ["a", "a"]); // row "b" needs 2 values and only 1 slot is left
  assert.equal(r.added, 2);
  assert.deepEqual(r.invalid.map((i) => i.line), [3]);
});

test("sending in chunks never splits the values of one CSV row", () => {
  const csv = "Top queries,Clicks,Impressions,CTR\n" + Array.from({ length: 5 }, (_, i) => `q${i},1,2,3%`).join("\n");
  const list = importGsc(csv, [], opts).rows; // 15 values, 3 per row
  const chunks = chunkList(list, 4, metricRowKey);
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 3, 3, 3]);
  for (const c of chunks) assert.equal(new Set(c.map((x) => x.dimension)).size, 1);
  assert.equal(chunks.flat().length, list.length);
  assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2).map((c) => c.length), [2, 2, 1]); // without a key: plain split
  assert.deepEqual(chunkList(list.slice(0, 3), 2, metricRowKey).map((c) => c.length), [2, 1]); // a group larger than the size can only be split
});

test("page keys trim only the six ASCII spaces, like the database", () => {
  const url = "https://a.example/p";
  assert.equal(trimSpaces(`\t\n ${url} \r\f\v`), url);
  assert.equal(trimSpaces(` ${url}　`), ` ${url}　`); // NBSP and ideographic space stay
  const a = importGsc(`Top pages,Clicks\n ${url},1\n`, [], opts).rows[0];
  assert.equal(a.dimension, ` ${url}`);
  assert.notEqual(metricKey(a), metricKey({ ...a, dimension: url }));
  assert.equal(metricKey({ ...a, dimension: ` ${url}\t` }), metricKey({ ...a, dimension: url }));
  const row = { ...snap({ scope: "page", dimension: `\n${url} `, value: 1, valueLabel: null }), id: undefined };
  assert.equal(parseMetricBatch({ rows: [row] }, NOW)[0].dimension, url);
});
