import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  adStatuses,
  checkStatuses,
  dbToSiteCheck,
  isStale,
  mergeSiteChecks,
  needsEvidence,
  parseSiteCheck,
  siteCheckItems,
  statusLabels,
  statusesFor,
  summarizeSiteChecks,
  toDbSiteCheck,
  type SiteCheck,
} from "../src/lib/site-checks";
import { canRecordSiteChecks, roles } from "../src/lib/team";
import { SiteChecks } from "../src/components/site-checks";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../../../supabase/migrations/0011_site_checks.sql");
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
const valid = { key: "ads_txt", status: "pass", evidenceUrl: "https://a.example/ads.txt", note: "" };

test("items and statuses match the database constraints", () => {
  const keys = sql.match(/check_key in \(([^)]*)\)/)![1];
  assert.deepEqual(quoted(keys), siteCheckItems.map((i) => i.key).sort());
  const ad = sql.match(/check_key = 'ad_status' and status in \(([^)]*)\)/)![1];
  assert.deepEqual(quoted(ad), [...adStatuses].sort());
  const check = sql.match(/check_key <> 'ad_status' and status in \(([^)]*)\)/)![1];
  assert.deepEqual(quoted(check), [...checkStatuses].sort());
  for (const s of [...adStatuses, ...checkStatuses]) assert.ok(statusLabels[s]);
});

test("workspace, checker and time are never taken from the browser", () => {
  const db = toDbSiteCheck(
    parseSiteCheck({ ...valid, workspace_id: "other", checkedBy: "x", checkedAt: "2000-01-01", checked_by: "x" }),
    "ws",
  );
  assert.deepEqual(Object.keys(db).sort(), ["check_key", "evidence_url", "note", "status", "workspace_id"]);
  assert.equal(db.workspace_id, "ws");
});

test("invalid records are rejected", () => {
  const bad = [
    null,
    {},
    { ...valid, key: "made_up" },
    { ...valid, status: "active" },
    { key: "ad_status", status: "pass", note: "n" },
    { ...valid, evidenceUrl: "javascript:alert(1)" },
    { ...valid, evidenceUrl: "ftp://a.example/x" },
    { ...valid, evidenceUrl: "https://a b.example" },
    { ...valid, evidenceUrl: `https://a.example/${"x".repeat(2000)}` },
    { ...valid, note: "x".repeat(1001) },
    { ...valid, evidenceUrl: "", note: "   " },
    { key: "ad_status", status: "rejected" },
    { key: "ads_txt", status: "not_applicable" },
  ];
  for (const b of bad) assert.throws(() => parseSiteCheck(b), JSON.stringify(b)?.slice(0, 40));
});

test("a verdict needs evidence, but unknown and not configured do not", () => {
  assert.ok(needsEvidence("pass") && needsEvidence("rejected") && needsEvidence("not_applicable"));
  assert.deepEqual(parseSiteCheck({ key: "ads_txt", status: "unknown" }), {
    key: "ads_txt", status: "unknown", evidenceUrl: null, note: null,
  });
  assert.equal(parseSiteCheck({ key: "ad_status", status: "not_configured" }).status, "not_configured");
  assert.equal(parseSiteCheck({ key: "ads_txt", status: "fail", note: " 404 " }).note, "404");
  assert.ok(statusesFor("ad_status").includes("limited") && !statusesFor("ads_txt").includes("limited"));
});

test("only owner and admin can record", () => {
  assert.deepEqual(roles.filter(canRecordSiteChecks), ["owner", "admin"]);
  assert.ok(!canRecordSiteChecks(null));
});

test("items nobody recorded read as unknown with no time, in display order", () => {
  const saved = dbToSiteCheck(
    { check_key: "ad_status", status: "rejected", evidence_url: null, note: "통지", checked_by: "u", checked_at: "2026-11-01T00:00:00Z" },
    "owner@example.com",
  );
  const all = mergeSiteChecks([saved]);
  assert.deepEqual(all.map((c) => c.key), siteCheckItems.map((i) => i.key));
  assert.equal(all.find((c) => c.key === "ad_status")!.checkedBy, "owner@example.com");
  const other = all.find((c) => c.key === "ads_txt")!;
  assert.equal(other.status, "unknown");
  assert.equal(other.checkedAt, null);
});

test("old records are flagged for another look, unrecorded ones are not", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  assert.ok(isStale("2026-08-01T00:00:00Z", now));
  assert.ok(!isStale("2026-10-01T00:00:00Z", now));
  assert.ok(!isStale(null, now));
  const base: SiteCheck = { key: "ads_txt", status: "fail", evidenceUrl: null, note: "n", checkedBy: null, checkedAt: "2026-08-01T00:00:00Z" };
  assert.deepEqual(summarizeSiteChecks([base, { ...base, status: "pass", checkedAt: null }], now), {
    recorded: 1, failed: 1, stale: 1,
  });
});

test("ad status and site checks stay out of the article rules and delivery path", () => {
  assert.ok(!/\barticles\b/i.test(sql.replace(/--.*$/gm, "")));
  const path = [
    "../src/lib/lifecycle.ts",
    "../src/lib/qa.ts",
    "../src/lib/delivery.ts",
    "../src/lib/render.ts",
    "../src/lib/wordpress.ts",
    "../src/lib/tistory.ts",
    "../src/lib/articles-db.ts",
    "../src/app/api/wordpress/draft/route.ts",
    "../src/app/api/articles/[id]/route.ts",
    "../src/app/api/articles/[id]/delivery-check/route.ts",
  ];
  for (const p of path) assert.ok(!/site[-_]?checks?|ad_status|adStatus/i.test(read(p)), p);
});

test("local mode shows the account-only empty state and no controls", () => {
  const html = renderToStaticMarkup(createElement(SiteChecks, { account: false }));
  assert.match(html, /계정 모드에서 사용 가능/);
  assert.doesNotMatch(html, /<(form|select|input|button)/);
});
