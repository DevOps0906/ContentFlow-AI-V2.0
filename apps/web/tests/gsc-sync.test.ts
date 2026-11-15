import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fetchGscPairs, GSC_SYNC, GscSyncError, syncRange, toSyncRows } from "../src/lib/gsc-sync";
import { runGscSync, SyncError } from "../src/lib/analytics-sync-server";
import { encryptToken, parseKeyRing } from "../src/lib/token-crypto";
import type { GoogleConfig } from "../src/lib/google-oauth";
import type { Authed } from "../src/lib/api";

const NOW = new Date("2026-11-15T10:00:00Z"); // yesterday = 2026-11-14

// ---- range ----
test("syncRange: first run is the last 90 days ending yesterday", () => {
  const r = syncRange(null, NOW);
  assert.equal(r.end, "2026-11-14");
  assert.equal(r.start, "2026-08-17"); // 90 days inclusive
});

test("syncRange: later runs start refetchDays before the last end; floor and end clamp", () => {
  assert.deepEqual(syncRange("2026-11-10", NOW), { start: "2026-11-07", end: "2026-11-14" });
  assert.deepEqual(syncRange("2026-11-14", NOW), { start: "2026-11-11", end: "2026-11-14" });
  assert.equal(syncRange("2025-01-01", NOW).start, "2026-08-17");
  assert.equal(syncRange("2026-12-31", NOW).start, "2026-11-14");
});

// ---- fetch / paging ----
const cap = (n: number) => n;
type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
const row = (date: string, page: string, clicks = 1, impressions = 10, position = 3): Row => ({ keys: [date, page], clicks, impressions, ctr: clicks / impressions, position });
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const range = { start: "2026-11-01", end: "2026-11-02" };

test("fetchGscPairs: pages with startRow until a short page, results are joined", async () => {
  const bodies: { startRow: number; rowLimit: number; dimensions: string[]; dataState: string }[] = [];
  const big = Array.from({ length: GSC_SYNC.rowLimit }, (_, i) => row("2026-11-01", `https://a.test/p${i}`));
  // cap is raised: this test is about paging, not the row cap
  const f = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    return reply(200, { rows: b.startRow === 0 ? big : [row("2026-11-02", "https://a.test/last")] });
  }) as unknown as typeof fetch;
  const out = await fetchGscPairs("http://g", "at", "sc-domain:x.test", range, f, 1_000_000);
  assert.equal(out.length, GSC_SYNC.rowLimit + 1);
  assert.deepEqual(bodies.map((b) => b.startRow), [0, GSC_SYNC.rowLimit]);
  assert.deepEqual(bodies[0].dimensions, ["date", "page"]);
  assert.equal(bodies[0].dataState, "all");
});

test("fetchGscPairs: no rows is a valid empty result", async () => {
  const out = await fetchGscPairs("http://g", "at", "s", range, (async () => reply(200, {})) as unknown as typeof fetch);
  assert.deepEqual(out, []);
});

test("fetchGscPairs: duplicate (date, page) records merge before storing", async () => {
  const f = (async () => reply(200, { rows: [row("2026-11-01", "https://a.test/x", 2, 10, 2), row("2026-11-01", " https://a.test/x ", 6, 30, 4)] })) as unknown as typeof fetch;
  const out = await fetchGscPairs("http://g", "at", "s", range, f);
  assert.equal(out.length, 1);
  assert.equal(out[0].clicks, 8);
  assert.equal(out[0].impressions, 40);
  assert.equal(out[0].ctr, 0.2);
  assert.equal(out[0].position, 3.5); // (2*10 + 4*30) / 40
  const { rows } = toSyncRows(out);
  assert.equal(rows.length, 4);
  const keys = new Set(rows.map((r) => `${r.metric}|${r.dimension}|${r.measured_on}`));
  assert.equal(keys.size, rows.length);
  assert.equal(rows.find((r) => r.metric === "CTR")?.value, 20);
});

test("fetchGscPairs: over the cap stops before anything is returned", async () => {
  const f = (async () => reply(200, { rows: Array.from({ length: 11 }, (_, i) => row("2026-11-01", `https://a.test/${i}`)) })) as unknown as typeof fetch;
  await assert.rejects(fetchGscPairs("http://g", "at", "s", range, f, cap(40)), (e) => e instanceof GscSyncError && e.kind === "cap"); // 11 pairs x 4 > 40
  assert.equal((await fetchGscPairs("http://g", "at", "s", range, f, cap(44))).length, 11);
});

test("fetchGscPairs: stops with a failure once the total time budget is spent", async () => {
  let t = 0;
  const f = (async () => reply(200, { rows: Array.from({ length: GSC_SYNC.rowLimit }, (_, i) => row("2026-11-01", `https://a.test/${i}`)) })) as unknown as typeof fetch;
  const clock = () => (t += 30_000); // every look at the clock costs 30 s
  await assert.rejects(fetchGscPairs("http://g", "at", "s", range, f, 1_000_000, clock), (e) => e instanceof GscSyncError && e.kind === "failed" && /PROVIDER_TIMEOUT/.test(e.message));
});

test("fetchGscPairs: 401 auth, 429 and 403 rateLimit quota, 5xx failed, garbage bad_response", async () => {
  const kind = async (status: number, body: unknown) => {
    try {
      await fetchGscPairs("http://g", "at", "s", range, (async () => reply(status, body)) as unknown as typeof fetch);
    } catch (e) {
      return (e as GscSyncError).kind;
    }
    return "none";
  };
  assert.equal(await kind(401, {}), "auth");
  assert.equal(await kind(429, {}), "quota");
  assert.equal(await kind(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }), "quota");
  assert.equal(await kind(403, { error: { errors: [{ reason: "forbidden" }] } }), "failed");
  assert.equal(await kind(503, {}), "failed");
  assert.equal(await kind(200, "not json"), "bad_response");
  assert.equal(await kind(200, { rows: [{ keys: ["x"] }] }), "bad_response");
});

test("toSyncRows: ctr as percent, unit names match the CSV import, oversized pages are skipped (partial)", () => {
  const long = "https://a.test/" + "x".repeat(GSC_SYNC.maxPageChars);
  const { rows, skipped } = toSyncRows([
    { date: "2026-11-01", page: "https://a.test/a", clicks: 0, impressions: 5, ctr: 0, position: 12.34567 },
    { date: "2026-11-01", page: long, clicks: 1, impressions: 1, ctr: 1, position: 1 },
  ]);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.metric, r.unit, r.value]), [["클릭수", "회", 0], ["노출수", "회", 5], ["CTR", "%", 0], ["평균 게재순위", "위", 12.3457]]); // a real 0 stays 0
});

// ---- orchestration against a fake database and Google ----
const ring = parseKeyRing(`1:${randomBytes(32).toString("base64")}`)!;
const aad = { grantId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", googleSub: "sub" };
const cfg = { clientId: "c", clientSecret: "s", authUrl: "", tokenUrl: "http://g/token", revokeUrl: "", apiBase: "http://g/api", ring } as GoogleConfig;
const enc = encryptToken(ring, "rt", aad);

function rig(opts: { rpc?: Record<string, (a: Record<string, unknown>) => unknown>; connection?: Record<string, unknown>; lastEnd?: string | null } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    begin_sync_run: () => "run-1",
    read_grant_credential: () => [{ grant_id: aad.grantId, ciphertext: enc.ciphertext, key_version: enc.keyVersion, workspace_id: aad.workspaceId, google_sub: aad.googleSub }],
    replace_synced_range: (a) => (a.p_rows as unknown[]).length,
    finish_sync_run: () => null,
    ...opts.rpc,
  };
  const connection = { id: "c1", provider: "gsc", external_ref: "sc-domain:x.test", status: "active", grant_id: aad.grantId, ...opts.connection };
  const builder = (data: unknown): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
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
/** Fake Google: token endpoint and searchAnalytics. */
const google = (query: () => Response, token: () => Response = () => reply(200, { access_token: "at-1" })) =>
  (async (url: string) => (String(url).startsWith("http://g/token") ? token() : query())) as unknown as typeof fetch;
const rowsOk = () => reply(200, { rows: [row("2026-11-13", "https://x.test/a", 3, 30, 2)] });
const written = (calls: { fn: string }[]) => calls.filter((c) => c.fn === "replace_synced_range").length;

test("runGscSync: first run asks for 90 days, writes in one replace call, returns the contract", async () => {
  const { account, calls } = rig();
  const out = await runGscSync(account, cfg, "c1", { fetchImpl: google(rowsOk), now: NOW });
  assert.deepEqual(out, { status: "succeeded", rows: 4, range: { start: "2026-08-17", end: "2026-11-14" }, runId: "run-1" });
  const begin = calls.find((c) => c.fn === "begin_sync_run")!;
  assert.equal(begin.args.p_range_start, "2026-08-17");
  const rep = calls.find((c) => c.fn === "replace_synced_range")!;
  assert.equal(rep.args.p_coverage, "complete");
  assert.equal(calls.some((c) => c.fn === "finish_sync_run"), false);
});

test("runGscSync: incremental run refetches the last 3 days", async () => {
  const { account, calls } = rig({ lastEnd: "2026-11-12" });
  const out = await runGscSync(account, cfg, "c1", { fetchImpl: google(rowsOk), now: NOW });
  assert.deepEqual(out.range, { start: "2026-11-09", end: "2026-11-14" });
  assert.equal(calls.find((c) => c.fn === "begin_sync_run")!.args.p_range_start, "2026-11-09");
});

test("runGscSync: an empty successful answer is a complete run of 0 rows", async () => {
  const { account } = rig();
  const out = await runGscSync(account, cfg, "c1", { fetchImpl: google(() => reply(200, {})), now: NOW });
  assert.equal(out.rows, 0);
});

async function failure(f: typeof fetch, o: Parameters<typeof rig>[0] = {}) {
  const { account, calls } = rig(o);
  const e = await runGscSync(account, cfg, "c1", { fetchImpl: f, now: NOW }).then(
    () => null,
    (x) => x as SyncError,
  );
  assert.ok(e instanceof SyncError, "expected SyncError");
  // (a database-side refusal still shows one attempted call, which the database rolled back)
  assert.equal(written(calls), o.rpc?.replace_synced_range ? 1 : 0, "a failed run must not write rows");
  return { e, finish: calls.find((c) => c.fn === "finish_sync_run")?.args };
}

test("runGscSync: invalid_grant -> needs_reauth, 409 NEEDS_REAUTH, no rows", async () => {
  const { e, finish } = await failure(google(rowsOk, () => reply(400, { error: "invalid_grant" })));
  assert.equal(e.status, 409);
  assert.equal(e.code, "NEEDS_REAUTH");
  assert.deepEqual([finish?.p_status, finish?.p_connection_status, finish?.p_error_code], ["failed", "needs_reauth", "NEEDS_REAUTH"]);
});

test("runGscSync: Google 401 on the query also asks for a new consent", async () => {
  const { e, finish } = await failure(google(() => reply(401, {})));
  assert.equal(e.code, "NEEDS_REAUTH");
  assert.equal(finish?.p_connection_status, "needs_reauth");
});

test("runGscSync: 429 -> delayed (502 PROVIDER_QUOTA)", async () => {
  const { e, finish } = await failure(google(() => reply(429, {})));
  assert.deepEqual([e.status, e.code, e.runStatus], [502, "PROVIDER_QUOTA", "delayed"]);
  assert.deepEqual([finish?.p_status, finish?.p_connection_status], ["delayed", null]);
});

test("runGscSync: 5xx -> failed (502 PROVIDER_ERROR)", async () => {
  const { e, finish } = await failure(google(() => reply(500, {})));
  assert.deepEqual([e.status, e.code, e.runStatus], [502, "PROVIDER_ERROR", "failed"]);
  assert.equal(finish?.p_status, "failed");
});

test("runGscSync: over the row cap is refused before the write (422) and the run is closed", async () => {
  const many = () => reply(200, { rows: Array.from({ length: GSC_SYNC.metricRowCap / GSC_SYNC.metricsPerPair + 1 }, (_, i) => row("2026-11-13", `https://x.test/${i}`)) });
  const { e, finish } = await failure(google(many));
  assert.deepEqual([e.status, e.code], [422, "SYNC_CAP_EXCEEDED"]);
  assert.equal(finish?.p_error_code, "SYNC_CAP_EXCEEDED");
});

test("runGscSync: a finish_sync_run that returns an error is retried once", async () => {
  let n = 0;
  const { account, calls } = rig({ rpc: { finish_sync_run: () => { if (++n === 1) throw new Error("db down"); return null; } } });
  await assert.rejects(runGscSync(account, cfg, "c1", { fetchImpl: google(() => reply(500, {})), now: NOW }), (e) => e instanceof SyncError && e.code === "PROVIDER_ERROR");
  assert.equal(calls.filter((c) => c.fn === "finish_sync_run").length, 2);
});

test("runGscSync: database cap / duplicate errors close the run and map to 422 / 500", async () => {
  const cap = await failure(google(rowsOk), { rpc: { replace_synced_range: () => { throw new Error("SYNC_CAP_EXCEEDED"); } } });
  assert.equal(cap.e.status, 422);
  assert.equal(cap.finish?.p_status, "failed");
  const dup = await failure(google(rowsOk), { rpc: { replace_synced_range: () => { throw new Error("SYNC_ROWS_DUPLICATE"); } } });
  assert.equal(dup.e.status, 500);
  assert.ok(dup.finish);
});

test("runGscSync: begin_sync_run refusals map to the contract and never touch Google", async () => {
  for (const [msg, status, code] of [["SYNC_COOLDOWN", 409, "SYNC_COOLDOWN"], ["SYNC_RUNNING", 409, "SYNC_IN_PROGRESS"], ["CONNECTION_NOT_ACTIVE", 409, "CONNECTION_NOT_ACTIVE"], ["GRANT_OWNER_INACTIVE", 409, "GRANT_OWNER_INACTIVE"]] as const) {
    const { account, calls } = rig({ rpc: { begin_sync_run: () => { throw new Error(msg); } } });
    let hit = false;
    const f = (async () => { hit = true; return reply(200, {}); }) as unknown as typeof fetch;
    await assert.rejects(runGscSync(account, cfg, "c1", { fetchImpl: f, now: NOW }), (e) => e instanceof SyncError && e.status === status && e.code === code);
    assert.equal(hit, false);
    assert.equal(calls.some((c) => c.fn === "finish_sync_run"), false);
  }
});

test("runGscSync: a connection that needs reauth is refused without a run", async () => {
  const { account, calls } = rig({ connection: { status: "needs_reauth" } });
  await assert.rejects(runGscSync(account, cfg, "c1", { now: NOW }), (e) => e instanceof SyncError && e.code === "CONNECTION_NOT_ACTIVE");
  assert.equal(calls.length, 0);
});
