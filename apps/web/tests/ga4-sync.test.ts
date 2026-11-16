import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchGa4Pairs, GA4_SYNC, Ga4SyncError, parseGa4Date, toGa4SyncRows } from "../src/lib/ga4-sync";
import { syncRange } from "../src/lib/gsc-sync";
import { runSync, SyncError } from "../src/lib/analytics-sync-server";
import { GA4_PROPERTY_RE, listGa4Properties, googleConfig, startFlow, checkFlow, exchangeCode, GoogleError } from "../src/lib/google-oauth";
import { createGa4Connection, AnalyticsError } from "../src/lib/analytics-connections-server";
import { ga4Lines, syncErrorMessage } from "../src/lib/analytics-connections-view";
import { metricRowKey, toolSummary, type MetricSnapshot } from "../src/lib/blog-metrics";
import { summarize, type RevenueRow } from "../src/lib/revenue";
import { encryptToken, parseKeyRing } from "../src/lib/token-crypto";
import type { GoogleConfig } from "../src/lib/google-oauth";
import type { Authed } from "../src/lib/api";

const NOW = new Date("2026-11-15T10:00:00Z"); // yesterday = 2026-11-14
const range = { start: "2026-11-01", end: "2026-11-14" };
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const dv = (value: string) => ({ value });
const row = (date: string, page: string, views = 10, sessions = 5, users = 4) => ({
  dimensionValues: [dv(date), dv(page)],
  metricValues: [dv(String(views)), dv(String(sessions)), dv(String(users))],
});
const headers = ["screenPageViews", "sessions", "activeUsers"].map((name) => ({ name }));
const asFetch = (f: unknown) => f as typeof fetch;

// ---- date / ref ----
test("parseGa4Date: YYYYMMDD to ISO, anything else (or an impossible day) is null", () => {
  assert.equal(parseGa4Date("20261113"), "2026-11-13");
  assert.equal(parseGa4Date("20240229"), "2024-02-29");
  for (const bad of ["2026-11-13", "20261313", "20260230", "2026111", "", 20261113, null, undefined]) assert.equal(parseGa4Date(bad), null);
});

test("GA4_PROPERTY_RE accepts only properties/<digits>", () => {
  assert.ok(GA4_PROPERTY_RE.test("properties/123456"));
  for (const bad of ["properties/", "properties/12a", "accounts/1", "properties/1/x", "properties/1\n", " properties/1", "properties/../1", ""]) assert.equal(GA4_PROPERTY_RE.test(bad), false, bad);
});

// ---- fetch / paging ----
test("fetchGa4Pairs: sends the contract body, pages with offset until rowCount, joins results", async () => {
  const sent: { url: string; body: { offset: number; limit: number; dimensions: { name: string }[]; metrics: { name: string }[]; dateRanges: unknown[] } }[] = [];
  const f = asFetch(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, body });
    return reply(200, body.offset === 0 ? { rowCount: 3, metricHeaders: headers, rows: [row("20261101", "/a"), row("20261102", "/a")] } : { rowCount: 3, rows: [row("20261101", "/b")] });
  });
  const out = await fetchGa4Pairs("http://g", "at", "properties/42", range, f);
  assert.equal(out.length, 3);
  assert.deepEqual(sent.map((s) => s.body.offset), [0, 2]);
  assert.equal(sent[0].url, "http://g/v1beta/properties/42:runReport");
  assert.equal(sent[0].body.limit, GA4_SYNC.rowLimit);
  assert.deepEqual(sent[0].body.dimensions, [{ name: "date" }, { name: "pagePath" }]);
  assert.deepEqual(sent[0].body.metrics.map((m) => m.name), ["screenPageViews", "sessions", "activeUsers"]);
  assert.deepEqual(sent[0].body.dateRanges, [{ startDate: "2026-11-01", endDate: "2026-11-14" }]);
  assert.deepEqual(out[0], { date: "2026-11-01", page: "/a", views: 10, sessions: 5, users: 4 });
});

test("fetchGa4Pairs: an empty answer is a valid empty result; an empty page stops a bad rowCount loop", async () => {
  assert.deepEqual(await fetchGa4Pairs("http://g", "at", "properties/1", range, asFetch(async () => reply(200, {}))), []);
  let n = 0;
  const f = asFetch(async () => reply(200, ++n === 1 ? { rowCount: 99, rows: [row("20261101", "/a")] } : { rowCount: 99, rows: [] }));
  assert.equal((await fetchGa4Pairs("http://g", "at", "properties/1", range, f)).length, 1);
  assert.equal(n, 2);
});

test("fetchGa4Pairs: duplicate (date, page) merge: views and sessions add, active users keep the larger value", async () => {
  const f = asFetch(async () => reply(200, { rows: [row("20261101", "/x", 4, 2, 3), row("20261101", " /x ", 6, 3, 5)] }));
  const out = await fetchGa4Pairs("http://g", "at", "properties/1", range, f);
  assert.deepEqual(out, [{ date: "2026-11-01", page: "/x", views: 10, sessions: 5, users: 5 }]);
});

test("fetchGa4Pairs: (not set) is not a page and is dropped", async () => {
  const f = asFetch(async () => reply(200, { rows: [row("20261101", "(not set)"), row("20261101", "/ok")] }));
  assert.deepEqual((await fetchGa4Pairs("http://g", "at", "properties/1", range, f)).map((p) => p.page), ["/ok"]);
});

test("fetchGa4Pairs: cap is checked from the first rowCount, before more pages are requested", async () => {
  let calls = 0;
  const f = asFetch(async () => {
    calls++;
    return reply(200, { rowCount: 11, rows: [row("20261101", "/a")] });
  });
  await assert.rejects(fetchGa4Pairs("http://g", "at", "properties/1", range, f, 30), (e) => e instanceof Ga4SyncError && e.kind === "cap"); // 11 x 3 > 30
  assert.equal(calls, 1);
  const many = asFetch(async () => reply(200, { rows: Array.from({ length: 11 }, (_, i) => row("20261101", `/p${i}`)) }));
  await assert.rejects(fetchGa4Pairs("http://g", "at", "properties/1", range, many, 30), (e) => e instanceof Ga4SyncError && e.kind === "cap"); // no rowCount: merged pairs decide
  assert.equal((await fetchGa4Pairs("http://g", "at", "properties/1", range, many, 33)).length, 11);
});

test("fetchGa4Pairs: stops with a failure once the total time budget is spent", async () => {
  let t = 0;
  const f = asFetch(async () => reply(200, { rowCount: 5, rows: [row("20261101", "/a")] }));
  await assert.rejects(
    fetchGa4Pairs("http://g", "at", "properties/1", range, f, 1_000_000, () => (t += 30_000)),
    (e) => e instanceof Ga4SyncError && e.kind === "failed" && /PROVIDER_TIMEOUT/.test(e.message),
  );
});

test("fetchGa4Pairs: 401 auth, scope-403 auth, 429 / quota-403 quota, other 403 forbidden, 5xx failed, garbage bad_response", async () => {
  const kind = async (status: number, body: unknown) => {
    try {
      await fetchGa4Pairs("http://g", "at", "properties/1", range, asFetch(async () => reply(status, body)));
    } catch (e) {
      return (e as Ga4SyncError).kind;
    }
    return "none";
  };
  assert.equal(await kind(401, {}), "auth");
  assert.equal(await kind(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }), "auth");
  assert.equal(await kind(429, { error: { status: "RESOURCE_EXHAUSTED" } }), "quota");
  assert.equal(await kind(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }), "quota");
  assert.equal(await kind(403, { error: { status: "PERMISSION_DENIED", message: "User does not have sufficient permissions for this property." } }), "forbidden");
  assert.equal(await kind(400, {}), "failed");
  assert.equal(await kind(503, {}), "failed");
  assert.equal(await kind(200, "not json"), "bad_response");
  assert.equal(await kind(200, { rows: [{ dimensionValues: [dv("20261101")], metricValues: [] }] }), "bad_response");
  assert.equal(await kind(200, { rows: [row("2026-11-01", "/a")] }), "bad_response"); // date must be YYYYMMDD
  assert.equal(await kind(200, { rows: [row("20261101", "/a", -1)] }), "bad_response");
  assert.equal(await kind(200, { rows: [row("20261020", "/a")] }), "bad_response"); // outside the requested range
  assert.equal(await kind(200, { metricHeaders: [{ name: "sessions" }], rows: [] }), "bad_response");
});

test("fetchGa4Pairs: an invalid property id never reaches Google", async () => {
  let hit = false;
  const f = asFetch(async () => ((hit = true), reply(200, {})));
  await assert.rejects(fetchGa4Pairs("http://g", "at", "properties/1/../x", range, f), (e) => e instanceof Ga4SyncError);
  assert.equal(hit, false);
});

test("toGa4SyncRows: page scope, GA4 names and units, a real 0 stays 0, oversized pages are skipped (partial)", () => {
  const { rows, skipped } = toGa4SyncRows([
    { date: "2026-11-01", page: "/a", views: 0, sessions: 2, users: 1 },
    { date: "2026-11-01", page: "/" + "x".repeat(GA4_SYNC.maxPageChars), views: 1, sessions: 1, users: 1 },
  ]);
  assert.equal(skipped, 1);
  assert.deepEqual(rows.map((r) => [r.metric, r.unit, r.value, r.scope, r.dimension]), [
    ["조회수", "회", 0, "page", "/a"],
    ["세션", "회", 2, "page", "/a"],
    ["활성 사용자", "명", 1, "page", "/a"],
  ]);
  assert.equal(new Set(rows.map((r) => `${r.metric}|${r.dimension}|${r.measured_on}`)).size, rows.length);
});

// ---- separation: ga4-api never feeds RPM, CSV or other tools ----
test("ga4-api rows stay apart: not in another tool's summary, not a revenue row, own row key", () => {
  const snap = (o: Partial<MetricSnapshot>) =>
    ({ id: "i" + Math.random(), blogId: null, tool: "ga4-api", metric: "조회수", scope: "page", dimension: "/a", value: 100, valueLabel: null, unit: "회", measuredOn: "2026-11-01", evidenceUrl: null, memo: "", coverage: "complete", ...o }) as MetricSnapshot;
  const rows = [snap({}), snap({ tool: "gsc-api", metric: "클릭수", value: 7 }), snap({ tool: "gsc", metric: "조회수", value: 55 })];
  const g = toolSummary(rows, "ga4-api");
  assert.equal(g.count, 1);
  assert.equal(g.items.length, 0); // page-scope values are never rolled up into a site figure
  assert.equal(toolSummary(rows, "gsc-api").count, 1);
  assert.equal(toolSummary(rows, "gsc").count, 1);
  const key = (tool: "ga4-api" | "gsc") => metricRowKey({ blogId: null, tool, metric: "조회수", scope: "page", dimension: "/a", value: 1, valueLabel: null, unit: "회", measuredOn: "2026-11-01", evidenceUrl: null, memo: "" });
  assert.notEqual(key("ga4-api"), key("gsc"));
  // RPM comes only from revenue rows: GA4 page views have no way in
  const revenue = { source: "adsense-api", status: "estimated", currency: "USD", date: "2026-11-01", page: "", revenue: 10, pageviews: 1000, impressions: null, clicks: null, timezone: "UTC" } as unknown as RevenueRow;
  assert.equal(summarize([revenue])[0].rpm, 10);
  const src = readFileSync(new URL("../src/lib/ga4-sync.ts", import.meta.url), "utf8");
  assert.equal(/from "\.\/revenue"/.test(src), false);
});

test("ga4Lines says no RPM, no summed active users; PROVIDER_FORBIDDEN has a message", () => {
  assert.match(ga4Lines().join(" "), /RPM/);
  assert.match(ga4Lines().join(" "), /합산/);
  assert.match(syncErrorMessage("PROVIDER_FORBIDDEN", 502), /권한/);
});

// ---- OAuth: scope, flow, property list ----
const ring = parseKeyRing(`1:${randomBytes(32).toString("base64")}`)!;
const env = { GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "sec", ANALYTICS_TOKEN_KEYS: `1:${randomBytes(32).toString("base64")}` } as unknown as NodeJS.ProcessEnv;

test("ga4 consent asks only analytics.readonly (incremental), flow cookie carries ga4, API bases are overridable", () => {
  const c = googleConfig(env)!;
  assert.equal(c.ga4AdminBase, "https://analyticsadmin.googleapis.com");
  assert.equal(c.ga4DataBase, "https://analyticsdata.googleapis.com");
  assert.equal(googleConfig({ ...env, GOOGLE_API_BASE: "http://fake/api/" } as unknown as NodeJS.ProcessEnv)!.ga4DataBase, "http://fake/api");
  const f = startFlow(c, "http://x/cb", "u1", "w1", 1_000, "ga4");
  const q = new URL(f.url).searchParams;
  assert.equal(q.get("scope"), "openid email https://www.googleapis.com/auth/analytics.readonly");
  assert.equal(q.get("include_granted_scopes"), "true");
  const ok = checkFlow(c.ring, f.cookie, q.get("state"), "u1", 2_000);
  assert.ok(ok.ok && ok.flow.p === "ga4");
});

test("exchangeCode(ga4) refuses a grant without the analytics scope", async () => {
  const c = googleConfig(env)!;
  const idt = ["h", Buffer.from(JSON.stringify({ sub: "s", email: "e@x" })).toString("base64url"), "s"].join(".");
  const tok = (scope: string) => asFetch(async () => reply(200, { access_token: "a", refresh_token: "r", id_token: idt, scope }));
  await assert.rejects(exchangeCode(c, "code", "v", "http://x/cb", tok("openid email https://www.googleapis.com/auth/webmasters.readonly"), "ga4"), (e) => e instanceof GoogleError && e.code === "scope_missing");
  const ok = await exchangeCode(c, "code", "v", "http://x/cb", tok("openid https://www.googleapis.com/auth/analytics.readonly"), "ga4");
  assert.equal(ok.refreshToken, "r");
});

test("listGa4Properties flattens accountSummaries, pages, and drops malformed names", async () => {
  const c = { ...googleConfig(env)!, ga4AdminBase: "http://g" };
  const urls: string[] = [];
  const f = asFetch(async (u: string) => {
    urls.push(u);
    return reply(
      200,
      u.includes("pageToken=t2")
        ? { accountSummaries: [{ displayName: "B", propertySummaries: [{ property: "properties/3", displayName: "Three" }] }] }
        : { nextPageToken: "t2", accountSummaries: [{ displayName: "A", propertySummaries: [{ property: "properties/1", displayName: "One" }, { property: "properties/x", displayName: "bad" }, { property: "accounts/2" }] }] },
    );
  });
  const out = await listGa4Properties(c, "at", f);
  assert.deepEqual(out.map((p) => [p.name, p.displayName, p.account]), [["properties/1", "One", "A"], ["properties/3", "Three", "B"]]);
  assert.match(urls[0], /^http:\/\/g\/v1beta\/accountSummaries\?pageSize=200$/);
  await assert.rejects(listGa4Properties(c, "at", asFetch(async () => reply(500, {}))), GoogleError);
});

// ---- orchestration against a fake database and Google ----
const aad = { grantId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", googleSub: "sub" };
const cfg = { clientId: "c", clientSecret: "s", authUrl: "", tokenUrl: "http://g/token", revokeUrl: "", apiBase: "http://g/api", ga4DataBase: "http://g/data", ga4AdminBase: "http://g/admin", ring } as GoogleConfig;
const enc = encryptToken(ring, "rt", aad);

function rig(opts: { rpc?: Record<string, (a: Record<string, unknown>) => unknown>; connection?: Record<string, unknown>; lastEnd?: string | null; inserts?: unknown[] } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    begin_sync_run: () => "run-1",
    read_grant_credential: () => [{ grant_id: aad.grantId, ciphertext: enc.ciphertext, key_version: enc.keyVersion, organization_id: aad.workspaceId, google_sub: aad.googleSub }],
    replace_synced_range: (a) => (a.p_rows as unknown[]).length,
    finish_sync_run: () => null,
    ...opts.rpc,
  };
  const connection = { id: "c1", provider: "ga4", external_ref: "properties/42", status: "active", grant_id: aad.grantId, ...opts.connection };
  const builder = (data: unknown): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
    b.insert = (v: unknown) => (opts.inserts?.push(v), b);
    b.single = async () => ({ data: { id: "new" }, error: null });
    b.maybeSingle = async () => ({ data, error: null });
    return b;
  };
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) return { data: null, error: { message: `unexpected ${fn}` } };
      try {
        return { data: h(args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from: (t: string) => builder(t === "analytics_connections" ? connection : opts.lastEnd ? { range_end: opts.lastEnd } : null),
  };
  const account = { supabase, workspaceId: aad.workspaceId, user: { id: "u1" }, role: "owner" } as unknown as Authed;
  return { account, calls };
}
const google = (report: (url: string) => Response, token: () => Response = () => reply(200, { access_token: "at-1" })) =>
  asFetch(async (url: string) => (String(url).startsWith("http://g/token") ? token() : report(String(url))));
const reportOk = () => reply(200, { rowCount: 1, rows: [row("20261113", "/a", 3, 2, 1)] });
const written = (calls: { fn: string }[]) => calls.filter((c) => c.fn === "replace_synced_range").length;

test("runSync(ga4): first run asks 90 days at the data base, one replace call with ga4 rows, no run left open", async () => {
  const { account, calls } = rig();
  const urls: string[] = [];
  const out = await runSync(account, cfg, "c1", { fetchImpl: google((u) => (urls.push(u), reportOk())), now: NOW });
  assert.deepEqual(out, { status: "succeeded", rows: 3, range: { start: "2026-08-17", end: "2026-11-14" }, runId: "run-1" });
  assert.deepEqual(urls, ["http://g/data/v1beta/properties/42:runReport"]);
  const rep = calls.find((c) => c.fn === "replace_synced_range")!;
  assert.equal(rep.args.p_coverage, "complete");
  assert.deepEqual((rep.args.p_rows as { metric: string }[]).map((r) => r.metric), ["조회수", "세션", "활성 사용자"]);
  assert.equal(calls.some((c) => c.fn === "finish_sync_run"), false);
  assert.deepEqual(syncRange(null, NOW), out.range);
});

test("runSync(ga4): incremental run refetches the last 3 days", async () => {
  const { account } = rig({ lastEnd: "2026-11-12" });
  const out = await runSync(account, cfg, "c1", { fetchImpl: google(reportOk), now: NOW });
  assert.deepEqual(out.range, { start: "2026-11-09", end: "2026-11-14" });
});

test("runSync(ga4): oversized page makes the run partial", async () => {
  const { account, calls } = rig();
  const long = () => reply(200, { rows: [row("20261113", "/a"), row("20261113", "/" + "x".repeat(GA4_SYNC.maxPageChars))] });
  const out = await runSync(account, cfg, "c1", { fetchImpl: google(long), now: NOW });
  assert.equal(out.status, "partial");
  assert.equal(calls.find((c) => c.fn === "replace_synced_range")!.args.p_coverage, "partial");
});

async function failure(f: typeof fetch, o: Parameters<typeof rig>[0] = {}) {
  const { account, calls } = rig(o);
  const e = await runSync(account, cfg, "c1", { fetchImpl: f, now: NOW }).then(
    () => null,
    (x) => x as SyncError,
  );
  assert.ok(e instanceof SyncError, "expected SyncError");
  assert.equal(written(calls), 0, "a failed run must not write rows");
  return { e, finish: calls.find((c) => c.fn === "finish_sync_run")?.args };
}

test("runSync(ga4): 401 and scope-403 -> NEEDS_REAUTH + needs_reauth; invalid_grant too", async () => {
  for (const f of [
    google(() => reply(401, {})),
    google(() => reply(403, { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })),
    google(reportOk, () => reply(400, { error: "invalid_grant" })),
  ]) {
    const { e, finish } = await failure(f);
    assert.deepEqual([e.status, e.code], [409, "NEEDS_REAUTH"]);
    assert.deepEqual([finish?.p_status, finish?.p_connection_status], ["failed", "needs_reauth"]);
  }
});

test("runSync(ga4): property access 403 -> failed PROVIDER_FORBIDDEN without reauth; 429 -> delayed; 5xx -> PROVIDER_ERROR", async () => {
  const forb = await failure(google(() => reply(403, { error: { status: "PERMISSION_DENIED" } })));
  assert.deepEqual([forb.e.status, forb.e.code, forb.e.runStatus, forb.finish?.p_connection_status], [502, "PROVIDER_FORBIDDEN", "failed", null]);
  const q = await failure(google(() => reply(429, {})));
  assert.deepEqual([q.e.code, q.e.runStatus, q.finish?.p_status], ["PROVIDER_QUOTA", "delayed", "delayed"]);
  const s = await failure(google(() => reply(500, {})));
  assert.deepEqual([s.e.code, s.finish?.p_status], ["PROVIDER_ERROR", "failed"]);
});

test("runSync(ga4): over the cap is refused before the write (422) and the run is closed", async () => {
  const { e, finish } = await failure(google(() => reply(200, { rowCount: GA4_SYNC.metricRowCap / GA4_SYNC.metricsPerPair + 1, rows: [row("20261113", "/a")] })));
  assert.deepEqual([e.status, e.code], [422, "SYNC_CAP_EXCEEDED"]);
  assert.equal(finish?.p_error_code, "SYNC_CAP_EXCEEDED");
});

test("runSync(ga4): a stored external_ref that is not properties/<digits> is refused before any run or Google call", async () => {
  const { account, calls } = rig({ connection: { external_ref: "properties/12/../x" } });
  let hit = false;
  const f = asFetch(async () => ((hit = true), reply(200, {})));
  await assert.rejects(runSync(account, cfg, "c1", { fetchImpl: f, now: NOW }), (e) => e instanceof SyncError && e.code === "CONNECTION_INVALID");
  assert.equal(hit, false);
  assert.equal(calls.length, 0);
});

test("runSync(ga4): cooldown / running come from the database and never touch Google", async () => {
  for (const [msg, code] of [["SYNC_COOLDOWN", "SYNC_COOLDOWN"], ["SYNC_RUNNING", "SYNC_IN_PROGRESS"]] as const) {
    const { account } = rig({
      rpc: {
        begin_sync_run: () => {
          throw new Error(msg);
        },
      },
    });
    let hit = false;
    const f = asFetch(async () => ((hit = true), reply(200, {})));
    await assert.rejects(runSync(account, cfg, "c1", { fetchImpl: f, now: NOW }), (e) => e instanceof SyncError && e.status === 409 && e.code === code);
    assert.equal(hit, false);
  }
});

test("createGa4Connection: rejects a malformed property before any Google call or insert", async () => {
  const inserts: unknown[] = [];
  const { account } = rig({ inserts });
  await assert.rejects(createGa4Connection(account, cfg, { grantId: aad.grantId, propertyName: "properties/abc", blogId: null }), (e) => e instanceof AnalyticsError && e.code === "site_not_allowed");
  assert.equal(inserts.length, 0);
});
