import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken, parseKeyRing, reencryptToken, sealValue, TokenCryptoError } from "../src/lib/token-crypto";
import { checkFlow, googleConfig, startFlow, OAUTH_TTL_MS } from "../src/lib/google-oauth";
import { disconnect, reconnectRevoked, rotateGrants, storeGrant } from "../src/lib/analytics-connections-server";
import type { Authed } from "../src/lib/api";

const k = () => randomBytes(32).toString("base64");
const ring1 = parseKeyRing(`1:${k()}`)!;
const aad = { grantId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", googleSub: "1234567890" };

test("key ring: parse, newest wins, malformed is null", () => {
  const a = k();
  const b = k();
  const r = parseKeyRing(`1:${a}, 3:${b}`)!;
  assert.equal(r.latest, 3);
  assert.equal(r.keys.size, 2);
  assert.equal(parseKeyRing(""), null);
  assert.equal(parseKeyRing("1:short"), null);
  assert.equal(parseKeyRing(`0:${a}`), null);
  assert.equal(parseKeyRing(`1:${a},1:${b}`), null);
});

test("encrypt/decrypt round trip, fresh iv each time, no plaintext in the envelope", () => {
  const a = encryptToken(ring1, "1//refresh-token", aad);
  const b = encryptToken(ring1, "1//refresh-token", aad);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.ok(!a.ciphertext.includes("refresh-token"));
  assert.equal(a.keyVersion, 1);
  assert.deepEqual(decryptToken(ring1, a.ciphertext, 1, aad), { token: "1//refresh-token" });
});

test("AAD swap fails: other grant, other workspace, other key version, other google_sub", () => {
  const e = encryptToken(ring1, "secret", aad);
  assert.throws(() => decryptToken(ring1, e.ciphertext, 1, { ...aad, grantId: "33333333-3333-4333-8333-333333333333" }), TokenCryptoError);
  assert.throws(() => decryptToken(ring1, e.ciphertext, 1, { ...aad, workspaceId: "33333333-3333-4333-8333-333333333333" }), TokenCryptoError);
  // the same key bytes filed under another version number: the version is part of the AAD
  const sameKey = new Map([[1, ring1.keys.get(1)!], [2, ring1.keys.get(1)!]]);
  assert.throws(() => decryptToken({ latest: 2, keys: sameKey }, e.ciphertext, 2, aad), TokenCryptoError);
  assert.throws(() => decryptToken(ring1, e.ciphertext, 1, { ...aad, googleSub: "999" }), TokenCryptoError);
  assert.throws(() => decryptToken(ring1, "pending", 1, aad), TokenCryptoError);
  assert.throws(() => decryptToken(ring1, e.ciphertext.slice(0, -2) + "AA", 1, aad), TokenCryptoError);
});

test("key rotation: old version still decrypts, reencrypt moves to the newest, wrong keys fail", () => {
  const old = k();
  const ringOld = parseKeyRing(`1:${old}`)!;
  const ringBoth = parseKeyRing(`1:${old},2:${k()}`)!;
  const e = encryptToken(ringOld, "tok", aad);
  assert.equal(decryptToken(ringBoth, e.ciphertext, 1, aad).token, "tok");
  const next = reencryptToken(ringBoth, e.ciphertext, 1, aad)!;
  assert.equal(next.keyVersion, 2);
  assert.equal(decryptToken(ringBoth, next.ciphertext, 2, aad).token, "tok");
  assert.equal(reencryptToken(ringBoth, next.ciphertext, 2, aad), null);
  assert.throws(() => decryptToken(parseKeyRing(`1:${k()}`)!, e.ciphertext, 1, aad), TokenCryptoError);
});

const cfg = googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "sec", ANALYTICS_TOKEN_KEYS: `1:${k()}` } as unknown as NodeJS.ProcessEnv)!;
const REDIRECT = "http://localhost:3000/api/integrations/google/callback";

test("googleConfig is null without id, secret or keys", () => {
  assert.equal(googleConfig({} as unknown as NodeJS.ProcessEnv), null);
  assert.equal(googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b" } as unknown as NodeJS.ProcessEnv), null);
  assert.equal(googleConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", ANALYTICS_TOKEN_KEYS: `1:${k()}` } as unknown as NodeJS.ProcessEnv), null);
});

test("auth url: PKCE S256, offline, read-only scopes only", () => {
  const f = startFlow(cfg, REDIRECT, "u1", "w1");
  const q = new URL(f.url).searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("scope"), "openid email https://www.googleapis.com/auth/webmasters.readonly");
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.ok(!f.url.includes("sec"), "client secret never in the URL");
  assert.ok(!f.cookie.includes(q.get("state")!), "cookie is sealed");
});

test("state check: ok, then forged / expired / other user / missing / tampered cookie are refused", () => {
  const now = 1_000_000;
  const f = startFlow(cfg, REDIRECT, "u1", "w1", now);
  const state = new URL(f.url).searchParams.get("state");
  const ok = checkFlow(cfg.ring, f.cookie, state, "u1", now + 1000);
  assert.ok(ok.ok && ok.flow.w === "w1");
  assert.deepEqual(checkFlow(cfg.ring, f.cookie, "forged", "u1", now), { ok: false, code: "state_mismatch" });
  assert.deepEqual(checkFlow(cfg.ring, f.cookie, null, "u1", now), { ok: false, code: "state_mismatch" });
  assert.deepEqual(checkFlow(cfg.ring, f.cookie, state, "u1", now + OAUTH_TTL_MS + 1), { ok: false, code: "expired" });
  assert.deepEqual(checkFlow(cfg.ring, f.cookie, state, "attacker", now), { ok: false, code: "user_mismatch" });
  assert.deepEqual(checkFlow(cfg.ring, undefined, state, "u1", now), { ok: false, code: "no_cookie" });
  assert.deepEqual(checkFlow(cfg.ring, f.cookie.slice(0, -3) + "AAA", state, "u1", now), { ok: false, code: "bad_cookie" });
  // a cookie sealed with another key (or forged payload) does not open
  const other = parseKeyRing(`1:${k()}`)!;
  assert.deepEqual(checkFlow(cfg.ring, sealValue(other, { s: state, v: "v", u: "u1", w: "w1", p: "gsc", x: now + 5 }), state, "u1", now), { ok: false, code: "bad_cookie" });
});

// ---- server module against a fake RPC client ----
type Call = { fn: string; args: Record<string, unknown> };
function fakeAccount(handlers: Record<string, (a: Record<string, unknown>) => unknown>, table: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) return { data: null, error: { message: `unexpected ${fn}` } };
      try {
        return { data: h(args), error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error).message) } };
      }
    },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table.connection ?? null, error: null }) }) }) }),
    }),
  };
  return { account: { supabase, workspaceId: aad.workspaceId, user: { id: "u1" }, role: "owner" } as unknown as Authed, calls };
}

test("storeGrant: new grant is encrypted for the id the app chose and stored in one call", async () => {
  let args: Record<string, unknown> = {};
  const { account, calls } = fakeAccount({
    store_credential: (a) => {
      args = a;
      return a.p_grant_id;
    },
  });
  const id = await storeGrant(account, ring1, "cid", "1234567890", "1//rt");
  assert.equal(id, args.p_grant_id);
  assert.deepEqual(calls.map((c) => c.fn), ["store_credential"]);
  assert.equal(decryptToken(ring1, args.p_ciphertext as string, 1, { ...aad, grantId: id }).token, "1//rt");
});

test("storeGrant: existing grant returns another id -> re-encrypted for it and swapped at the stored version", async () => {
  const old = encryptToken(ring1, "old", aad);
  let swapped: Record<string, unknown> = {};
  const { account, calls } = fakeAccount({
    store_credential: () => aad.grantId,
    read_grant_credential: () => [{ grant_id: aad.grantId, ciphertext: old.ciphertext, key_version: 1, workspace_id: aad.workspaceId, google_sub: aad.googleSub }],
    rotate_credential: (a) => {
      swapped = a;
      return true;
    },
  });
  const id = await storeGrant(account, ring1, "cid", "1234567890", "1//new");
  assert.equal(id, aad.grantId);
  assert.deepEqual(calls.map((c) => c.fn), ["store_credential", "read_grant_credential", "rotate_credential"]);
  assert.equal(swapped.p_expected_version, 1);
  assert.equal(decryptToken(ring1, swapped.p_ciphertext as string, 1, aad).token, "1//new");
});

test("rotateGrants swaps old-version grants (compare-and-set on the old version)", async () => {
  const old = parseKeyRing(`1:${k()}`)!;
  const both = { latest: 2, keys: new Map([...old.keys, [2, randomBytes(32)]]) };
  const e = encryptToken(old, "tok", aad);
  let swapped: Record<string, unknown> | null = null;
  const { account } = fakeAccount({
    list_credential_versions: () => [{ grant_id: aad.grantId, key_version: 1 }, { grant_id: "x", key_version: 2 }],
    read_grant_credential: () => [{ grant_id: aad.grantId, ciphertext: e.ciphertext, key_version: 1, workspace_id: aad.workspaceId, google_sub: aad.googleSub }],
    rotate_credential: (a) => {
      swapped = a;
      return true;
    },
  });
  const r = await rotateGrants(account.supabase as never, both, aad.workspaceId);
  assert.deepEqual(r, { rotated: 1, skipped: 0 });
  assert.equal(swapped!.p_expected_version, 1);
  assert.equal(swapped!.p_new_version, 2);
  assert.equal(decryptToken(both, swapped!.p_ciphertext as string, 2, aad).token, "tok");
});

test("disconnect: other connections left -> no revoke; none left + revoke fails -> grant kept (no delete)", async () => {
  const e = encryptToken(ring1, "tok", aad);
  const handlers = (left: number, deleted: string[]) => ({
    disconnect_connection: () => left,
    read_grant_credential: () => [{ grant_id: aad.grantId, ciphertext: e.ciphertext, key_version: 1, workspace_id: aad.workspaceId, google_sub: aad.googleSub }],
    delete_credential: (a: Record<string, unknown>) => void deleted.push(a.p_grant as string),
  });
  const deleted: string[] = [];
  const shared = fakeAccount(handlers(1, deleted), { connection: { grant_id: aad.grantId } });
  assert.deepEqual(await disconnect(shared.account, cfg, "c1", false), { revoke: "kept", grantId: aad.grantId, remaining: 1 });
  assert.equal(shared.calls.some((c) => c.fn === "read_grant_credential"), false);

  const failing = { ...cfg, revokeUrl: "http://127.0.0.1:1/revoke" };
  const last = fakeAccount(handlers(0, deleted), { connection: { grant_id: aad.grantId } });
  assert.deepEqual(await disconnect(last.account, failing, "c1", false), { revoke: "failed", grantId: aad.grantId, remaining: 0 });
  assert.deepEqual(deleted, []);
  const unconfigured = await disconnect(fakeAccount(handlers(0, deleted), { connection: { grant_id: aad.grantId } }).account, null, "c1", false);
  assert.equal(unconfigured.revoke, "failed");
});

test("reconnectRevoked: same blog revives through reconnect_connection; other blog with data gets the hint", async () => {
  const prior = { id: "c1", blog_id: "b1", grant_id: null, provider: "gsc", external_ref: "sc-domain:x.com", status: "revoked", last_attempt_at: null, last_success_at: null, last_error_code: null, created_at: "t" };
  const { account, calls } = fakeAccount({ reconnect_connection: () => null });
  const row = await reconnectRevoked(account, prior, aad.grantId, "b1");
  assert.equal(row.status, "pending");
  assert.deepEqual(calls.map((c) => c.fn), ["reconnect_connection"]);
  const blocked = {
    rpc: async () => ({ data: null, error: null }),
    from: () => ({
      update: () => ({ eq: () => ({ eq: async () => ({ error: { message: "CONNECTION_HAS_DATA", code: "P0001" } }) }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: "내 블로그", domain: "a.com" }, error: null }) }) }),
    }),
  };
  const acc = { ...account, supabase: blocked } as unknown as Authed;
  await assert.rejects(reconnectRevoked(acc, prior, aad.grantId, "b2"), (e: Error & { status?: number }) => e.status === 409 && e.message.includes("내 블로그에 연결되어 데이터가 남아 있습니다"));
});
