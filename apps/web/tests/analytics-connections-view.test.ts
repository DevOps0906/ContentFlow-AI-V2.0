import { test } from "node:test";
import assert from "node:assert/strict";
import { isAutoSyncDue, parseConnections, runSummary, syncErrorMessage, connectionStatusClass } from "../src/lib/analytics-connections-view";

const now = Date.parse("2026-11-15T12:00:00Z");

test("auto sync is due only for active connections stale for 24h or never synced", () => {
  assert.equal(isAutoSyncDue({ status: "active", last_success_at: "2026-11-15T00:00:00Z" }, now), false);
  assert.equal(isAutoSyncDue({ status: "active", last_success_at: "2026-11-14T12:00:00Z" }, now), true);
  assert.equal(isAutoSyncDue({ status: "active", last_success_at: null }, now), true);
  for (const status of ["needs_reauth", "revoked", "error"]) assert.equal(isAutoSyncDue({ status, last_success_at: null }, now), false);
});

test("a failed or delayed run is N/A, not 0", () => {
  assert.equal(runSummary({ status: "failed", finishedAt: null, rows: 0, errorCode: "PROVIDER_ERROR" }).rows, "N/A");
  assert.equal(runSummary({ status: "delayed", finishedAt: null, rows: 0, errorCode: null }).rows, "N/A");
  assert.equal(runSummary(null).rows, "N/A");
  assert.equal(runSummary({ status: "succeeded", finishedAt: null, rows: 0, errorCode: null }).rows, "0행");
  const p = runSummary({ status: "partial", finishedAt: null, rows: 1200, errorCode: null });
  assert.equal(p.partial, true);
  assert.equal(p.rows, "1,200행");
});

test("sync errors map to messages and unknown codes stay generic", () => {
  assert.match(syncErrorMessage("SYNC_COOLDOWN", 409), /잠시 후/);
  assert.match(syncErrorMessage("SYNC_CAP_EXCEEDED", 422), /30,000/);
  assert.match(syncErrorMessage(undefined, 403), /소유자·관리자/);
  assert.match(syncErrorMessage("x", 500), /500/);
});

test("parseConnections drops malformed rows; status class marks attention states", () => {
  assert.deepEqual(parseConnections(null), []);
  assert.equal(parseConnections([{ id: "a", status: "active" }, { id: 1 }, null]).length, 1);
  assert.equal(connectionStatusClass("needs_reauth"), "warn");
  assert.equal(connectionStatusClass("active"), "approve");
});

test("pending connection without any run is due for its first sync", () => {
  assert.equal(isAutoSyncDue({ status: "pending", last_success_at: null }, now), true);
  assert.equal(isAutoSyncDue({ status: "pending", last_success_at: null, lastRun: { status: "failed" } }, now), false);
});
