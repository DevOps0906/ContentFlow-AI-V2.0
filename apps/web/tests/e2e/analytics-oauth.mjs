// CF-07b A2 e2e: Google (GSC) OAuth connect / callback / property pick / disconnect + revoke, against the
// local Supabase stack (60321) and a FAKE Google server started here. No real Google, no browser needed.
// Prerequisites: local Supabase with migrations through 0026, no other next dev on apps/web.
//   node tests/e2e/analytics-oauth.mjs [outDir]
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const root = resolve(web, "../..");
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3395);
const GOOGLE_PORT = Number(process.env.E2E_GOOGLE_PORT ?? 8092);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OUT = resolve(process.argv[2] ?? resolve(process.env.TEMP ?? "/tmp", "goog-run-" + Date.now().toString(36)));
mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36);
const PW = "goog-Passw0rd-A!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = randomBytes(32).toString("base64");
const GSC = "https://www.googleapis.com/auth/webmasters.readonly";

// ---- fake Google ----------------------------------------------------------------------------
const g = { codes: new Map(), live: new Set(), tokenHits: 0, revokeHits: [], revokeFail: false, pkceOk: 0, n: 0 };
const b64u = (b) => Buffer.from(b).toString("base64url");
const googleServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/oauth/token") {
    g.tokenHits++;
    if (form.get("client_secret") !== "e2e-secret" || form.get("client_id") !== "e2e-client") return send(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const c = g.codes.get(form.get("code"));
      if (!c) return send(400, { error: "invalid_grant" });
      g.codes.delete(form.get("code"));
      const challenge = b64u(createHash("sha256").update(form.get("code_verifier") ?? "").digest());
      if (challenge !== c.challenge) return send(400, { error: "invalid_grant" });
      g.pkceOk++;
      const refresh = `rt-${randomBytes(9).toString("hex")}`;
      g.live.add(refresh);
      const idt = ["h", b64u(JSON.stringify({ sub: c.sub, email: c.email })), "s"].join(".");
      return send(200, { access_token: "at-first", refresh_token: refresh, id_token: idt, scope: `openid email ${GSC}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!g.live.has(form.get("refresh_token"))) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `at-${++g.n}`, expires_in: 3600, token_type: "Bearer" });
    }
    return send(400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/oauth/revoke") {
    const t = form.get("token");
    g.revokeHits.push(t);
    if (g.revokeFail) return send(500, { error: "server_error" });
    g.live.delete(t);
    return send(200, {});
  }
  if (url.pathname === "/api/webmasters/v3/sites") {
    if (!/^Bearer at-/.test(req.headers.authorization ?? "")) return send(401, { error: "unauthorized" });
    return send(200, {
      siteEntry: [
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
        { siteUrl: "https://unverified.example/", permissionLevel: "siteUnverifiedUser" },
      ],
    });
  }
  send(404, {});
});
googleServer.listen(GOOGLE_PORT, "127.0.0.1");
/** What Google would do after the user consents: remember the PKCE challenge, hand back a code. */
function consent(authUrl, sub, email) {
  const q = new URL(authUrl).searchParams;
  const code = `code-${randomBytes(8).toString("hex")}`;
  g.codes.set(code, { challenge: q.get("code_challenge"), sub, email });
  return { code, state: q.get("state") };
}

// ---- helpers --------------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "PASS" });
    console.log(`PASS ${name}${detail ? " :: " + detail : ""} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push({ name, status: "FAIL" });
    console.log(`FAIL ${name} :: ${String(e?.message ?? e).slice(0, 400)}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
function sql(q) {
  return execFileSync("docker", ["exec", "supabase_db_ContentFlow-AI-V2.0", "psql", "-U", "postgres", "-tAc", q], { encoding: "utf8" }).trim();
}
class Client {
  constructor() {
    this.jar = new Map();
  }
  async req(method, path, { body, cookie, redirect = "manual" } = {}) {
    const cookieHeader = cookie ?? [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${APP}${path}`, {
      method,
      redirect,
      headers: { Origin: APP, Cookie: cookieHeader, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies = res.headers.getSetCookie();
    if (cookie === undefined)
      for (const sc of setCookies) {
        const [pair] = sc.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i);
        const value = pair.slice(i + 1);
        if (/Max-Age=0/i.test(sc) || value === "") this.jar.delete(name);
        else this.jar.set(name, value);
      }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // redirect or non-JSON
    }
    return { status: res.status, data, location: res.headers.get("location"), setCookies };
  }
  api = (m, p, body) => this.req(m, p, { body });
}
const reason = (loc) => new URL(loc, APP).searchParams.get("reason");

// ---- next dev (restarted between phases: one dev server per directory) -------------------------
const envFile = readFileSync(resolve(root, ".env"), "utf8");
const publishable = /^SUPABASE_PUBLISHABLE_KEY=(.+)$/m.exec(envFile)?.[1]?.trim();
let server = null;
async function startApp(extra, logName) {
  const log = createWriteStream(resolve(OUT, logName));
  server = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(APP_PORT), "--hostname", "127.0.0.1"], {
    cwd: web,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      SUPABASE_URL: "http://127.0.0.1:60321",
      SUPABASE_PUBLISHABLE_KEY: publishable,
      COOKIE_SECURE: "false",
      ALLOW_SIGNUP: "true",
      APP_URL: APP,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${APP}/login`)).status === 200) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`next dev did not start; log: ${resolve(OUT, logName)}`);
}
async function stopApp() {
  if (!server) return;
  const s = server;
  server = null;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(s.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else s.kill();
  await sleep(1500);
}
async function signup(c, email) {
  const r = await c.api("POST", "/api/auth/signup", { email, password: PW });
  ok(r.status === 200, `signup ${r.status} ${JSON.stringify(r.data)}`);
  const s = await c.api("GET", "/api/session"); // creates the personal workspace on first call
  ok(s.data?.user?.role === "owner", `session ${JSON.stringify(s.data).slice(0, 200)}`);
}
const userId = (email) => sql(`select id from auth.users where email = '${email}'`);
const ownerWs = (email) => sql(`select m.workspace_id from memberships m join auth.users u on u.id = m.user_id where u.email = '${email}' and m.role = 'owner' limit 1`);

const emailA = `ga-${stamp}@example.test`; // owner
const emailB = `gb-${stamp}@example.test`; // attacker (own workspace)
const emailE = `ge-${stamp}@example.test`; // member of A's workspace
const A = new Client();
const B = new Client();
const E = new Client();
const ctx = {};
const redirectUri = `${APP}/api/integrations/google/callback`;
void redirectUri;

try {
  // ===== phase 1: Google not configured =====
  await startApp({}, "next-unconfigured.log");
  await step("미설정: 가입 후 연결 시작·속성 연결은 503, 목록은 configured=false", async () => {
    await signup(A, emailA);
    ctx.wsA = ownerWs(emailA);
    ok(ctx.wsA, "워크스페이스 없음");
    const s = await A.api("POST", "/api/integrations/google/start", {});
    ok(s.status === 503, `start ${s.status}`);
    const p = await A.api("POST", "/api/analytics/connections", { grantId: crypto.randomUUID(), siteUrl: "sc-domain:example.com" });
    ok(p.status === 503, `post ${p.status}`);
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.status === 200 && l.data.configured === false && l.data.connections.length === 0, JSON.stringify(l.data));
    const cb = await A.api("GET", "/api/integrations/google/callback?code=x&state=y");
    ok(cb.status === 503, `callback ${cb.status}`);
  });
  await stopApp();

  // ===== phase 2: configured against the fake Google =====
  await startApp(
    {
      GOOGLE_OAUTH_CLIENT_ID: "e2e-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "e2e-secret",
      ANALYTICS_TOKEN_KEYS: `1:${KEY}`,
      GOOGLE_OAUTH_BASE: `http://127.0.0.1:${GOOGLE_PORT}/oauth`,
      GOOGLE_API_BASE: `http://127.0.0.1:${GOOGLE_PORT}/api`,
    },
    "next-configured.log",
  );

  await step("준비: A 로그인, 공격자 B 가입, 편집자 E 가입 후 A 워크스페이스에 editor로 추가", async () => {
    await A.api("POST", "/api/auth/login", { email: emailA, password: PW }).then((r) => ok(r.status === 200, `login ${r.status}`));
    await signup(B, emailB);
    await signup(E, emailE);
    ctx.wsB = ownerWs(emailB);
    ctx.uA = userId(emailA);
    ctx.uB = userId(emailB);
    ctx.uE = userId(emailE);
    sql(`insert into memberships (workspace_id, user_id, role) values ('${ctx.wsA}', '${ctx.uE}', 'editor')`);
    const sw = await E.api("POST", "/api/workspaces/active", { id: ctx.wsA });
    ok(sw.status === 200, `switch ${sw.status} ${JSON.stringify(sw.data)}`);
    ctx.blog1 = sql(`insert into blogs (workspace_id, platform, domain) values ('${ctx.wsA}', 'wordpress', 'one.example.com') returning id`).split("\n")[0];
    ctx.blog2 = sql(`insert into blogs (workspace_id, platform, domain) values ('${ctx.wsA}', 'wordpress', 'two.example.com') returning id`).split("\n")[0];
    ok(ctx.blog1 && ctx.blog2, "블로그 생성 실패");
  });

  await step("editor: 연결 시작·속성 목록·해제 거부(403), 목록 조회는 가능(canManage=false)", async () => {
    const s = await E.api("POST", "/api/integrations/google/start", {});
    ok(s.status === 403, `start ${s.status}`);
    const sites = await E.api("GET", `/api/integrations/google/sites?grant=${crypto.randomUUID()}`);
    ok(sites.status === 403, `sites ${sites.status}`);
    const d = await E.api("DELETE", `/api/analytics/connections/${crypto.randomUUID()}`);
    ok(d.status === 403, `delete ${d.status}`);
    const l = await E.api("GET", "/api/analytics/connections");
    ok(l.status === 200 && l.data.configured === true && l.data.canManage === false, JSON.stringify(l.data));
  });

  await step("연결 성공: 시작 → 쿠키 플래그 → 콜백 → 암호문만 저장, PKCE 검증됨", async () => {
    const s = await A.api("POST", "/api/integrations/google/start", {});
    ok(s.status === 200 && s.data.url, `start ${s.status}`);
    const sc = s.setCookies.find((c) => c.startsWith("cf_goog_oauth="));
    ok(sc, "state 쿠키 없음");
    ok(/HttpOnly/i.test(sc) && /SameSite=lax/i.test(sc) && /Path=\/api\/integrations\/google/i.test(sc) && /Max-Age=600/i.test(sc), sc.replace(/=[^;]+/, "=…"));
    const u = new URL(s.data.url);
    ok(u.origin === `http://127.0.0.1:${GOOGLE_PORT}`, u.origin);
    ok(u.searchParams.get("scope") === `openid email ${GSC}` && u.searchParams.get("code_challenge_method") === "S256", u.search);
    ok(!sc.includes(u.searchParams.get("state")), "state가 쿠키에 평문");
    const { code, state } = consent(s.data.url, "sub-A-1", "a@google.test");
    const cb = await A.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    ok(cb.status === 303, `callback ${cb.status}`);
    const loc = new URL(cb.location, APP);
    ok(loc.searchParams.get("google") === "connected", cb.location);
    ctx.grant = loc.searchParams.get("grant");
    ok(/^[0-9a-f-]{36}$/.test(ctx.grant), "grant id 없음");
    ok(g.pkceOk === 1, "PKCE 검증 안 됨");
    ok(!A.jar.has("cf_goog_oauth"), "콜백 후 쿠키가 지워지지 않음");
    const row = sql(`select key_version, ciphertext, created_by from analytics_credentials where grant_id = '${ctx.grant}'`).split("|");
    ok(row[0] === "1" && row[1].startsWith("v1.") && !row[1].includes("rt-") && row[2] === ctx.uA, `credential ${row[0]} ${row[1]?.slice(0, 8)}`);
    ctx.rt = [...g.live][0];
  });

  await step("쿠키 없는 콜백 재시도는 거부(no_cookie), 코드 교환 안 함", async () => {
    const before = g.tokenHits;
    const { code, state } = consent((await A.api("POST", "/api/integrations/google/start", {})).data.url, "sub-A-1", "a@google.test");
    A.jar.delete("cf_goog_oauth");
    const cb = await A.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    ok(cb.status === 303 && reason(cb.location) === "no_cookie", cb.location);
    ok(g.tokenHits === before, "토큰 교환이 호출됨");
  });

  await step("공격자 콜백 주입 거부: 쿠키 없음 / state 불일치 / 사용자 불일치, 코드 교환·저장 없음", async () => {
    const credsBefore = sql(`select count(*) from analytics_credentials where workspace_id = '${ctx.wsA}'`);
    const hitsBefore = g.tokenHits;
    // B starts a flow in B's own workspace and gets B's cookie + state + a code for B's Google account.
    const bs = await B.api("POST", "/api/integrations/google/start", {});
    ok(bs.status === 200, `B start ${bs.status}`);
    const bCookie = B.jar.get("cf_goog_oauth");
    const evil = consent(bs.data.url, "sub-attacker", "evil@google.test");
    // 1) victim A (no flow cookie) is tricked into the attacker's callback URL.
    A.jar.delete("cf_goog_oauth");
    let r = await A.api("GET", `/api/integrations/google/callback?code=${evil.code}&state=${evil.state}`);
    ok(reason(r.location) === "no_cookie", `1: ${r.location}`);
    // 2) victim has started their own flow; the attacker's state does not match it.
    const own = await A.api("POST", "/api/integrations/google/start", {});
    ok(own.status === 200, "A start");
    r = await A.api("GET", `/api/integrations/google/callback?code=${evil.code}&state=${evil.state}`);
    ok(reason(r.location) === "state_mismatch", `2: ${r.location}`);
    // 3) the attacker's cookie is planted in the victim's browser: state matches, user does not.
    const sessionOnly = [...A.jar].filter(([k]) => k !== "cf_goog_oauth").map(([k, v]) => `${k}=${v}`).join("; ");
    r = await A.req("GET", `/api/integrations/google/callback?code=${evil.code}&state=${evil.state}`, { cookie: `${sessionOnly}; cf_goog_oauth=${bCookie}` });
    ok(reason(r.location) === "user_mismatch", `3: ${r.location}`);
    ok(g.tokenHits === hitsBefore, "공격 코드가 교환됨");
    ok(g.codes.has(evil.code), "공격 코드가 소비됨");
    ok(sql(`select count(*) from analytics_credentials where workspace_id = '${ctx.wsA}'`) === credsBefore, "A 워크스페이스에 grant가 생김");
    ok(sql(`select count(*) from analytics_credentials where google_sub = 'sub-attacker'`) === "0", "공격자 grant 저장됨");
  });

  await step("위조·변조 state 쿠키 거부(bad_cookie), 비로그인 콜백은 로그인으로", async () => {
    const hitsBefore = g.tokenHits;
    const sessionOnly = [...A.jar].filter(([k]) => k !== "cf_goog_oauth").map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await A.req("GET", `/api/integrations/google/callback?code=x&state=y`, { cookie: `${sessionOnly}; cf_goog_oauth=${randomBytes(60).toString("base64url")}` });
    ok(reason(r.location) === "bad_cookie", r.location);
    const anon = await new Client().req("GET", "/api/integrations/google/callback?code=x&state=y");
    ok(anon.status === 401 || (anon.status >= 300 && anon.status < 400 && /login/.test(anon.location)), `anon ${anon.status}`);
    ok(g.tokenHits === hitsBefore, "교환됨");
  });

  await step("콜백 시점 재확인: 시작 후 owner/admin 아니게 되면 거부(forbidden)", async () => {
    sql(`update memberships set role = 'admin' where workspace_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const s = await E.api("POST", "/api/integrations/google/start", {});
    ok(s.status === 200, `admin start ${s.status}`);
    const { code, state } = consent(s.data.url, "sub-E", "e@google.test");
    sql(`update memberships set role = 'editor' where workspace_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const hitsBefore = g.tokenHits;
    const r = await E.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    ok(reason(r.location) === "forbidden", r.location);
    ok(g.tokenHits === hitsBefore, "교환됨");
  });

  await step("강등된 admin의 grant: 속성 목록은 거부(409), 현재 admin(A)의 revoke·삭제는 성공, editor는 거부", async () => {
    sql(`update memberships set role = 'admin' where workspace_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const s = await E.api("POST", "/api/integrations/google/start", {});
    const { code, state } = consent(s.data.url, "sub-E2", "e2@google.test");
    const cb = await E.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    const gE = new URL(cb.location, APP).searchParams.get("grant");
    ok(gE, `E 연결 실패 ${cb.location}`);
    const live = await E.api("GET", `/api/integrations/google/sites?grant=${gE}`);
    ok(live.status === 200, `admin sites ${live.status}`);
    sql(`update memberships set role = 'editor' where workspace_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const r = await A.api("GET", `/api/integrations/google/sites?grant=${gE}`);
    ok(r.status === 409 && r.data.code === "grant_owner_inactive", `sites ${r.status} ${JSON.stringify(r.data)}`);
    const ed = await E.api("POST", `/api/integrations/google/grants/${gE}/revoke`);
    ok(ed.status === 403, `editor revoke ${ed.status}`);
    const before = g.revokeHits.length;
    const rv = await A.api("POST", `/api/integrations/google/grants/${gE}/revoke`);
    ok(rv.status === 200 && rv.data.revoke === "done" && g.revokeHits.length === before + 1, `revoke ${rv.status} ${JSON.stringify(rv.data)}`);
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${gE}'`) === "0", "grant가 남음");
    g.revokeHits.length = 0;
  });

  await step("속성 목록(미인증 속성 제외) → 허용 목록 밖 속성 거부 → 두 블로그에 같은 grant로 연결", async () => {
    const sites = await A.api("GET", `/api/integrations/google/sites?grant=${ctx.grant}`);
    ok(sites.status === 200, `sites ${sites.status} ${JSON.stringify(sites.data)}`);
    const urls = sites.data.sites.map((x) => x.siteUrl);
    ok(urls.includes("sc-domain:example.com") && !urls.includes("https://unverified.example/"), urls.join(","));
    const bad = await A.api("POST", "/api/analytics/connections", { grantId: ctx.grant, siteUrl: "https://other.test/", blogId: ctx.blog1 });
    ok(bad.status === 400 && bad.data.code === "site_not_allowed", `bad ${bad.status}`);
    const c1 = await A.api("POST", "/api/analytics/connections", { grantId: ctx.grant, siteUrl: "sc-domain:example.com", blogId: ctx.blog1 });
    ok(c1.status === 201 && c1.data.connection.status === "pending", `c1 ${c1.status} ${JSON.stringify(c1.data)}`);
    const c2 = await A.api("POST", "/api/analytics/connections", { grantId: ctx.grant, siteUrl: "https://blog.example.com/", blogId: ctx.blog2 });
    ok(c2.status === 201, `c2 ${c2.status} ${JSON.stringify(c2.data)}`);
    ctx.c1 = c1.data.connection.id;
    ctx.c2 = c2.data.connection.id;
    const dup = await A.api("POST", "/api/analytics/connections", { grantId: ctx.grant, siteUrl: "sc-domain:example.com", blogId: ctx.blog1 });
    ok(dup.status === 409, `dup ${dup.status}`);
    const other = await B.api("GET", `/api/integrations/google/sites?grant=${ctx.grant}`);
    ok(other.status !== 200 && !JSON.stringify(other.data).includes("example.com"), `B가 A의 grant를 읽음 ${other.status}`);
    const asE = await E.api("GET", "/api/analytics/connections");
    ok(asE.data.connections.length === 2 && !JSON.stringify(asE.data).includes("ciphertext"), "편집자 목록");
  });

  await step("해제 1: grant를 쓰는 연결이 남아 있으면 revoke 호출 없음", async () => {
    const r = await A.api("DELETE", `/api/analytics/connections/${ctx.c1}`);
    ok(r.status === 200 && r.data.revoke === "kept", JSON.stringify(r.data));
    ok(g.revokeHits.length === 0, "revoke 호출됨");
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.grant}'`) === "1", "grant 삭제됨");
    ok(sql(`select status from analytics_connections where id = '${ctx.c1}'`) === "revoked", "상태");
  });

  await step("해제 2: 마지막 연결 + Google revoke 실패 → grant 보관, 재시도 표시", async () => {
    g.revokeFail = true;
    const r = await A.api("DELETE", `/api/analytics/connections/${ctx.c2}`);
    ok(r.status === 200 && r.data.revoke === "failed" && r.data.grantId === ctx.grant && r.data.notice, JSON.stringify(r.data));
    ok(g.revokeHits.length === 1 && g.revokeHits[0] === ctx.rt, "복호화한 토큰으로 revoke 호출 안 됨");
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.grant}'`) === "1", "revoke 실패인데 grant 삭제됨");
    ok(g.live.has(ctx.rt), "가짜 Google에서는 아직 유효");
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.data.unusedGrants.includes(ctx.grant), JSON.stringify(l.data.unusedGrants));
    const e = await E.api("POST", `/api/integrations/google/grants/${ctx.grant}/revoke`);
    ok(e.status === 403, `editor retry ${e.status}`);
    const again = await A.api("POST", `/api/integrations/google/grants/${ctx.grant}/revoke`);
    ok(again.status === 200 && again.data.revoke === "failed", JSON.stringify(again.data));
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.grant}'`) === "1", "재시도 실패인데 삭제됨");
  });

  await step("재시도 성공 → Google revoke 수락 후에만 grant 삭제", async () => {
    g.revokeFail = false;
    const r = await A.api("POST", `/api/integrations/google/grants/${ctx.grant}/revoke`);
    ok(r.status === 200 && r.data.revoke === "done", JSON.stringify(r.data));
    ok(!g.live.has(ctx.rt), "토큰이 아직 유효");
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.grant}'`) === "0", "grant가 남음");
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.data.unusedGrants.length === 0, "unusedGrants");
  });

  await step("서버 로그에 refresh token·client secret·키·state 쿠키 없음 (인가 코드는 next dev 요청 로그에 URL로 남음: 1회용·PKCE 결합)", async () => {
    await sleep(500);
    const log = readFileSync(resolve(OUT, "next-configured.log"), "utf8");
    for (const needle of ["rt-", "e2e-secret", KEY, "cf_goog_oauth="]) ok(!log.includes(needle), `로그에 ${needle.slice(0, 4)}… 포함`);
  });
} finally {
  await stopApp();
  googleServer.close();
}

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed; logs in ${OUT}`);
process.exit(failed ? 1 : 0);
