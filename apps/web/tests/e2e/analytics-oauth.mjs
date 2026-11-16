// CF-07b A2 e2e: Google (GSC) OAuth connect / callback / property pick / disconnect + revoke, against the
// local Supabase stack (60321) and a FAKE Google server started here. No real Google, no browser needed.
// Prerequisites: local Supabase with migrations through 0026, no other next dev on apps/web.
//   node tests/e2e/analytics-oauth.mjs [outDir]
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const root = resolve(web, "../..");
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3395);
const GOOGLE_PORT = Number(process.env.E2E_GOOGLE_PORT ?? 8092);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OUT = resolve(process.argv[2] ?? resolve(root, ".nomad/logs/analytics-oauth"));
const SHOTS = resolve(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const PW = "goog-Passw0rd-A!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = randomBytes(32).toString("base64");
const GSC = "https://www.googleapis.com/auth/webmasters.readonly";
const ADS = "https://www.googleapis.com/auth/adsense.readonly";
const GA4 = "https://www.googleapis.com/auth/analytics.readonly";

// ---- fake Google ----------------------------------------------------------------------------
const g = { codes: new Map(), live: new Set(), tokenHits: 0, revokeHits: [], revokeFail: false, pkceOk: 0, n: 0, gscMode: "ok", gscSeed: 1, queries: [], adsPage: "ok", adsCurrency: "USD", adsTz: "Asia/Seoul", adsSeed: 1, adsQueries: [], grantScope: null, ga4Mode: "ok", ga4Seed: 1, ga4PageSize: 50, ga4Queries: [] };
const b64u = (b) => Buffer.from(b).toString("base64url");
const googleServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const form = new URLSearchParams(raw);
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
      return send(200, { access_token: "at-first", refresh_token: refresh, id_token: idt, scope: g.grantScope ?? c.scope, expires_in: 3600, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!g.live.has(form.get("refresh_token"))) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `at-${++g.n}`, expires_in: 3600, token_type: "Bearer" });
    }
    return send(400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/oauth/auth") {
    // the consent screen, auto-approved: what Google does after the user clicks "Allow"
    const { code, state } = consent(url.href, "sub-A-browser", "a-browser@google.test");
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    res.writeHead(302, { Location: back.href });
    return res.end();
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
  const q = /^\/api\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
  if (q) {
    if (!/^Bearer at-/.test(req.headers.authorization ?? "")) return send(401, { error: "unauthorized" });
    const body = JSON.parse(raw);
    g.queries.push({ site: decodeURIComponent(q[1]), ...body });
    if (g.gscMode === "429") return send(429, { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } });
    if (g.gscMode === "500") return send(500, { error: "boom" });
    // two pages per day over the requested range; the values depend on gscSeed so a refetch is visible
    const rows = [];
    for (let d = Date.parse(`${body.startDate}T00:00:00Z`); d <= Date.parse(`${body.endDate}T00:00:00Z`); d += 86400000)
      for (const page of ["https://blog.example.com/a", "https://blog.example.com/b"])
        rows.push({ keys: [new Date(d).toISOString().slice(0, 10), page], clicks: g.gscSeed * 10, impressions: g.gscSeed * 100, ctr: 0.1, position: 2.5 });
    return send(200, { rows: body.startRow ? [] : rows });
  }
  // Analytics Admin API (accountSummaries) and Data API (runReport), fake
  if (url.pathname === "/api/v1beta/accountSummaries") {
    if (!/^Bearer at-/.test(req.headers.authorization ?? "")) return send(401, { error: "unauthorized" });
    return send(200, {
      accountSummaries: [
        { name: "accountSummaries/1", account: "accounts/1", displayName: "E2E GA", propertySummaries: [{ property: "properties/111", displayName: "Blog GA4" }, { property: "properties/222", displayName: "Other GA4" }] },
      ],
    });
  }
  const rr = /^\/api\/v1beta\/properties\/(\d+):runReport$/.exec(url.pathname);
  if (rr) {
    if (!/^Bearer at-/.test(req.headers.authorization ?? "")) return send(401, { error: "unauthorized" });
    const body = JSON.parse(raw);
    g.ga4Queries.push({ property: rr[1], ...body });
    if (g.ga4Mode === "429") return send(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
    if (g.ga4Mode === "403") return send(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "no access" } });
    if (g.ga4Mode === "scope") return send(403, { error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    const { startDate, endDate } = body.dateRanges[0];
    const all = [];
    for (let d = Date.parse(`${startDate}T00:00:00Z`); d <= Date.parse(`${endDate}T00:00:00Z`); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10).replaceAll("-", "");
      for (const page of ["/a", "/b"])
        all.push({ dimensionValues: [{ value: date }, { value: page }], metricValues: [{ value: String(10 * g.ga4Seed) }, { value: String(5 * g.ga4Seed) }, { value: String(4 * g.ga4Seed) }] });
    }
    // the fake serves g.ga4PageSize rows per call so the app has to page with offset
    const size = Math.min(body.limit, g.ga4PageSize);
    return send(200, { metricHeaders: ["screenPageViews", "sessions", "activeUsers"].map((name) => ({ name })), rows: all.slice(body.offset, body.offset + size), rowCount: all.length });
  }
  // AdSense Management API v2 (fake): accounts, account (time zone), reports:generate
  if (url.pathname.startsWith("/api/v2/accounts")) {
    if (!/^Bearer at-/.test(req.headers.authorization ?? "")) return send(401, { error: "unauthorized" });
    if (url.pathname === "/api/v2/accounts")
      return send(200, {
        accounts: [
          { name: "accounts/pub-1111", displayName: "E2E AdSense", state: "READY", timeZone: { id: "Asia/Seoul" } },
          { name: "accounts/pub-2222", displayName: "Other", state: "READY", timeZone: { id: "UTC" } },
        ],
      });
    if (/^\/api\/v2\/accounts\/pub-\d+$/.test(url.pathname)) return send(200, { name: url.pathname.slice(8), ...(g.adsTz ? { timeZone: { id: g.adsTz } } : {}) });
    if (/^\/api\/v2\/accounts\/pub-\d+\/reports:generate$/.test(url.pathname)) {
      const q = url.searchParams;
      g.adsQueries.push({ account: url.pathname.split("/")[4], dims: q.getAll("dimensions"), metrics: q.getAll("metrics"), tz: q.get("reportingTimeZone"), currencyCode: q.get("currencyCode"), start: `${q.get("startDate.year")}-${String(q.get("startDate.month")).padStart(2, "0")}-${String(q.get("startDate.day")).padStart(2, "0")}`, end: `${q.get("endDate.year")}-${String(q.get("endDate.month")).padStart(2, "0")}-${String(q.get("endDate.day")).padStart(2, "0")}` });
      const dims = q.getAll("dimensions");
      const pageLevel = dims.includes("PAGE_URL");
      if (pageLevel && g.adsPage === "reject") return send(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "dimension combination" } });
      const last = g.adsQueries.at(-1);
      const headers = [
        { name: "DATE", type: "DIMENSION" },
        ...(pageLevel ? [{ name: "PAGE_URL", type: "DIMENSION" }] : []),
        g.adsCurrency ? { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: g.adsCurrency } : { name: "ESTIMATED_EARNINGS", type: "METRIC_TALLY" },
        { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
        { name: "IMPRESSIONS", type: "METRIC_TALLY" },
        { name: "CLICKS", type: "METRIC_TALLY" },
      ];
      const rows = [];
      for (let d = Date.parse(`${last.start}T00:00:00Z`); d <= Date.parse(`${last.end}T00:00:00Z`); d += 86400000) {
        const date = new Date(d).toISOString().slice(0, 10);
        for (const page of pageLevel ? ["https://blog.example.com/a", "https://blog.example.com/b"] : [null]) {
          const k = pageLevel ? 1 : 2;
          const v = [String(0.5 * k * g.adsSeed), String(100 * k), String(200 * k), String(3 * k)];
          rows.push({ cells: [date, ...(page ? [page] : []), ...v].map((value) => ({ value })) });
        }
      }
      return send(200, { headers, rows });
    }
  }
  send(404, {});
});
googleServer.listen(GOOGLE_PORT, "127.0.0.1");
/** What Google would do after the user consents: remember the PKCE challenge, hand back a code. */
function consent(authUrl, sub, email) {
  const q = new URL(authUrl).searchParams;
  const code = `code-${randomBytes(8).toString("hex")}`;
  g.codes.set(code, { challenge: q.get("code_challenge"), sub, email, scope: q.get("scope") });
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
  return execFileSync("docker", ["exec", "-e", "PGOPTIONS=-c search_path=nomad_contentflow,nomad_core,public", "supabase_db_ContentFlow-AI-V2.0", "psql", "-U", "postgres", "-tAc", q], { encoding: "utf8" }).trim();
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
const ownerWs = (email) => sql(`select m.organization_id from memberships m join auth.users u on u.id = m.user_id where u.email = '${email}' and m.role = 'owner' limit 1`);

const emailA = `ga-${stamp}@example.test`; // owner
const emailB = `gb-${stamp}@example.test`; // attacker (own workspace)
const emailE = `ge-${stamp}@example.test`; // member of A's workspace
const A = new Client();
const B = new Client();
const E = new Client();
const ctx = {};
const redirectUri = `${APP}/api/integrations/google/callback`;
void redirectUri;

const browser = await launchChrome({ port: 9335, userDataDir: resolve(tmpdir(), `goog-chrome-${stamp}`) });
let P, PE; // P: owner A, PE: editor E (separate browser contexts)
const panelText = `(() => { const s = document.querySelector('section[aria-labelledby="analytics-conn-title"]'); return s ? s.innerText : ""; })()`;
const browserLogin = async (page, email) => {
  await page.goto(`${APP}/login`);
  const r = await page.api("POST", "/api/auth/login", { email, password: PW });
  ok(r.status === 200, `browser login ${r.status}`);
};

try {
  P = await browser.newPage({ width: 1280 });
  PE = await browser.newPage({ width: 1280 });
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
  await step("브라우저·미설정: 패널 '연결 안 됨', 설정 안내, 연결 버튼 비활성", async () => {
    await browserLogin(P, emailA);
    await P.goto(`${APP}/settings`, { settle: 1000 });
    await P.waitFor(`${panelText}.includes("Google Search Console")`, 60000, "panel");
    await P.waitFor(`${panelText}.includes("연결 안 됨")`, 20000, "연결 안 됨");
    const t = await P.eval(panelText);
    ok(t.includes("GOOGLE_OAUTH_CLIENT_ID"), "미설정 안내 없음");
    const st = await P.buttonState("Google 계정 연결");
    ok(st === "disabled", `연결 버튼 ${st}`);
    await P.screenshot(resolve(SHOTS, "settings-unconfigured.png"));
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
    sql(`insert into memberships (organization_id, user_id, role) values ('${ctx.wsA}', '${ctx.uE}', 'editor')`);
    const sw = await E.api("POST", "/api/workspaces/active", { id: ctx.wsA });
    ok(sw.status === 200, `switch ${sw.status} ${JSON.stringify(sw.data)}`);
    ctx.blog1 = sql(`insert into blogs (organization_id, platform, domain) values ('${ctx.wsA}', 'wordpress', 'one.example.com') returning id`).split("\n")[0];
    ctx.blog2 = sql(`insert into blogs (organization_id, platform, domain) values ('${ctx.wsA}', 'wordpress', 'two.example.com') returning id`).split("\n")[0];
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
    const credsBefore = sql(`select count(*) from analytics_credentials where organization_id = '${ctx.wsA}'`);
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
    ok(sql(`select count(*) from analytics_credentials where organization_id = '${ctx.wsA}'`) === credsBefore, "A 워크스페이스에 grant가 생김");
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
    sql(`update memberships set role = 'admin' where organization_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const s = await E.api("POST", "/api/integrations/google/start", {});
    ok(s.status === 200, `admin start ${s.status}`);
    const { code, state } = consent(s.data.url, "sub-E", "e@google.test");
    sql(`update memberships set role = 'editor' where organization_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const hitsBefore = g.tokenHits;
    const r = await E.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    ok(reason(r.location) === "forbidden", r.location);
    ok(g.tokenHits === hitsBefore, "교환됨");
  });

  await step("강등된 admin의 grant: 속성 목록은 거부(409), 현재 admin(A)의 revoke·삭제는 성공, editor는 거부", async () => {
    sql(`update memberships set role = 'admin' where organization_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
    const s = await E.api("POST", "/api/integrations/google/start", {});
    const { code, state } = consent(s.data.url, "sub-E2", "e2@google.test");
    const cb = await E.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    const gE = new URL(cb.location, APP).searchParams.get("grant");
    ok(gE, `E 연결 실패 ${cb.location}`);
    const live = await E.api("GET", `/api/integrations/google/sites?grant=${gE}`);
    ok(live.status === 200, `admin sites ${live.status}`);
    sql(`update memberships set role = 'editor' where organization_id = '${ctx.wsA}' and user_id = '${ctx.uE}'`);
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

  await step("동기화: editor 거부(403), 비인증 연결 ID 형식 오류 400", async () => {
    const e = await E.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(e.status === 403, `editor ${e.status}`);
    const bad = await A.api("POST", `/api/analytics/connections/not-a-uuid/sync`);
    ok(bad.status === 400, `bad id ${bad.status}`);
    const other = await B.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(other.status === 404 || other.status === 403, `다른 워크스페이스 ${other.status}`);
  });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const daysBack = (n) => new Date(Date.parse(`${yesterday}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const backdate = () => sql(`update analytics_sync_runs set requested_at = now() - interval '1 hour' where connection_id = '${ctx.c1}'`);
  const countRows = () => Number(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.c1}' and tool = 'gsc-api'`));

  await step("동기화 성공: 최초 90일 × 2페이지 × 4지표, 기록·연결 상태 active, 목록 lastRun", async () => {
    const r = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(r.status === 200 && r.data.status === "succeeded", `sync ${r.status} ${JSON.stringify(r.data)}`);
    ok(r.data.rows === 90 * 2 * 4 && r.data.range.end === yesterday && r.data.range.start === daysBack(89), JSON.stringify(r.data));
    ok(countRows() === 720, `rows ${countRows()}`);
    const q = g.queries.at(-1);
    ok(q.site === "sc-domain:example.com" && q.dimensions.join() === "date,page" && q.startDate === daysBack(89), JSON.stringify(q));
    ok(sql(`select status || ':' || rows_written from analytics_sync_runs where id = '${r.data.runId}'`) === "succeeded:720", "run 기록");
    ok(sql(`select status from analytics_connections where id = '${ctx.c1}'`) === "active", "연결 상태");
    ok(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.c1}' and blog_id = '${ctx.blog1}' and scope = 'page' and coverage = 'complete'`) === "720", "blog·scope·coverage");
    const l = await A.api("GET", "/api/analytics/connections");
    const c = l.data.connections.find((x) => x.id === ctx.c1);
    ok(c.lastRun?.status === "succeeded" && c.lastRun.rows === 720 && c.lastRun.finishedAt && c.lastRun.errorCode === null, JSON.stringify(c.lastRun));
    ok(l.data.connections.find((x) => x.id === ctx.c2).lastRun === null, "c2는 실행 기록 없음");
  });

  await step("쿨다운: 바로 다시 누르면 409 SYNC_COOLDOWN, 요청·행 변화 없음", async () => {
    const hits = g.queries.length;
    const r = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(r.status === 409 && r.data.code === "SYNC_COOLDOWN", `cooldown ${r.status} ${JSON.stringify(r.data)}`);
    ok(g.queries.length === hits, "Google이 호출됨");
    ok(sql(`select count(*) from analytics_sync_runs where connection_id = '${ctx.c1}'`) === "1", "실행 기록이 늘어남");
  });

  await step("재조회: 마지막 끝 − 3일부터 다시 가져와 겹치는 날만 교체(행 수 그대로), 앞 구간 값 유지", async () => {
    backdate();
    g.gscSeed = 2;
    const r = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(r.status === 200 && r.data.range.start === daysBack(3) && r.data.range.end === yesterday && r.data.rows === 4 * 2 * 4, `sync ${r.status} ${JSON.stringify(r.data)}`);
    ok(g.queries.at(-1).startDate === daysBack(3), "요청 시작일");
    ok(countRows() === 720, `rows ${countRows()}`);
    const click = (d) => sql(`select string_agg(distinct value::text, ',') from blog_metric_snapshots where connection_id = '${ctx.c1}' and metric = '클릭수' and measured_on = '${d}'`);
    ok(click(daysBack(3)) === "20.0000" && click(yesterday) === "20.0000", `교체된 날 ${click(yesterday)}`);
    ok(click(daysBack(4)) === "10.0000", `앞 구간 ${click(daysBack(4))}`);
    ok(sql(`select count(*) from (select 1 from blog_metric_snapshots where connection_id = '${ctx.c1}' group by metric, dimension, measured_on having count(*) > 1) d`) === "0", "중복 행");
  });

  await step("429 → 502 PROVIDER_QUOTA(delayed), 5xx → 502 PROVIDER_ERROR(failed): 행·값 변화 없고 0이 저장되지 않음", async () => {
    for (const [mode, code, status] of [["429", "PROVIDER_QUOTA", "delayed"], ["500", "PROVIDER_ERROR", "failed"]]) {
      backdate();
      g.gscMode = mode;
      const r = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
      ok(r.status === 502 && r.data.code === code && r.data.status === status, `${mode} ${r.status} ${JSON.stringify(r.data)}`);
      ok(countRows() === 720, `rows ${countRows()}`);
      ok(sql(`select status || ':' || rows_written || ':' || error_code from analytics_sync_runs where connection_id = '${ctx.c1}' order by requested_at desc limit 1`) === `${status}:0:${code}`, "run 기록");
    }
    g.gscMode = "ok";
    ok(sql(`select status from analytics_connections where id = '${ctx.c1}'`) === "active", "일시 실패로 연결 상태가 바뀜");
  });

  await step("invalid_grant → 409 NEEDS_REAUTH, 연결 needs_reauth, 이후 동기화는 CONNECTION_NOT_ACTIVE", async () => {
    backdate();
    g.live.delete(ctx.rt);
    const r = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    g.live.add(ctx.rt); // later steps revoke this token
    ok(r.status === 409 && r.data.code === "NEEDS_REAUTH", `reauth ${r.status} ${JSON.stringify(r.data)}`);
    ok(sql(`select status from analytics_connections where id = '${ctx.c1}'`) === "needs_reauth", "연결 상태");
    ok(countRows() === 720, "행이 바뀜");
    backdate();
    const again = await A.api("POST", `/api/analytics/connections/${ctx.c1}/sync`);
    ok(again.status === 409 && again.data.code === "CONNECTION_NOT_ACTIVE", `again ${again.status} ${JSON.stringify(again.data)}`);
  });


  // ===== AdSense (A6): incremental consent, account pick, report, currency / time zone, PAGE_URL fallback =====
  const adsCount = () => Number(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}'`));
  const adsBackdate = () => sql(`update analytics_sync_runs set requested_at = now() - interval '1 hour' where connection_id = '${ctx.ads}'`);

  await step("AdSense 동의: 알 수 없는 provider 400, adsense.readonly만 + include_granted_scopes=true, 콜백 provider=adsense, 암호문 저장", async () => {
    const bad = await A.api("POST", "/api/integrations/google/start", { provider: "bogus" });
    ok(bad.status === 400, `bad provider ${bad.status}`);
    const s = await A.api("POST", "/api/integrations/google/start", { provider: "adsense" });
    ok(s.status === 200, `start ${s.status}`);
    const u = new URL(s.data.url);
    ok(u.searchParams.get("scope") === `openid email ${ADS}` && u.searchParams.get("include_granted_scopes") === "true", u.search);
    const { code, state } = consent(s.data.url, "sub-AS", "as@google.test");
    const cb = await A.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    const loc = new URL(cb.location, APP);
    ok(cb.status === 303 && loc.searchParams.get("google") === "connected" && loc.searchParams.get("provider") === "adsense", cb.location);
    ctx.adsGrant = loc.searchParams.get("grant");
    ok(/^[0-9a-f-]{36}$/.test(ctx.adsGrant) && ctx.adsGrant !== ctx.grant, "grant");
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.adsGrant}' and ciphertext like 'v1.%'`) === "1", "credential");
  });

  await step("AdSense 동의 거부: 허용된 scope에 adsense.readonly가 없으면 scope_missing, grant 저장 안 됨", async () => {
    const before = sql(`select count(*) from analytics_credentials where organization_id = '${ctx.wsA}'`);
    const s = await A.api("POST", "/api/integrations/google/start", { provider: "adsense" });
    const { code, state } = consent(s.data.url, "sub-AS-denied", "asd@google.test");
    g.grantScope = `openid email ${GSC}`;
    const cb = await A.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    g.grantScope = null;
    ok(reason(cb.location) === "scope_missing", cb.location);
    ok(sql(`select count(*) from analytics_credentials where organization_id = '${ctx.wsA}'`) === before, "grant가 저장됨");
  });

  await step("AdSense 계정 목록·연결: editor 거부, 허용 밖 계정 400, 연결 201(blog 없음), 두 번째 계정은 409, 타 워크스페이스는 grant를 못 읽음", async () => {
    const ed = await E.api("GET", `/api/integrations/google/sites?grant=${ctx.adsGrant}&provider=adsense`);
    ok(ed.status === 403, `editor ${ed.status}`);
    const l = await A.api("GET", `/api/integrations/google/sites?grant=${ctx.adsGrant}&provider=adsense`);
    ok(l.status === 200 && l.data.accounts.map((a) => a.name).join() === "accounts/pub-1111,accounts/pub-2222", JSON.stringify(l.data));
    const other = await B.api("GET", `/api/integrations/google/sites?grant=${ctx.adsGrant}&provider=adsense`);
    ok(other.status !== 200, `B ${other.status}`);
    const notAllowed = await A.api("POST", "/api/analytics/connections", { provider: "adsense", grantId: ctx.adsGrant, accountName: "accounts/pub-9999" });
    ok(notAllowed.status === 400 && notAllowed.data.code === "site_not_allowed", `not allowed ${notAllowed.status}`);
    const badName = await A.api("POST", "/api/analytics/connections", { provider: "adsense", grantId: ctx.adsGrant, accountName: "../x" });
    ok(badName.status === 400, `bad name ${badName.status}`);
    const c = await A.api("POST", "/api/analytics/connections", { provider: "adsense", grantId: ctx.adsGrant, accountName: "accounts/pub-1111" });
    ok(c.status === 201 && c.data.connection.provider === "adsense" && c.data.connection.blog_id === null && c.data.connection.status === "pending", `connect ${c.status} ${JSON.stringify(c.data)}`);
    ctx.ads = c.data.connection.id;
    const second = await A.api("POST", "/api/analytics/connections", { provider: "adsense", grantId: ctx.adsGrant, accountName: "accounts/pub-2222" });
    ok(second.status === 409 && second.data.code === "duplicate", `second ${second.status}`);
  });

  await step("AdSense 동기화: 최초 90일 × 2페이지, status 전부 estimated, 통화=헤더 USD, 시간대=계정 Asia/Seoul, 요청에 ACCOUNT_TIME_ZONE·currencyCode 없음", async () => {
    const e = await E.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    ok(e.status === 403, `editor ${e.status}`);
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    ok(r.status === 200 && r.data.status === "succeeded" && r.data.pageLevel === true && r.data.rows === 180, `sync ${r.status} ${JSON.stringify(r.data)}`);
    const q = g.adsQueries.at(-1);
    ok(q.account === "pub-1111" && q.dims.join() === "DATE,PAGE_URL" && q.metrics.join() === "ESTIMATED_EARNINGS,PAGE_VIEWS,IMPRESSIONS,CLICKS", JSON.stringify(q));
    ok(q.tz === "ACCOUNT_TIME_ZONE" && q.currencyCode === null && q.start === daysBack(89) && q.end === yesterday, JSON.stringify(q));
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and source = 'adsense-api' and status = 'estimated' and currency = 'USD' and timezone = 'Asia/Seoul' and page <> ''`) === "180", "행 속성");
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and status <> 'estimated'`) === "0", "estimated 아닌 행");
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and coverage = 'complete' and sync_run_id = '${r.data.runId}'`) === "180", "coverage·run");
    ok(sql(`select status from analytics_connections where id = '${ctx.ads}'`) === "active", "연결 상태");
    const l = await A.api("GET", "/api/analytics/connections");
    const c = l.data.connections.find((x) => x.id === ctx.ads);
    ok(c.adsense?.currency === "USD" && c.adsense.timezone === "Asia/Seoul" && c.adsense.pageLevel === true && c.lastRun?.status === "succeeded", JSON.stringify(c));
    ok(!JSON.stringify(l.data.connections.filter((x) => x.provider !== "adsense")).includes("adsense\":"), "GSC 연결에 adsense 정보");
  });

  await step("AdSense 쿨다운: 바로 다시 누르면 409 SYNC_COOLDOWN, Google 호출 없음", async () => {
    const hits = g.adsQueries.length;
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    ok(r.status === 409 && r.data.code === "SYNC_COOLDOWN" && g.adsQueries.length === hits, `${r.status} ${JSON.stringify(r.data)}`);
  });

  await step("PAGE_URL 거부(400 INVALID_ARGUMENT) → 사이트·일 수준 재요청(page=''), 같은 범위에 페이지 행과 사이트 행이 섞이지 않고 연결은 글별 미지원", async () => {
    g.adsPage = "reject";
    adsBackdate();
    const before = g.adsQueries.length;
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    g.adsPage = "ok";
    ok(r.status === 200 && r.data.pageLevel === false, `sync ${r.status} ${JSON.stringify(r.data)}`);
    const qs = g.adsQueries.slice(before);
    ok(qs.length === 2 && qs[0].dims.join() === "DATE,PAGE_URL" && qs[1].dims.join() === "DATE", JSON.stringify(qs));
    ok(r.data.range.start === daysBack(3), JSON.stringify(r.data.range));
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and report_date >= '${r.data.range.start}' and page = ''`) === "4", "사이트 수준 행");
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and report_date >= '${r.data.range.start}' and page <> ''`) === "0", "재조회 범위에 페이지 행이 남음");
    ok(sql(`select count(*) from (select report_date from revenue_rows where connection_id = '${ctx.ads}' group by report_date having bool_or(page = '') and bool_or(page <> '')) t`) === "0", "같은 날 사이트·페이지 행 혼합");
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and status <> 'estimated'`) === "0", "estimated 아님");
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.data.connections.find((x) => x.id === ctx.ads).adsense.pageLevel === false, "pageLevel false 아님");
    ctx.adsRows = adsCount();
  });

  await step("통화 헤더 없음 → 502 CURRENCY_MISSING(failed), 시간대 없음 → 502 TIMEZONE_MISSING, 행 변화 없음·0 저장 없음", async () => {
    g.adsCurrency = null;
    adsBackdate();
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    g.adsCurrency = "USD";
    ok(r.status === 502 && r.data.code === "CURRENCY_MISSING" && r.data.status === "failed", `currency ${r.status} ${JSON.stringify(r.data)}`);
    ok(adsCount() === ctx.adsRows, "행이 바뀜");
    ok(sql(`select status || ':' || error_code from analytics_sync_runs where connection_id = '${ctx.ads}' order by requested_at desc limit 1`) === "failed:CURRENCY_MISSING", "run 기록");
    g.adsTz = null;
    adsBackdate();
    const t = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    g.adsTz = "Asia/Seoul";
    ok(t.status === 502 && t.data.code === "TIMEZONE_MISSING", `tz ${t.status} ${JSON.stringify(t.data)}`);
    ok(adsCount() === ctx.adsRows, "행이 바뀜(tz)");
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.data.connections.find((x) => x.id === ctx.ads).lastRun?.status === "failed", "목록 lastRun");
  });

  await step("AdSense 다시 성공: PAGE_URL 허용으로 돌아오면 재조회 범위가 페이지 행으로 교체(사이트 행 제거), CSV 행과 합산 없음", async () => {
    adsBackdate();
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ads}/sync`);
    ok(r.status === 200 && r.data.pageLevel === true, `sync ${r.status} ${JSON.stringify(r.data)}`);
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ads}' and report_date >= '${r.data.range.start}' and page = ''`) === "0", "사이트 행이 남음");
    ok(sql(`select count(*) from revenue_rows where organization_id = '${ctx.wsA}' and source <> 'adsense-api'`) === "0", "다른 source 행이 생김");
  });

  await step("AdSense 해제: 마지막 연결이라 Google revoke 후 grant 삭제, 가져온 행은 유지(D4), 목록에서 연결 해제됨", async () => {
    const rows = adsCount();
    const r = await A.api("DELETE", `/api/analytics/connections/${ctx.ads}`);
    ok(r.status === 200 && r.data.revoke === "done", JSON.stringify(r.data));
    ok(g.revokeHits.length === 1, `revoke ${g.revokeHits.length}`);
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.adsGrant}'`) === "0", "grant가 남음");
    ok(adsCount() === rows && rows > 0, "행이 바뀜");
    ok(sql(`select status from analytics_connections where id = '${ctx.ads}'`) === "revoked", "상태");
    g.revokeHits.length = 0;
  });

  // ===== GA4 (A7): incremental consent, property pick, runReport paging, cooldown, failures =====
  const ga4Count = () => Number(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.ga4}'`));
  const ga4Backdate = () => sql(`update analytics_sync_runs set requested_at = now() - interval '1 hour' where connection_id = '${ctx.ga4}'`);
  const ga4Value = (v) => Number(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.ga4}' and metric = '조회수' and value = ${v}`));

  await step("GA4 동의: analytics.readonly만 + include_granted_scopes=true, 허용 scope 없으면 scope_missing, 콜백 provider=ga4", async () => {
    const s = await A.api("POST", "/api/integrations/google/start", { provider: "ga4" });
    ok(s.status === 200, `start ${s.status}`);
    const u = new URL(s.data.url);
    ok(u.searchParams.get("scope") === `openid email ${GA4}` && u.searchParams.get("include_granted_scopes") === "true", u.search);
    const denied = consent(s.data.url, "sub-GA-denied", "gad@google.test");
    g.grantScope = `openid email ${GSC}`;
    const dcb = await A.api("GET", `/api/integrations/google/callback?code=${denied.code}&state=${denied.state}`);
    g.grantScope = null;
    ok(reason(dcb.location) === "scope_missing", dcb.location);
    const s2 = await A.api("POST", "/api/integrations/google/start", { provider: "ga4" });
    const { code, state } = consent(s2.data.url, "sub-GA", "ga@google.test");
    const cb = await A.api("GET", `/api/integrations/google/callback?code=${code}&state=${state}`);
    const loc = new URL(cb.location, APP);
    ok(cb.status === 303 && loc.searchParams.get("google") === "connected" && loc.searchParams.get("provider") === "ga4", cb.location);
    ctx.ga4Grant = loc.searchParams.get("grant");
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.ga4Grant}' and ciphertext like 'v1.%'`) === "1", "credential");
  });

  await step("GA4 속성 목록·연결: editor 거부, 허용 밖·형식 오류 400, 연결 201, 같은 블로그 슬롯 중복 409", async () => {
    const ed = await E.api("GET", `/api/integrations/google/sites?grant=${ctx.ga4Grant}&provider=ga4`);
    ok(ed.status === 403, `editor ${ed.status}`);
    const l = await A.api("GET", `/api/integrations/google/sites?grant=${ctx.ga4Grant}&provider=ga4`);
    ok(l.status === 200 && l.data.properties.map((p) => p.name).join() === "properties/111,properties/222", JSON.stringify(l.data));
    const other = await B.api("GET", `/api/integrations/google/sites?grant=${ctx.ga4Grant}&provider=ga4`);
    ok(other.status !== 200, `B ${other.status}`);
    const notAllowed = await A.api("POST", "/api/analytics/connections", { provider: "ga4", grantId: ctx.ga4Grant, propertyName: "properties/999" });
    ok(notAllowed.status === 400 && notAllowed.data.code === "site_not_allowed", `not allowed ${notAllowed.status}`);
    for (const bad of ["properties/1x", "accounts/111", "properties/111/../x", ""]) {
      const r = await A.api("POST", "/api/analytics/connections", { provider: "ga4", grantId: ctx.ga4Grant, propertyName: bad });
      ok(r.status === 400, `bad ${bad} ${r.status}`);
    }
    const c = await A.api("POST", "/api/analytics/connections", { provider: "ga4", grantId: ctx.ga4Grant, propertyName: "properties/111" });
    ok(c.status === 201 && c.data.connection.provider === "ga4" && c.data.connection.status === "pending", `connect ${c.status} ${JSON.stringify(c.data)}`);
    ctx.ga4 = c.data.connection.id;
    ok(sql(`select scopes::text from analytics_connections where id = '${ctx.ga4}'`) === `{${GA4}}`, "scopes");
    const second = await A.api("POST", "/api/analytics/connections", { provider: "ga4", grantId: ctx.ga4Grant, propertyName: "properties/222" });
    ok(second.status === 409 && second.data.code === "duplicate", `second ${second.status}`);
  });

  await step("GA4 동기화: editor 거부, 최초 90일 × 2페이지 × 3지표를 offset으로 나눠 가져와 tool ga4-api로 저장, 연결 active", async () => {
    const e = await E.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    ok(e.status === 403, `editor ${e.status}`);
    ga4Backdate();
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    ok(r.status === 200 && r.data.status === "succeeded" && r.data.rows === 540, `sync ${r.status} ${JSON.stringify(r.data)}`);
    ok(g.ga4Queries.map((q) => q.offset).join() === "0,50,100,150", `offsets ${g.ga4Queries.map((q) => q.offset).join()}`);
    const q0 = g.ga4Queries[0];
    ok(q0.property === "111" && q0.dimensions.map((d) => d.name).join() === "date,pagePath" && q0.metrics.map((m) => m.name).join() === "screenPageViews,sessions,activeUsers", JSON.stringify(q0));
    ok(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.ga4}' and tool = 'ga4-api' and scope = 'page' and coverage = 'complete' and sync_run_id = '${r.data.runId}'`) === "540", "행 속성");
    ok(sql(`select string_agg(distinct metric || ':' || unit, ',' order by metric || ':' || unit) from blog_metric_snapshots where connection_id = '${ctx.ga4}'`) === "세션:회,조회수:회,활성 사용자:명", "지표 이름·단위");
    ok(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.ga4}' and dimension not in ('/a', '/b')`) === "0", "pagePath");
    ok(sql(`select status from analytics_connections where id = '${ctx.ga4}'`) === "active", "연결 상태");
    ok(sql(`select count(*) from revenue_rows where connection_id = '${ctx.ga4}'`) === "0", "수익 행이 생김");
    const l = await A.api("GET", "/api/analytics/connections");
    ok(l.data.connections.find((x) => x.id === ctx.ga4).lastRun?.status === "succeeded", "목록 lastRun");
  });

  await step("GA4 쿨다운: 바로 다시 누르면 409 SYNC_COOLDOWN, Google 호출 없음", async () => {
    const hits = g.ga4Queries.length;
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    ok(r.status === 409 && r.data.code === "SYNC_COOLDOWN" && g.ga4Queries.length === hits, `${r.status} ${JSON.stringify(r.data)}`);
  });

  await step("GA4 재조회: 마지막 끝 − 3일부터 다시 가져와 겹치는 날만 교체(행 수 그대로, 앞 구간 값 유지)", async () => {
    ga4Backdate();
    g.ga4Seed = 2;
    g.ga4Queries.length = 0;
    const rows = ga4Count();
    const r = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    g.ga4Seed = 1;
    ok(r.status === 200, `sync ${r.status} ${JSON.stringify(r.data)}`);
    ok(g.ga4Queries[0].dateRanges[0].startDate === r.data.range.start, "범위");
    ok(ga4Count() === rows, "행 수가 바뀜");
    ok(ga4Value(20) === 8, `겹친 4일 x 2페이지만 새 값: ${ga4Value(20)}`);
    ok(ga4Value(10) === 172, `앞 구간 값 유지: ${ga4Value(10)}`);
  });

  await step("GA4 실패: 429 → PROVIDER_QUOTA(delayed), 속성 403 → PROVIDER_FORBIDDEN(재연결 상태 아님), 범위 403 → NEEDS_REAUTH; 행 변화·0 저장 없음", async () => {
    const rows = ga4Count();
    ga4Backdate();
    g.ga4Mode = "429";
    const q = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    ok(q.status === 502 && q.data.code === "PROVIDER_QUOTA" && q.data.status === "delayed", `429 ${q.status} ${JSON.stringify(q.data)}`);
    ga4Backdate();
    g.ga4Mode = "403";
    const f = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    ok(f.status === 502 && f.data.code === "PROVIDER_FORBIDDEN", `403 ${f.status} ${JSON.stringify(f.data)}`);
    ok(sql(`select status from analytics_connections where id = '${ctx.ga4}'`) !== "needs_reauth", "403으로 재연결 상태가 됨");
    ga4Backdate();
    g.ga4Mode = "scope";
    const s = await A.api("POST", `/api/analytics/connections/${ctx.ga4}/sync`);
    g.ga4Mode = "ok";
    ok(s.status === 409 && s.data.code === "NEEDS_REAUTH", `scope ${s.status} ${JSON.stringify(s.data)}`);
    ok(sql(`select status from analytics_connections where id = '${ctx.ga4}'`) === "needs_reauth", "연결 상태");
    ok(ga4Count() === rows, "행이 바뀜");
    ok(sql(`select count(*) from blog_metric_snapshots where connection_id = '${ctx.ga4}' and value = 0`) === "0", "0이 저장됨");
  });

  await step("GA4 해제: 마지막 연결이라 Google revoke 후 grant 삭제, 가져온 행은 유지", async () => {
    const rows = ga4Count();
    g.revokeHits.length = 0;
    const r = await A.api("DELETE", `/api/analytics/connections/${ctx.ga4}`);
    ok(r.status === 200 && r.data.revoke === "done" && g.revokeHits.length === 1, JSON.stringify(r.data));
    ok(sql(`select count(*) from analytics_credentials where grant_id = '${ctx.ga4Grant}'`) === "0", "grant가 남음");
    ok(ga4Count() === rows && rows > 0, "행이 바뀜");
    g.revokeHits.length = 0;
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

  // ===== browser: connection panel against the configured stack =====
  const cardOf = () =>
    P.eval(`(() => { const e = [...document.querySelectorAll(".conn-item")].find((x) => x.innerText.includes("sc-domain:example.com") && !x.innerText.includes("연결 해제됨")); return e ? e.innerText.replace(/\\s+/g, " ") : ""; })()`);
  await step("브라우저 admin: 연결 시작 → 가짜 Google 동의 → 속성 선택 → 연결 카드, 지금 동기화 → 활성·마지막 동기화", async () => {
    await P.goto(`${APP}/settings`, { settle: 1000 });
    await P.waitFor(`${panelText}.includes("Google Search Console")`, 60000, "panel");
    // earlier steps left two revoked connections: they are listed as "연결 해제됨" with no action buttons
    await P.waitFor(async () => (await P.buttonState("Google 계정 연결")) === "enabled", 20000, "연결 버튼 활성");
    const before = await P.eval(panelText);
    ok(before.includes("연결 해제됨") && !before.includes("지금 동기화"), "해제된 연결 표시/버튼");
    await P.clickText("Google 계정 연결");
    await P.waitFor(`location.pathname === "/settings" && !!document.querySelector("#conn-site")`, 60000, "동의 후 속성 선택 폼");
    ok(!(await P.eval(`location.search`)).includes("google="), "쿼리 정리 안 됨");
    const opts = await P.eval(`[...document.querySelectorAll("#conn-site option")].map((o) => o.value)`);
    ok(opts.includes("sc-domain:example.com") && !opts.includes("https://unverified.example/"), opts.join());
    await P.fill("#conn-site", "sc-domain:example.com");
    ok(await P.eval(`[...document.querySelectorAll("#conn-blog option")].some((o) => o.value === ${JSON.stringify(ctx.blog2)})`), "블로그 선택지 없음");
    await P.fill("#conn-blog", ctx.blog1); // the revoked connection of this property was on blog1 and kept its data
    await P.screenshot(resolve(SHOTS, "picker-1280.png"));
    await P.clickText("속성 연결", { exact: true });
    try {
      await P.waitFor(`!!document.querySelector("#conn-site") === false && !!document.querySelector(".conn-item")`, 30000, "선택 폼 닫힘·연결 카드");
    } catch (e) {
      await P.screenshot(resolve(SHOTS, "picker-fail.png"));
      throw new Error(`${e.message} :: ${(await P.eval(panelText)).replace(/\s+/g, " ").slice(0, 600)}`);
    }
    await P.waitFor(async () => (await cardOf()) !== "", 20000, "재연결한 속성 카드");
    let card = await cardOf();
    ok(card.includes("sc-domain:example.com"), `카드 ${card}`);
    ok(card.includes("동의 대기") || card.includes("활성"), `카드 상태 ${card}`);
    ctx.uiStatus = card.includes("동의 대기") ? "pending" : "active";
    // first sync from the UI only: the button is enabled while pending (or the automatic run already started)
    if (ctx.uiStatus === "pending") {
      const disabled = await P.eval(`(() => { const e = [...document.querySelectorAll(".conn-item")].find((x) => x.innerText.includes("동의 대기")); const b = e && [...e.querySelectorAll("button")].find((x) => x.innerText.includes("지금 동기화")); return b ? b.disabled : "no-button"; })()`);
      ok(disabled === false || disabled === "no-button", `동의 대기 동기화 버튼 disabled=${disabled}`);
      if (disabled === false) await P.clickText("지금 동기화");
    }
    await P.waitFor(async () => {
      const c = await cardOf();
      return c.includes("활성") && !/마지막 동기화 없음/.test(c);
    }, 40000, "활성·마지막 동기화");
    card = await cardOf();
    // a revived connection keeps its rows: only the re-fetch window (3 days + yesterday) is imported again
    ok(/성공/.test(card) && /\d+행/.test(card), `최근 실행 ${card}`);
    ctx.cardConn = sql(`select id from analytics_connections where organization_id = '${ctx.wsA}' and external_ref = 'sc-domain:example.com' and status = 'active'`);
    ok(ctx.cardConn, "DB에 active 연결 없음");
    return card.slice(0, 160);
  });

  await step("브라우저 재연결: 해제(revoked)한 속성을 같은 워크스페이스에서 다시 연결할 수 있다", async () => {
    ok(ctx.uiStatus, "UI 재연결 단계가 앞 단계에서 통과해야 함");
  });

  await step("브라우저 첫 동기화: 새로 연결한 속성(동의 대기)을 UI에서 동기화할 수 있다", async () => {
    ok(ctx.uiStatus, "UI 첫 동기화 단계가 앞 단계에서 통과해야 함");
  });

  await step("브라우저 editor: 패널은 읽기 전용(연결·동기화·해제 버튼 없음, 안내 문구, 목록은 보임)", async () => {
    await browserLogin(PE, emailE);
    const sw = await PE.api("POST", "/api/workspaces/active", { id: ctx.wsA });
    ok(sw.status === 200, `switch ${sw.status}`);
    await PE.goto(`${APP}/settings`, { settle: 1000 });
    await PE.waitFor(`${panelText}.includes("sc-domain:example.com")`, 60000, "연결 목록");
    const t = await PE.eval(panelText);
    ok(t.includes("소유자·관리자만"), "읽기 전용 안내 없음");
    for (const b of ["Google 계정 연결", "지금 동기화", "연결 해제", "다시 연결", "철회 다시 시도"]) {
      const has = await PE.eval(`[...document.querySelectorAll('section[aria-labelledby="analytics-conn-title"] button')].some((x) => x.innerText.includes(${JSON.stringify(b)}))`);
      ok(!has, `editor에게 '${b}' 버튼이 보임`);
    }
    await PE.screenshot(resolve(SHOTS, "settings-editor-1280.png"));
  });

  await step("해제 대화상자: 키보드로 열기 → 포커스 취소 → Tab 트랩 → Esc 닫기 → 포커스 복귀, 연결은 유지", async () => {
    await P.goto(`${APP}/settings`, { settle: 1000 });
    await P.waitFor(`document.querySelectorAll(".conn-item").length > 0`, 30000, "연결 카드");
    await P.eval(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.scrollTo(0, 0), true)`);
    let f = "";
    for (let i = 0; i < 120; i++) {
      await P.key("Tab");
      f = await P.focused();
      if (f.startsWith("BUTTON") && f.includes("연결 해제")) break;
    }
    ok(f.startsWith("BUTTON") && f.includes("연결 해제"), `Tab으로 해제 버튼에 못 닿음: ${f}`);
    await P.key("Enter");
    await P.waitFor(`!!document.querySelector('[role="alertdialog"]')`, 5000, "대화상자");
    ok((await P.focused()) === "BUTTON 취소", `초기 포커스 ${await P.focused()}`);
    const inside = () => P.eval(`!!document.activeElement && !!document.activeElement.closest('[role="alertdialog"]')`);
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      await P.key("Tab");
      ok(await inside(), `Tab ${i + 1}회: 포커스가 대화상자 밖 ${await P.focused()}`);
      seen.add(await P.focused());
    }
    for (let i = 0; i < 4; i++) {
      await P.key("Tab", { shift: true });
      ok(await inside(), `Shift+Tab ${i + 1}회: 포커스가 대화상자 밖`);
    }
    ok(seen.size >= 3, `순환한 요소 ${[...seen].join(" | ")}`);
    await P.screenshot(resolve(SHOTS, "disconnect-dialog-1280.png"), { full: false });
    await P.key("Escape");
    await P.waitFor(`!document.querySelector('[role="alertdialog"]')`, 5000, "대화상자 닫힘");
    const back = await P.focused();
    ok(back.startsWith("BUTTON") && back.includes("연결 해제"), `닫힌 뒤 포커스 ${back}`);
    ok(sql(`select status from analytics_connections where id = '${ctx.cardConn}'`) === "active", "Esc로 닫았는데 연결 상태가 바뀜");
  });

  for (const w of [500, 768, 1440]) {
    await step(`브라우저 반응형: 설정 > 광고·분석 연결 ${w}px 가로 넘침 0 (패널·해제 대화상자)`, async () => {
      await P.viewport(w);
      await P.goto(`${APP}/settings`, { settle: 1200 });
      await P.waitFor(`document.querySelectorAll(".conn-item").length > 0`, 30000, "연결 카드");
      const o = await P.overflow();
      await P.screenshot(resolve(SHOTS, `settings-conn-${w}.png`));
      ok(!o.over && !o.scrollable, `over ${JSON.stringify(o)}`);
      await P.clickText("연결 해제");
      await P.waitFor(`!!document.querySelector('[role="alertdialog"]')`, 5000, "대화상자");
      const d = await P.eval(`(() => { const r = document.querySelector('[role="alertdialog"]').getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: document.documentElement.clientWidth }; })()`);
      await P.screenshot(resolve(SHOTS, `disconnect-dialog-${w}.png`), { full: false });
      await P.key("Escape");
      ok(d.l >= 0 && d.r <= d.w, `대화상자가 화면 밖 ${JSON.stringify(d)}`);
      return `${o.sw}/${o.w}`;
    });
  }

  await step("브라우저 예외 0 (owner·editor 페이지)", async () => {
    ok(P.errors.length === 0 && PE.errors.length === 0, JSON.stringify({ P: P.errors.slice(0, 3), E: PE.errors.slice(0, 3) }));
  });

  await step("서버 로그에 refresh token·client secret·키·state 쿠키 없음 (인가 코드는 next dev 요청 로그에 URL로 남음: 1회용·PKCE 결합)", async () => {
    await sleep(500);
    const log = readFileSync(resolve(OUT, "next-configured.log"), "utf8");
    for (const needle of ["rt-", "e2e-secret", KEY, "cf_goog_oauth="]) ok(!log.includes(needle), `로그에 ${needle.slice(0, 4)}… 포함`);
  });
} finally {
  await browser.close();
  await stopApp();
  googleServer.close();
}

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed; logs in ${OUT}`);
process.exit(failed ? 1 : 0);
