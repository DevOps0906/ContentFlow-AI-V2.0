import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { desktopHealthHmac, safeEqual } from "../src/lib/desktop";
import { proxy } from "../src/proxy";

const TOKEN = "ab".repeat(32);
const HOST = "127.0.0.1:34110";
const ENV = { DESKTOP_TOKEN: TOKEN, DESKTOP_PORT: "34110", SUPABASE_URL: undefined, SUPABASE_PUBLISHABLE_KEY: undefined };

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://127.0.0.1:34110${path}`, { headers });

test("no DESKTOP_TOKEN: behavior unchanged", () =>
  withEnv({ ...ENV, DESKTOP_TOKEN: undefined }, async () => {
    assert.equal((await proxy(req("/api/anything", { host: "evil.com" }))).status, 200);
    assert.equal((await proxy(req("/_next/static/a.js"))).status, 200);
  }));

test("token set: missing or wrong cookie is 403, correct cookie passes", () =>
  withEnv(ENV, async () => {
    assert.equal((await proxy(req("/", { host: HOST }))).status, 403);
    assert.equal((await proxy(req("/", { host: HOST, cookie: "cf_desktop=nope" }))).status, 403);
    assert.equal((await proxy(req("/", { host: HOST, cookie: `cf_desktop=${TOKEN}` }))).status, 200);
  }));

test("token set: wrong Host is 403 even with a valid cookie", () =>
  withEnv(ENV, async () => {
    for (const host of ["evil.com:34110", "localhost:34110", "127.0.0.1:1234", "127.0.0.1"]) {
      assert.equal((await proxy(req("/", { host, cookie: `cf_desktop=${TOKEN}` }))).status, 403, host);
    }
  }));

test("token set: applies to static assets and API", () =>
  withEnv(ENV, async () => {
    for (const p of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/logo.png", "/api/articles"]) {
      assert.equal((await proxy(req(p, { host: HOST }))).status, 403, p);
      assert.equal((await proxy(req(p, { host: HOST, cookie: `cf_desktop=${TOKEN}` }))).status, 200, p);
    }
  }));

test("/desktop-auth: right t sets cookie and 302, wrong t is 403", () =>
  withEnv(ENV, async () => {
    const ok = await proxy(req(`/desktop-auth?t=${TOKEN}`, { host: HOST }));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), `http://${HOST}/`);
    const c = ok.headers.get("set-cookie") ?? "";
    assert.match(c, new RegExp(`cf_desktop=${TOKEN}`));
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=strict/i);
    assert.match(c, /Path=\//);
    assert.equal((await proxy(req("/desktop-auth?t=wrong", { host: HOST }))).status, 403);
    assert.equal((await proxy(req("/desktop-auth", { host: HOST }))).status, 403);
    assert.equal((await proxy(req(`/desktop-auth?t=${TOKEN}`, { host: "evil.com:34110" }))).status, 403);
  }));

test("/api/health?nonce returns HMAC-SHA256(token, nonce) without a cookie", () =>
  withEnv(ENV, async () => {
    const r = await proxy(req("/api/health?nonce=n123", { host: HOST }));
    assert.equal(r.status, 200);
    const body = (await r.json()) as { hmac: string };
    assert.equal(body.hmac, createHmac("sha256", TOKEN).update("n123").digest("hex"));
    assert.equal(body.hmac, desktopHealthHmac(TOKEN, "n123"));
    assert.equal((await proxy(req("/api/health?nonce=n", { host: "evil.com:34110" }))).status, 403);
  }));

test("fail closed: defined but malformed token or port is 503 on every path", async () => {
  for (const vars of [
    { ...ENV, DESKTOP_TOKEN: "" },
    { ...ENV, DESKTOP_TOKEN: "abcd" },
    { ...ENV, DESKTOP_TOKEN: "zz".repeat(32) },
    { ...ENV, DESKTOP_PORT: "abc" },
    { ...ENV, DESKTOP_PORT: "" },
  ]) {
    await withEnv(vars, async () => {
      for (const p of ["/", "/api/health?nonce=n", "/_next/static/a.js"]) {
        assert.equal((await proxy(req(p, { host: HOST, cookie: `cf_desktop=${TOKEN}` }))).status, 503, p);
      }
    });
  }
});

test("/api/health without nonce passes Host check only; wrong Host is 403", () =>
  withEnv(ENV, async () => {
    assert.equal((await proxy(req("/api/health", { host: HOST }))).status, 200);
    assert.equal((await proxy(req("/api/health", { host: "evil.com:34110" }))).status, 403);
  }));

test("POST /desktop-auth and POST /api/health?nonce= are 403", () =>
  withEnv(ENV, async () => {
    const post = (p: string) => new NextRequest(`http://127.0.0.1:34110${p}`, { method: "POST", headers: { host: HOST } });
    assert.equal((await proxy(post(`/desktop-auth?t=${TOKEN}`))).status, 403);
    assert.equal((await proxy(post("/api/health?nonce=n"))).status, 403);
  }));

test("safeEqual: constant-time comparison semantics", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual(null, "abc"));
  assert.ok(!safeEqual(undefined, ""));
});
