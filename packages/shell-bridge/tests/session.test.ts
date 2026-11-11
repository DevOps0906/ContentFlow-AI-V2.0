import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createSession, SessionExpiredError } from "../src/session.ts";
import { createMemoryStore } from "../src/web.ts";

function tokenBody(access: string, refresh: string, expiresAt: number) {
  return { access_token: access, refresh_token: refresh, expires_at: expiresAt, user: { email: "a@b.co" } };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const nowRef = { t: 1000 };
  const store = createMemoryStore();
  const session = createSession({
    apiBase: "https://api.test",
    store,
    now: () => nowRef.t,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { calls, store, session, nowRef };
}

test("memory store: get/set/remove", async () => {
  const s = createMemoryStore();
  assert.equal(await s.get("k"), null);
  await s.set("k", "v");
  assert.equal(await s.get("k"), "v");
  await s.remove("k");
  assert.equal(await s.get("k"), null);
});

test("login stores tokens; restore returns email", async () => {
  const { session, store } = setup(async () => jsonRes(tokenBody("a1", "r1", 5000)));
  assert.equal(await session.login("a@b.co", "pw"), "a@b.co");
  assert.ok(await store.get("cf.session"));
  assert.equal(await session.restore(), "a@b.co");
});

test("refresh is single-flight: concurrent callers share one request", async () => {
  let refreshCalls = 0;
  const { session, calls } = setup(async (url) => {
    if (url.endsWith("/api/auth/token")) return jsonRes(tokenBody("a1", "r1", 1010)); // near expiry
    if (url.endsWith("/api/auth/token/refresh")) {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return jsonRes(tokenBody("a2", "r2", 9000));
    }
    return jsonRes({ ok: true });
  });
  await session.login("a@b.co", "pw");
  const results = await Promise.all([
    session.request("/api/session"),
    session.request("/api/articles"),
    session.refresh(),
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(results.length, 3);
  const bearer = calls
    .filter((c) => c.url.endsWith("/api/session"))
    .map((c) => new Headers(c.init.headers).get("Authorization"));
  assert.deepEqual(bearer, ["Bearer a2"]);
});

test("401 triggers one refresh and one retry", async () => {
  let n = 0;
  const { session } = setup(async (url, init) => {
    if (url.endsWith("/api/auth/token")) return jsonRes(tokenBody("a1", "r1", 9000));
    if (url.endsWith("/refresh")) return jsonRes(tokenBody("a2", "r2", 9000));
    n++;
    return new Headers(init.headers).get("Authorization") === "Bearer a2" ? jsonRes({ ok: 1 }) : jsonRes({}, 401);
  });
  await session.login("a@b.co", "pw");
  const res = await session.request("/api/articles");
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test("refresh rejected clears the session", async () => {
  const { session, store, nowRef } = setup(async (url) =>
    url.endsWith("/api/auth/token") ? jsonRes(tokenBody("a1", "r1", 1010)) : jsonRes({ error: "x" }, 401),
  );
  await session.login("a@b.co", "pw");
  nowRef.t = 2000;
  await assert.rejects(session.request("/api/session"), SessionExpiredError);
  assert.equal(await store.get("cf.session"), null);
  assert.equal(await session.restore(), null);
});

test("login failure surfaces the server message", async () => {
  const { session } = setup(async () => jsonRes({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, 401));
  await assert.rejects(session.login("a@b.co", "bad"), (e: unknown) => e instanceof ApiError && e.status === 401);
});

test("logout revokes then clears", async () => {
  const { session, calls, store } = setup(async (url) =>
    url.endsWith("/api/auth/token") ? jsonRes(tokenBody("a1", "r1", 9000)) : jsonRes({ ok: true }),
  );
  await session.login("a@b.co", "pw");
  await session.logout();
  assert.ok(calls.some((c) => c.url.endsWith("/api/auth/token/revoke")));
  assert.equal(await store.get("cf.session"), null);
});

test("logout during an in-flight refresh: the refresh does not revive the session", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { session, store, nowRef } = setup(async (url) => {
    if (url.endsWith("/api/auth/token")) return jsonRes(tokenBody("a1", "r1", 1010));
    if (url.endsWith("/api/auth/token/refresh")) {
      await gate;
      return jsonRes(tokenBody("a2", "r2", 9000));
    }
    return jsonRes({ ok: true });
  });
  await session.login("a@b.co", "pw");
  nowRef.t = 2000;
  const refreshing = session.refresh();
  await new Promise((r) => setTimeout(r, 5));
  await session.logout();
  release();
  await assert.rejects(refreshing, SessionExpiredError);
  assert.equal(await store.get("cf.session"), null);
  assert.equal(await session.restore(), null);
});
