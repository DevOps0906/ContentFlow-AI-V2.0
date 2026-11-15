import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync, SyncError } from "../src/lib/analytics-sync-server";
import { disconnect } from "../src/lib/analytics-connections-server";
import type { Authed } from "../src/lib/api";
import { ADSENSE_SYNC, AdsenseSyncError, fetchAccountTimeZone, fetchAdsenseReport, isPageUrlRefusal, parseAdsenseReport } from "../src/lib/adsense-sync";
import { normalizePage, summarize, UNATTRIBUTED_PAGE, type RevenueRow } from "../src/lib/revenue";
import { googleConfig, listAdsenseAccounts, startFlow, checkFlow, ADSENSE_SCOPE } from "../src/lib/google-oauth";
import { parseKeyRing } from "../src/lib/token-crypto";
import { randomBytes } from "node:crypto";

const range = { start: "2026-11-01", end: "2026-11-03" };
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const header = (pageLevel: boolean, currency: string | null = "USD") => [
  { name: "DATE", type: "DIMENSION" },
  ...(pageLevel ? [{ name: "PAGE_URL", type: "DIMENSION" }] : []),
  { name: "ESTIMATED_EARNINGS", type: currency ? "METRIC_CURRENCY" : "METRIC_TALLY", ...(currency ? { currencyCode: currency } : {}) },
  { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
  { name: "IMPRESSIONS", type: "METRIC_TALLY" },
  { name: "CLICKS", type: "METRIC_TALLY" },
];
const cells = (...v: string[]) => ({ cells: v.map((value) => ({ value })) });
const body = (pageLevel: boolean, rows: unknown[], currency: string | null = "USD") => ({ headers: header(pageLevel, currency), rows });

test("report: currency comes from the METRIC_CURRENCY header; none -> failure, never a guess", () => {
  const ok = parseAdsenseReport(JSON.stringify(body(true, [cells("2026-11-01", "https://a.test/x", "1.5", "100", "400", "3")], "KRW")), true, range, "Asia/Seoul", 100);
  assert.equal(ok.currency, "KRW");
  assert.equal(ok.rows[0].currency, "KRW");
  assert.equal(ok.rows[0].timezone, "Asia/Seoul");
  assert.throws(
    () => parseAdsenseReport(JSON.stringify(body(true, [cells("2026-11-01", "https://a.test/x", "1.5", "100", "400", "3")], null)), true, range, "Asia/Seoul", 100),
    (e) => e instanceof AdsenseSyncError && e.kind === "currency",
  );
  // no rows but a header without currency fails as well
  assert.throws(() => parseAdsenseReport(JSON.stringify(body(false, [], null)), false, range, "Asia/Seoul", 100), (e) => e instanceof AdsenseSyncError && e.kind === "currency");
  // a currency code that is not 3 capital letters is not accepted
  assert.throws(() => parseAdsenseReport(JSON.stringify(body(false, [], "usd")), false, range, "Asia/Seoul", 100), (e) => e instanceof AdsenseSyncError && e.kind === "currency");
});

test("report: every row is status estimated; numbers are validated; zero rows is a valid empty report", () => {
  const r = parseAdsenseReport(JSON.stringify(body(false, [cells("2026-11-01", "0", "0", "0", "0"), cells("2026-11-02", "2.12345", "10", "20", "1")])), false, range, "America/Los_Angeles", 100);
  assert.deepEqual(r.rows.map((x) => x.status), ["estimated", "estimated"]);
  assert.equal(r.rows[1].revenue, 2.1235);
  assert.equal(r.rows[0].revenue, 0, "a real 0 is stored as 0");
  assert.equal(parseAdsenseReport(JSON.stringify(body(false, [])), false, range, "UTC", 100).rows.length, 0);
  for (const bad of [cells("2026-11-01", "-1", "1", "1", "1"), cells("2026-11-01", "x", "1", "1", "1"), cells("2026-11-01", "1", "1.5", "1", "1"), cells("2026-10-01", "1", "1", "1", "1")])
    assert.throws(() => parseAdsenseReport(JSON.stringify(body(false, [bad])), false, range, "UTC", 100), (e) => e instanceof AdsenseSyncError && e.kind === "bad_response");
});

test("report: URLs that normalize to one page are merged (no duplicate key); over-long or empty URLs go into one (unattributed) bucket per day, run stays complete", () => {
  const long = `https://a.test/${"x".repeat(ADSENSE_SYNC.maxPageChars)}`;
  const r = parseAdsenseReport(
    JSON.stringify(
      body(true, [
        cells("2026-11-01", "https://a.test/p?utm=1", "1", "10", "100", "1"),
        cells("2026-11-01", "https://A.test/p/", "2", "20", "200", "2"),
        cells("2026-11-01", long, "5", "5", "5", "5"),
        cells("2026-11-01", " ", "5", "5", "5", "5"),
      ]),
    ),
    true,
    range,
    "UTC",
    100,
  );
  assert.equal(r.rows.length, 2);
  const real = r.rows.find((x) => x.page !== UNATTRIBUTED_PAGE)!;
  assert.deepEqual([real.revenue, real.pageviews, real.impressions, real.clicks], [3, 30, 300, 3]);
  const bucket = r.rows.find((x) => x.page === UNATTRIBUTED_PAGE)!;
  assert.deepEqual([bucket.revenue, bucket.pageviews, bucket.clicks], [10, 10, 10], "long + empty URL summed");
  assert.equal(r.skipped, 0);
  assert.equal(normalizePage(UNATTRIBUTED_PAGE), UNATTRIBUTED_PAGE, "stable under the page normalizer (SQL does the same)");
});

test("report: more rows than the cap is refused before anything is returned", () => {
  const rows = Array.from({ length: 4 }, (_, i) => cells(`2026-11-0${(i % 3) + 1}`, `https://a.test/${i}`, "1", "1", "1", "1"));
  assert.throws(() => parseAdsenseReport(JSON.stringify(body(true, rows)), true, range, "UTC", 3), (e) => e instanceof AdsenseSyncError && e.kind === "cap");
});

test("fetch: PAGE_URL first with account time zone and no currencyCode; metrics and dates in the query", async () => {
  const urls: URL[] = [];
  const f = (async (u: string) => {
    urls.push(new URL(u));
    return reply(200, body(true, [cells("2026-11-01", "https://a.test/x", "1", "2", "3", "4")]));
  }) as unknown as typeof fetch;
  const r = await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "Asia/Seoul", range, f);
  assert.equal(r.pageLevel, true);
  assert.equal(urls.length, 1);
  const q = urls[0].searchParams;
  assert.equal(urls[0].pathname, "/api/v2/accounts/pub-1/reports:generate");
  assert.deepEqual(q.getAll("dimensions"), ["DATE", "PAGE_URL"]);
  assert.deepEqual(q.getAll("metrics"), ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"]);
  assert.equal(q.get("reportingTimeZone"), "ACCOUNT_TIME_ZONE");
  assert.equal(q.has("currencyCode"), false);
  assert.deepEqual([q.get("startDate.year"), q.get("startDate.month"), q.get("startDate.day"), q.get("endDate.day")], ["2026", "11", "1", "3"]);
});

test("fetch: PAGE_URL refused (400) -> one more request at site x day level, page is '' and the connection reads site level", async () => {
  const dims: string[][] = [];
  const f = (async (u: string) => {
    const d = new URL(u).searchParams.getAll("dimensions");
    dims.push(d);
    return d.includes("PAGE_URL") ? reply(400, { error: { status: "INVALID_ARGUMENT", message: "dimension PAGE_URL not allowed" } }) : reply(200, body(false, [cells("2026-11-01", "1", "2", "3", "4")]));
  }) as unknown as typeof fetch;
  const r = await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, f);
  assert.deepEqual(dims, [["DATE", "PAGE_URL"], ["DATE"]]);
  assert.equal(r.pageLevel, false);
  assert.deepEqual(r.rows.map((x) => x.page), [""]);
});

test("fetch: site level and page level are never mixed in one report", async () => {
  // a site-level fallback answer carries no page rows even if Google sent a PAGE_URL column: the request asked for DATE only
  const f = (async (u: string) =>
    new URL(u).searchParams.getAll("dimensions").includes("PAGE_URL") ? reply(400, { error: { status: "INVALID_ARGUMENT", message: "dimension" } }) : reply(200, body(false, [cells("2026-11-01", "1", "2", "3", "4")]))) as unknown as typeof fetch;
  const r = await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, f);
  assert.ok(r.rows.every((x) => x.page === ""));
  const p = parseAdsenseReport(JSON.stringify(body(true, [cells("2026-11-01", "https://a.test/x", "1", "2", "3", "4"), cells("2026-11-01", "https://a.test/y", "1", "2", "3", "4")])), true, range, "UTC", 100);
  assert.ok(p.rows.every((x) => x.page !== ""));
});

test("fetch: 401 -> auth, 429 -> quota, 500 -> failed, a 400 on the site-level retry fails (no more fallbacks)", async () => {
  const run = (status: number) => fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, (async () => reply(status, {})) as unknown as typeof fetch).catch((e) => e);
  assert.equal(((await run(401)) as AdsenseSyncError).kind, "auth");
  assert.equal(((await run(429)) as AdsenseSyncError).kind, "quota");
  assert.equal(((await run(500)) as AdsenseSyncError).kind, "failed");
  assert.equal(((await run(400)) as AdsenseSyncError).kind, "failed");
});

test("account time zone: IANA id from accounts.get, missing or unknown -> failure", async () => {
  const get = (b: unknown) => fetchAccountTimeZone("http://g.test/api", "at", "accounts/pub-1", (async () => reply(200, b)) as unknown as typeof fetch).catch((e) => e);
  assert.equal(await get({ timeZone: { id: "Asia/Seoul" } }), "Asia/Seoul");
  assert.equal(((await get({})) as AdsenseSyncError).kind, "timezone");
  assert.equal(((await get({ timeZone: { id: "Not/AZone" } })) as AdsenseSyncError).kind, "timezone");
});

// ---- summary rules (revenue.ts) ----
const rev = (o: Partial<RevenueRow>): RevenueRow =>
  ({ source: "adsense-api", status: "estimated", currency: "USD", date: "2026-11-01", page: "", revenue: null, pageviews: null, impressions: null, clicks: null, importedAt: "t", timezone: "UTC", ...o }) as RevenueRow;

test("RPM denominator is the PAGE_VIEWS of the same report rows (revenue per 1,000 views), not other sources", () => {
  const [s] = summarize([rev({ page: "https://a.test/x", revenue: 3, pageviews: 1000 }), rev({ page: "https://a.test/y", revenue: 1, pageviews: 1000 })]);
  assert.equal(s.rpm, 2);
  // a row without pageviews does not enter the RPM (no GA4 / other source fills the denominator)
  const [t] = summarize([rev({ page: "https://a.test/x", revenue: 3, pageviews: 1000 }), rev({ page: "https://a.test/z", revenue: 9, pageviews: null })]);
  assert.equal(t.rpm, 3);
});

test("adsense-api and CSV rows are separate summaries (never added), status stays estimated", () => {
  const out = summarize([rev({ revenue: 10, pageviews: 1000 }), rev({ source: "adsense", revenue: 7, pageviews: 700, timezone: "UTC" })]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => [s.source, s.revenue]).sort(), [["adsense", 7], ["adsense-api", 10]]);
  assert.ok(out.every((s) => s.status === "estimated"));
});

// ---- OAuth: incremental consent ----
const k = () => randomBytes(32).toString("base64");
const cfg = googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "sec", ANALYTICS_TOKEN_KEYS: `1:${k()}` } as unknown as NodeJS.ProcessEnv)!;

test("adsense consent: adsense.readonly only (no GSC scope), include_granted_scopes=true, flow remembers the provider", () => {
  const f = startFlow(cfg, "http://localhost:3000/cb", "u1", "w1", 1000, "adsense");
  const q = new URL(f.url).searchParams;
  assert.equal(q.get("scope"), `openid email ${ADSENSE_SCOPE}`);
  assert.equal(q.get("include_granted_scopes"), "true");
  assert.equal(q.get("access_type"), "offline");
  const c = checkFlow(cfg.ring, f.cookie, q.get("state"), "u1", 1001);
  assert.ok(c.ok && c.flow.p === "adsense");
  assert.equal(parseKeyRing("x"), null);
});

test("AdSense API root: default host, GOOGLE_API_BASE override, accounts list keeps only valid account names", async () => {
  assert.equal(cfg.adsenseBase, "https://adsense.googleapis.com");
  const fake = googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "sec", ANALYTICS_TOKEN_KEYS: `1:${k()}`, GOOGLE_API_BASE: "http://127.0.0.1:1/api/" } as unknown as NodeJS.ProcessEnv)!;
  assert.equal(fake.adsenseBase, "http://127.0.0.1:1/api");
  let url = "";
  const f = (async (u: string) => {
    url = u;
    return reply(200, { accounts: [{ name: "accounts/pub-1", displayName: "A", timeZone: { id: "Asia/Seoul" } }, { name: "../evil" }, { name: 3 }] });
  }) as unknown as typeof fetch;
  const list = await listAdsenseAccounts(fake, "at", f);
  assert.ok(url.startsWith("http://127.0.0.1:1/api/v2/accounts"));
  assert.deepEqual(list, [{ name: "accounts/pub-1", displayName: "A", timeZone: "Asia/Seoul" }]);
});

// ---- review follow-ups ----
test("page report over the cap or cut short (totalMatchedRows) -> site x day report instead; at site level it is a cap failure", async () => {
  const dims: string[][] = [];
  const rows = Array.from({ length: 3 }, (_, i) => cells("2026-11-01", `https://a.test/${i}`, "1", "1", "1", "1"));
  const f = (async (u: string) => {
    const d = new URL(u).searchParams.getAll("dimensions");
    dims.push(d);
    return d.includes("PAGE_URL") ? reply(200, body(true, rows)) : reply(200, body(false, [cells("2026-11-01", "3", "3", "3", "3")]));
  }) as unknown as typeof fetch;
  const r = await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, f, 2);
  assert.equal(r.pageLevel, false);
  assert.deepEqual(dims, [["DATE", "PAGE_URL"], ["DATE"]]);
  // truncated by Google: totalMatchedRows is larger than the rows that came back
  const cut = reply(200, { ...body(true, [rows[0]]), totalMatchedRows: "5" });
  const g = (async (u: string) => (new URL(u).searchParams.getAll("dimensions").includes("PAGE_URL") ? cut.clone() : reply(200, body(false, [cells("2026-11-01", "1", "1", "1", "1")])))) as unknown as typeof fetch;
  assert.equal((await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, g)).pageLevel, false);
  assert.throws(() => parseAdsenseReport(JSON.stringify({ ...body(false, [cells("2026-11-01", "1", "1", "1", "1")]), totalMatchedRows: "9" }), false, range, "UTC", 100), (e) => e instanceof AdsenseSyncError && e.kind === "cap");
});

test("PAGE_URL fallback only for INVALID_ARGUMENT naming the dimension; any other 400 fails without a second request", async () => {
  assert.equal(isPageUrlRefusal(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Dimension PAGE_URL cannot be combined" } })), true);
  assert.equal(isPageUrlRefusal(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid date range" } })), false);
  assert.equal(isPageUrlRefusal(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "PAGE_URL" } })), false);
  assert.equal(isPageUrlRefusal("not json"), false);
  let n = 0;
  const f = (async () => (n++, reply(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid date range" } }))) as unknown as typeof fetch;
  const e = (await fetchAdsenseReport("http://g.test/api", "at", "accounts/pub-1", "UTC", range, f).catch((x) => x)) as AdsenseSyncError;
  assert.equal(e.kind, "failed");
  assert.equal(n, 1);
});

test("runSync: a stored adsense external_ref that is not accounts/pub-… is refused (409 CONNECTION_INVALID) before any run or request", async () => {
  const calls: string[] = [];
  const con = { id: "c1", provider: "adsense", external_ref: "accounts/../evil", status: "active", grant_id: "g1" };
  const supabase = {
    rpc: async (fn: string) => (calls.push(fn), { data: null, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: con, error: null }) }) }) }) }),
  };
  const account = { supabase, workspaceId: "w1", user: { id: "u1" }, role: "owner" } as unknown as Authed;
  let fetched = 0;
  const e = (await runSync(account, cfg, "c1", { fetchImpl: (async () => (fetched++, reply(200, {}))) as unknown as typeof fetch }).catch((x) => x)) as SyncError;
  assert.ok(e instanceof SyncError && e.status === 409 && e.code === "CONNECTION_INVALID");
  assert.deepEqual(calls, []);
  assert.equal(fetched, 0);
});

test("disconnect: AdSense connection with other connections left on the grant reports remaining > 0 (no revoke)", async () => {
  const supabase = {
    rpc: async () => ({ data: 2, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { grant_id: "g1" }, error: null }) }) }) }) }),
  };
  const account = { supabase, workspaceId: "w1", user: { id: "u1" }, role: "owner" } as unknown as Authed;
  assert.deepEqual(await disconnect(account, cfg, "c1", false), { revoke: "kept", grantId: "g1", remaining: 2 });
});
