import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryError } from "../src/lib/delivery";
import {
  BACKOFF_CAP_MS,
  classify,
  decide,
  hasDue,
  idOf,
  nextAttemptAt,
  remoteKey,
  retryAfterMs,
  viewOf,
} from "../src/lib/publish-queue";

const NOW = Date.parse("2026-11-13T00:00:00Z");
const mid = () => 0.5; // no jitter

test("remoteKey: lowercase host, no trailing slash, path kept", () => {
  assert.equal(remoteKey("https://Blog.Example.COM/"), "https://blog.example.com");
  assert.equal(remoteKey(" https://example.com/wp/ "), "https://example.com/wp");
  assert.equal(remoteKey("https://example.com:443"), "https://example.com");
  assert.equal(remoteKey("https://a.com"), remoteKey("https://A.com//"));
  assert.throws(() => remoteKey("not a url"));
});

test("nextAttemptAt: exponential from 30s, capped at 15 min", () => {
  const ms = (n: number) => nextAttemptAt(n, null, NOW, mid).getTime() - NOW;
  assert.equal(ms(1), 30_000);
  assert.equal(ms(2), 60_000);
  assert.equal(ms(3), 120_000);
  assert.equal(ms(6), BACKOFF_CAP_MS); // 30s * 32 = 16 min, capped
  assert.equal(ms(10), BACKOFF_CAP_MS);
});

test("nextAttemptAt: jitter stays within +-20% and never past the cap", () => {
  assert.equal(nextAttemptAt(1, null, NOW, () => 0).getTime() - NOW, 24_000);
  assert.equal(nextAttemptAt(1, null, NOW, () => 1).getTime() - NOW, 36_000);
  assert.equal(nextAttemptAt(9, null, NOW, () => 1).getTime() - NOW, BACKOFF_CAP_MS);
});

test("nextAttemptAt: Retry-After seconds and dates are respected when longer", () => {
  assert.equal(nextAttemptAt(1, "120", NOW, mid).getTime() - NOW, 120_000);
  assert.equal(nextAttemptAt(1, "5", NOW, mid).getTime() - NOW, 30_000);
  const date = new Date(NOW + 600_000).toUTCString();
  assert.equal(nextAttemptAt(1, date, NOW, mid).getTime() - NOW, 600_000);
  assert.equal(retryAfterMs("soon", NOW), null);
  assert.equal(retryAfterMs(null, NOW), null);
  assert.equal(retryAfterMs(new Date(NOW - 5000).toUTCString(), NOW), 0);
});

test("classify: status codes", () => {
  for (const s of [401, 403]) assert.equal(classify(s), "attention");
  for (const s of [429, 500, 502, 503, 408]) assert.equal(classify(s), "retry");
  for (const s of [400, 404, 422]) assert.equal(classify(s), "fail");
});

test("classify: delivery errors by failure type", () => {
  const t = (f: ConstructorParameters<typeof DeliveryError>[0]) => classify(new DeliveryError(f, "x"));
  assert.equal(t("auth"), "attention");
  for (const f of ["rate_limited", "server", "timeout", "network"] as const) assert.equal(t(f), "retry");
  for (const f of ["not_found", "rejected", "not_sendable", "config", "invalid_response", "remote_state"] as const)
    assert.equal(t(f), "fail");
  assert.equal(classify(new Error("boom")), "fail");
});

test("a failed delivery check RPC is retried, not failed, and keeps its type", async () => {
  const { rpcDeliveryCheck } = await import("../src/lib/delivery");
  const check = rpcDeliveryCheck({ rpc: async () => ({ data: null, error: { message: "db down" } }) });
  const err = await check("00000000-0000-0000-0000-000000000000").then(() => null, (e: unknown) => e);
  assert.ok(err instanceof DeliveryError);
  assert.equal(err.failureType, "unknown");
  assert.equal(classify(err), "retry");
  assert.equal(decide(err, 1, 6, NOW, mid).outcome, "retry");
});

test("decide: retry schedules, exhaustion fails, long Retry-After and auth need attention", () => {
  const rate = new DeliveryError("rate_limited", "x", { status: 429, retryAfter: "90" });
  const d = decide(rate, 1, 6, NOW, mid);
  assert.equal(d.outcome, "retry");
  assert.equal(d.retryAt!.getTime() - NOW, 90_000);
  assert.equal(decide(rate, 6, 6, NOW, mid).outcome, "fail");
  const long = new DeliveryError("rate_limited", "x", { status: 429, retryAfter: "7200" });
  assert.equal(decide(long, 1, 6, NOW, mid).outcome, "attention");
  assert.equal(decide(new DeliveryError("auth", "x", { status: 401 }), 1, 6, NOW).outcome, "attention");
  const rejected = decide(new DeliveryError("rejected", "x", { status: 400 }), 1, 6, NOW);
  assert.deepEqual([rejected.outcome, rejected.retryAt], ["fail", null]);
  assert.equal(decide(new Error("?"), 1, 6, NOW).failureType, "unknown");
});

test("viewOf: retry-wait is queued with a later next_attempt_at after a try", () => {
  const later = new Date(NOW + 60_000).toISOString();
  assert.equal(viewOf({ status: "queued", attempts: 1, nextAttemptAt: later }, NOW), "retry_wait");
  assert.equal(viewOf({ status: "queued", attempts: 0, nextAttemptAt: later }, NOW), "queued");
  assert.equal(viewOf({ status: "queued", attempts: 1, nextAttemptAt: new Date(NOW - 1).toISOString() }, NOW), "queued");
  assert.equal(viewOf({ status: "running", attempts: 1, nextAttemptAt: null }, NOW), "running");
  assert.equal(hasDue([{ status: "queued", nextAttemptAt: later }], NOW), false);
  assert.equal(hasDue([{ status: "queued", nextAttemptAt: null }], NOW), true);
});

test("idOf accepts a uuid, a row, rows or a job_id object", () => {
  assert.equal(idOf("a"), "a");
  assert.equal(idOf({ id: "b" }), "b");
  assert.equal(idOf([{ id: "c" }]), "c");
  assert.equal(idOf({ job_id: "d" }), "d");
  assert.equal(idOf(null), null);
  assert.equal(idOf([]), null);
});

test("rowToJob maps the database row (draft_created = done, failure type from last_error)", async () => {
  const { rowToJob } = await import("../src/lib/publish-queue");
  const base = { id: "j", workspace_id: "w1", article_id: "a", remote_key: "k", created_at: "t", updated_at: "t" };
  assert.equal(rowToJob({ ...base, status: "draft_created" }).status, "succeeded");
  assert.equal(rowToJob({ ...base, status: "queued" }).workspaceId, "w1");
  const failed = rowToJob({ ...base, status: "failed", attempts: 6, last_error: "QUEUE_EXHAUSTED: timeout" });
  assert.equal(failed.failureType, "timeout");
  assert.equal(rowToJob({ ...base, status: "queued" }).maxAttempts, 6);
}
);

test("canCancel: queued and needs_attention only", async () => {
  const { canCancel } = await import("../src/lib/publish-queue");
  assert.deepEqual(
    (["queued", "needs_attention", "running", "failed", "cancelled"] as const).map((status) => canCancel({ status })),
    [true, true, false, false, false],
  );
});

test("drainOne reads the article with the job's workspace, not the active one", async () => {
  const { drainOne } = await import("../src/lib/publish-queue-server");
  const seen: string[] = [];
  const job = { id: "j1", workspace_id: "w-other", article_id: "a1", remote_key: "k", status: "running", attempts: 1, created_at: "t", updated_at: "t" };
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => {
      if (table === "articles" && c === "workspace_id") seen.push(String(v));
      return q;
    };
    q.maybeSingle = async () => ({ data: table === "publish_jobs" ? job : null, error: null });
    return q;
  };
  const supabase = {
    from: query,
    rpc: async (fn: string) => ({ data: fn === "claim_publish_job" ? "j1" : "failed", error: null }),
  };
  const account = { supabase, workspaceId: "w-active", user: { id: "u" } } as never;
  const r = await drainOne(account, { baseUrl: "https://example.com", username: "u", appPassword: "p" });
  assert.equal(r.processed, 1);
  assert.deepEqual(seen, ["w-other"]);
});
