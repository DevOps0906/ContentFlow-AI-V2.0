import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { bearerAllowed, bearerToken, corsHeaders, mobileOriginIssues, mobileOrigins } from "../src/lib/mobile";
import { supabaseConfigIssues } from "../src/lib/supabase-target";
import { supabaseEnv } from "../src/lib/supabase";
import { proxy } from "../src/proxy";

const E = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ART = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  for (const k of Object.keys(vars)) if (vars[k] === undefined) delete process.env[k];
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
const LOCAL = {
  SUPABASE_URL: "http://localhost:1",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  MOBILE_ALLOWED_ORIGINS: undefined,
};
const req = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => new NextRequest(`http://app.test${path}`, init);

test("bearerToken: parses only a Bearer header", () => {
  assert.equal(bearerToken(new Headers({ authorization: "Bearer abc.def" })), "abc.def");
  assert.equal(bearerToken(new Headers({ authorization: "bearer abc" })), "abc");
  assert.equal(bearerToken(new Headers({ authorization: "Bearer" })), "");
  assert.equal(bearerToken(new Headers({ authorization: "Basic abc" })), null);
  assert.equal(bearerToken(new Headers()), null);
});

test("bearerAllowed: read-only allow list", () => {
  assert.ok(bearerAllowed("GET", "/api/session"));
  assert.ok(bearerAllowed("GET", "/api/articles"));
  assert.ok(bearerAllowed("GET", `/api/articles/${ART}`));
  assert.ok(!bearerAllowed("POST", "/api/articles"));
  assert.ok(!bearerAllowed("PUT", `/api/articles/${ART}`));
  assert.ok(!bearerAllowed("GET", `/api/articles/${ART}/history`));
  assert.ok(!bearerAllowed("GET", "/api/ai/models"));
  assert.ok(!bearerAllowed("POST", "/api/auth/password"));
});

test("CORS: default origins, env override, no header for others", () => {
  assert.deepEqual(mobileOrigins(E({})), ["https://localhost", "capacitor://localhost"]);
  const h = corsHeaders("capacitor://localhost", E({}));
  assert.equal(h?.["Access-Control-Allow-Origin"], "capacitor://localhost");
  assert.match(h?.["Access-Control-Allow-Headers"] ?? "", /Authorization.*X-Workspace-Id/);
  assert.ok(!("Access-Control-Allow-Credentials" in (h ?? {})));
  assert.equal(corsHeaders("https://evil.example", E({})), null);
  assert.equal(corsHeaders(null, E({})), null);
  assert.equal(corsHeaders("https://m.example", E({ MOBILE_ALLOWED_ORIGINS: "https://m.example/" }))?.["Access-Control-Allow-Origin"], "https://m.example");
});

test("cloud rejects http mobile origins (issues + account mode off)", () => {
  const cloudRaw = {
    SUPABASE_URL: "https://abc.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
    APP_URL: "https://app.example.com",
    MOBILE_ALLOWED_ORIGINS: "https://localhost,http://10.0.2.2:3410",
  };
  const cloud = E(cloudRaw);
  assert.equal(mobileOriginIssues(cloud).length, 1);
  assert.equal(supabaseConfigIssues(cloud).length, 1);
  assert.equal(supabaseEnv(cloud), null);
  const ok = E({ ...cloudRaw, MOBILE_ALLOWED_ORIGINS: "https://localhost" });
  assert.deepEqual(supabaseConfigIssues(ok), []);
  assert.ok(supabaseEnv(ok));
  // local Supabase may keep http origins for the emulator
  const local = E({ SUPABASE_URL: "http://localhost:1", SUPABASE_PUBLISHABLE_KEY: "k", MOBILE_ALLOWED_ORIGINS: "http://10.0.2.2:3410" });
  assert.ok(supabaseEnv(local));
});

test("proxy: OPTIONS is 204 with CORS only for an allowed origin", () =>
  withEnv(LOCAL, async () => {
    const ok = await proxy(req("/api/articles", { method: "OPTIONS", headers: { origin: "https://localhost" } }));
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://localhost");
    const bad = await proxy(req("/api/articles", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    assert.equal(bad.status, 204);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  }));

test("proxy: Bearer on a non-allowed route is 403 (with CORS for allowed origin)", () =>
  withEnv(LOCAL, async () => {
    for (const [method, path] of [
      ["POST", "/api/auth/password"],
      ["POST", "/api/ai/generate"],
      ["POST", "/api/wordpress/draft"],
      ["POST", "/api/articles"],
      ["PUT", `/api/articles/${ART}`],
      ["GET", "/api/team"],
    ]) {
      const r = await proxy(
        req(path, { method, headers: { authorization: "Bearer t", origin: "capacitor://localhost" } }),
      );
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.headers.get("access-control-allow-origin"), "capacitor://localhost");
    }
  }));

test("proxy: Bearer + cookie on an allowed route passes without reading the cookie", () =>
  withEnv(LOCAL, async () => {
    for (const path of ["/api/session", "/api/articles", `/api/articles/${ART}`]) {
      const r = await proxy(
        req(path, { headers: { authorization: "Bearer t", cookie: "sb-localhost-auth-token=garbage" } }),
      );
      assert.equal(r.status, 200, path); // NextResponse.next(): the route verifies the token
      assert.equal(r.headers.get("set-cookie"), null);
    }
    const tok = await proxy(req("/api/auth/token/revoke", { method: "POST", headers: { authorization: "Bearer t" } }));
    assert.equal(tok.status, 200);
  }));

test("proxy: no Bearer keeps the cookie gate (401 for API, CORS only when allowed)", () =>
  withEnv(LOCAL, async () => {
    const r = await proxy(req("/api/articles", { headers: { origin: "https://localhost" } }));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://localhost");
    const r2 = await proxy(req("/api/articles", { headers: { origin: "https://evil.example" } }));
    assert.equal(r2.status, 401);
    assert.equal(r2.headers.get("access-control-allow-origin"), null);
  }));

// ---- workspace resolution for Bearer ---------------------------------------------------------
import { activeWorkspace, WorkspaceError } from "../src/lib/supabase";
import { ipLimit } from "../src/lib/token-session";
import { readMobileApp } from "../src/lib/mobile-app";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeClient(rows: { workspace_id: string; role: string }[]) {
  const calls: string[] = [];
  const q = {
    select: () => q,
    eq: () => q,
    order: () => Promise.resolve({ data: rows, error: null }),
    insert: () => {
      calls.push("insert");
      return Promise.resolve({ error: null });
    },
  };
  return { calls, client: { from: () => q } as never };
}
const USER = { id: "u1" } as never;

test("Bearer workspace: none -> 409 and nothing is created", async () => {
  const f = fakeClient([]);
  await assert.rejects(activeWorkspace(f.client, USER, { wanted: null }), (e: unknown) => e instanceof WorkspaceError && e.status === 409);
  assert.deepEqual(f.calls, []);
});
test("Bearer workspace: named non-member -> 403, member ok, none named -> first", async () => {
  const f = fakeClient([{ workspace_id: "w1", role: "owner" }, { workspace_id: "w2", role: "viewer" }]);
  await assert.rejects(activeWorkspace(f.client, USER, { wanted: "w9" }), (e: unknown) => e instanceof WorkspaceError && e.status === 403);
  assert.deepEqual(await activeWorkspace(f.client, USER, { wanted: "w2" }), { id: "w2", role: "viewer" });
  assert.deepEqual(await activeWorkspace(f.client, USER, { wanted: null }), { id: "w1", role: "owner" });
});

test("ipLimit: spoofed forwarding headers are ignored unless TRUST_PROXY=true", () => {
  const r = new Request("http://x/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" } });
  assert.deepEqual(ipLimit(r, 10, 60, E({})), { key: "ip:direct", max: 60 });
  assert.deepEqual(ipLimit(r, 30, 120, E({})), { key: "ip:direct", max: 120 });
  assert.deepEqual(ipLimit(r, 10, 60, E({ TRUST_PROXY: "true" })), { key: "ip:2.2.2.2", max: 10 });
  const r2 = new Request("http://x/", { headers: { "x-real-ip": "3.3.3.3" } });
  assert.deepEqual(ipLimit(r2, 10, 60, E({ TRUST_PROXY: "true" })), { key: "ip:3.3.3.3", max: 10 });
  assert.deepEqual(ipLimit(new Request("http://x/"), 10, 60, E({ TRUST_PROXY: "true" })), { key: "ip:direct", max: 60 });
});

// ---- APK distribution --------------------------------------------------------------------------
test("mobile app files: none / ok / hash mismatch / bad json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-apk-"));
  try {
    assert.equal((await readMobileApp(E({}))).status, "none");
    assert.equal((await readMobileApp(E({ MOBILE_APK_DIR: join(dir, "missing") }))).status, "none");
    const apk = Buffer.from("fake apk bytes");
    writeFileSync(join(dir, "app.apk"), apk);
    const meta = { version: "0.1.0", versionCode: 1, channel: "dev", sha256: createHash("sha256").update(apk).digest("hex"), builtAt: "2026-11-12T00:00:00Z" };
    writeFileSync(join(dir, "app.json"), JSON.stringify(meta));
    const ok = await readMobileApp(E({ MOBILE_APK_DIR: dir }));
    assert.equal(ok.status, "ok");
    if (ok.status === "ok") assert.equal(ok.info.size, apk.length);
    writeFileSync(join(dir, "app.json"), JSON.stringify({ ...meta, sha256: "0".repeat(64) }));
    assert.equal((await readMobileApp(E({ MOBILE_APK_DIR: dir }))).status, "invalid");
    writeFileSync(join(dir, "app.json"), "{nope");
    assert.equal((await readMobileApp(E({ MOBILE_APK_DIR: dir }))).status, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mobile app routes are proxy-gated: Bearer 403, no cookie 401", () =>
  withEnv(LOCAL, async () => {
    const b = await proxy(req("/api/mobile/app/download", { headers: { authorization: "Bearer t" } }));
    assert.equal(b.status, 403);
    const n = await proxy(req("/api/mobile/app"));
    assert.equal(n.status, 401);
  }));
