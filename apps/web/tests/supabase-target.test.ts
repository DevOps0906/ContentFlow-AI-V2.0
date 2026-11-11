import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieSecure, supabaseConfigIssues, supabaseTarget } from "../src/lib/supabase-target";
import { sessionCookieOptions, supabaseEnv } from "../src/lib/supabase";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const K = "sb_publishable_x";

test("target: none without url or key", () => {
  assert.equal(supabaseTarget(env({})), "none");
  assert.equal(supabaseTarget(env({ SUPABASE_URL: "http://localhost:54321" })), "none");
  assert.equal(supabaseTarget(env({ SUPABASE_PUBLISHABLE_KEY: K })), "none");
});

test("target: local hosts", () => {
  for (const u of [
    "http://localhost:54321",
    "http://127.0.0.1:54321",
    "http://[::1]:54321",
    "http://host.docker.internal:54321",
  ])
    assert.equal(supabaseTarget(env({ SUPABASE_URL: u, SUPABASE_PUBLISHABLE_KEY: K })), "local", u);
});

test("target: cloud otherwise", () => {
  assert.equal(
    supabaseTarget(env({ SUPABASE_URL: "https://abc.supabase.co", SUPABASE_PUBLISHABLE_KEY: K })),
    "cloud",
  );
});

const cloud = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_PUBLISHABLE_KEY: K };

test("issues: cloud needs https APP_URL and https URL", () => {
  assert.deepEqual(supabaseConfigIssues(env({ ...cloud, APP_URL: "https://app.example.com" })), []);
  assert.equal(supabaseConfigIssues(env(cloud)).length, 1);
  assert.equal(supabaseConfigIssues(env({ ...cloud, APP_URL: "http://app.example.com" })).length, 1);
  assert.equal(
    supabaseConfigIssues(env({ ...cloud, SUPABASE_URL: "http://abc.supabase.co", APP_URL: "https://a.com" })).length,
    1,
  );
});

test("issues: local and none need nothing", () => {
  assert.deepEqual(supabaseConfigIssues(env({})), []);
  assert.deepEqual(
    supabaseConfigIssues(env({ SUPABASE_URL: "http://localhost:54321", SUPABASE_PUBLISHABLE_KEY: K })),
    [],
  );
});

test("issues: secret keys are rejected without echoing values", () => {
  const jwt = (role: string) =>
    `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
  const base = { SUPABASE_URL: "http://localhost:54321" };
  for (const key of ["sb_secret_abc", jwt("service_role")]) {
    const issues = supabaseConfigIssues(env({ ...base, SUPABASE_PUBLISHABLE_KEY: key }));
    assert.equal(issues.length, 1);
    assert.ok(!issues[0].includes(key));
  }
  assert.deepEqual(supabaseConfigIssues(env({ ...base, SUPABASE_PUBLISHABLE_KEY: jwt("anon") })), []);
});

test("cookie secure default follows target; COOKIE_SECURE overrides", () => {
  assert.equal(sessionCookieOptions(env(cloud)).secure, true);
  assert.equal(sessionCookieOptions(env({ ...cloud, COOKIE_SECURE: "false" })).secure, false);
  assert.equal(
    sessionCookieOptions(env({ SUPABASE_URL: "http://localhost:54321", SUPABASE_PUBLISHABLE_KEY: K })).secure,
    false,
  );
  assert.equal(sessionCookieOptions(env({})).secure, false);
  assert.equal(sessionCookieOptions(env({ COOKIE_SECURE: "true" })).secure, true);
});

test("cloud over http disables account mode and is reported", () => {
  const e = env({ SUPABASE_URL: "http://abc.supabase.co", SUPABASE_PUBLISHABLE_KEY: K, APP_URL: "https://a.com" });
  assert.equal(supabaseEnv(e), null);
  assert.ok(supabaseConfigIssues(e).some((i) => i.includes("SUPABASE_URL")));
  assert.ok(supabaseEnv(env({ ...cloud })));
  assert.ok(supabaseEnv(env({ SUPABASE_URL: "http://localhost:54321", SUPABASE_PUBLISHABLE_KEY: K })));
});

test("COOKIE_SECURE parsing and cloud insecure issue", () => {
  assert.equal(cookieSecure(env({ COOKIE_SECURE: "TRUE" })), true);
  assert.equal(cookieSecure(env({ COOKIE_SECURE: "1" })), true);
  assert.equal(cookieSecure(env({ COOKIE_SECURE: "0" })), false);
  const e = { ...cloud, APP_URL: "https://a.com" };
  assert.deepEqual(supabaseConfigIssues(env(e)), []);
  assert.equal(supabaseConfigIssues(env({ ...e, COOKIE_SECURE: "false" })).length, 1);
});
