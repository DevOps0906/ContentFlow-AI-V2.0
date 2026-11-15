// Google OAuth (authorization code + PKCE, server side) for the GSC connection. Server-only.
// Endpoints can be overridden (GOOGLE_OAUTH_BASE, GOOGLE_API_BASE) so tests run against a fake Google.
// Tokens, codes and the client secret are never logged or returned.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { openValue, parseKeyRing, sealValue, type KeyRing } from "./token-crypto";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const START_SCOPES = ["openid", "email", GSC_SCOPE] as const;
export const OAUTH_COOKIE = "cf_goog_oauth";
export const OAUTH_COOKIE_PATH = "/api/integrations/google";
export const OAUTH_TTL_MS = 10 * 60_000;
export const CALLBACK_PATH = "/api/integrations/google/callback";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
  ring: KeyRing;
};

/** null = not configured: connection APIs answer 503 and the screen reads "not connected". */
export function googleConfig(env = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const ring = parseKeyRing(env.ANALYTICS_TOKEN_KEYS);
  if (!clientId || !clientSecret || !ring) return null;
  const base = env.GOOGLE_OAUTH_BASE?.trim().replace(/\/+$/, "");
  return {
    clientId,
    clientSecret,
    authUrl: base ? `${base}/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: base ? `${base}/token` : "https://oauth2.googleapis.com/token",
    revokeUrl: base ? `${base}/revoke` : "https://oauth2.googleapis.com/revoke",
    apiBase: (env.GOOGLE_API_BASE?.trim() || "https://www.googleapis.com").replace(/\/+$/, ""),
    ring,
  };
}

export class GoogleError extends Error {
  constructor(public code: "invalid_grant" | "bad_response" | "scope_missing" | "no_refresh_token" | "upstream", message: string) {
    super(message);
  }
}

// ---------- state cookie ----------
export type OAuthFlow = { s: string; v: string; u: string; w: string; p: "gsc"; x: number };
const b64u = (b: Buffer) => b.toString("base64url");

export function startFlow(cfg: GoogleConfig, redirectUri: string, userId: string, workspaceId: string, now = Date.now()) {
  const state = b64u(randomBytes(24));
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const flow: OAuthFlow = { s: state, v: verifier, u: userId, w: workspaceId, p: "gsc", x: now + OAUTH_TTL_MS };
  const url = new URL(cfg.authUrl);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", cfg.clientId);
  q.set("redirect_uri", redirectUri);
  q.set("scope", START_SCOPES.join(" "));
  q.set("state", state);
  q.set("code_challenge", challenge);
  q.set("code_challenge_method", "S256");
  q.set("access_type", "offline");
  q.set("prompt", "consent");
  q.set("include_granted_scopes", "false");
  return { url: url.toString(), cookie: sealValue(cfg.ring, flow), maxAgeSeconds: OAUTH_TTL_MS / 1000 };
}

export type FlowCheck = { ok: true; flow: OAuthFlow } | { ok: false; code: "no_cookie" | "bad_cookie" | "expired" | "state_mismatch" | "user_mismatch" };

/** Callback checks in order: cookie opens, not expired, state equal, started by the session user. */
export function checkFlow(ring: KeyRing, cookie: string | undefined, stateParam: string | null, sessionUserId: string, now = Date.now()): FlowCheck {
  if (!cookie) return { ok: false, code: "no_cookie" };
  let raw: unknown;
  try {
    raw = openValue(ring, cookie);
  } catch {
    return { ok: false, code: "bad_cookie" };
  }
  const f = raw as Partial<OAuthFlow> | null;
  if (!f || typeof f.s !== "string" || typeof f.v !== "string" || typeof f.u !== "string" || typeof f.w !== "string" || typeof f.x !== "number" || f.p !== "gsc")
    return { ok: false, code: "bad_cookie" };
  if (now > f.x) return { ok: false, code: "expired" };
  const a = Buffer.from(f.s);
  const b = Buffer.from(stateParam ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: "state_mismatch" };
  if (f.u !== sessionUserId) return { ok: false, code: "user_mismatch" };
  return { ok: true, flow: f as OAuthFlow };
}

// ---------- Google calls ----------
async function post(url: string, form: Record<string, string>, fetchImpl: typeof fetch) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new GoogleError("upstream", "Google에 연결하지 못했습니다.");
  }
  const text = (await res.text()).slice(0, 50_000);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

function idTokenClaims(idToken: unknown): { sub: string; email: string } {
  const part = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  try {
    // Received straight from Google's token endpoint over TLS: no signature check needed for these claims.
    const c = JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as { sub?: unknown; email?: unknown };
    if (typeof c.sub === "string" && c.sub.length >= 1 && c.sub.length <= 255)
      return { sub: c.sub, email: typeof c.email === "string" ? c.email.slice(0, 254) : "" };
  } catch {
    // fall through
  }
  throw new GoogleError("bad_response", "Google 응답을 확인하지 못했습니다.");
}

export async function exchangeCode(cfg: GoogleConfig, code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch) {
  const { status, body } = await post(
    cfg.tokenUrl,
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret },
    fetchImpl,
  );
  if (status !== 200 || typeof body.access_token !== "string") throw new GoogleError("upstream", "Google이 인가 코드를 받아들이지 않았습니다.");
  const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
  if (!scopes.includes(GSC_SCOPE)) throw new GoogleError("scope_missing", "Search Console 읽기 권한이 허용되지 않았습니다.");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new GoogleError("no_refresh_token", "Google이 갱신 토큰을 주지 않았습니다.");
  const { sub, email } = idTokenClaims(body.id_token);
  return { refreshToken: body.refresh_token, accessToken: body.access_token, sub, email };
}

export async function refreshAccessToken(cfg: GoogleConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { status, body } = await post(
    cfg.tokenUrl,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret },
    fetchImpl,
  );
  if (status === 400 && body.error === "invalid_grant") throw new GoogleError("invalid_grant", "Google 권한이 철회되었습니다. 다시 연결해주세요.");
  if (status !== 200 || typeof body.access_token !== "string") throw new GoogleError("upstream", "Google 액세스 토큰을 받지 못했습니다.");
  return body.access_token;
}

/** "ok" when Google accepted it (an already invalid token counts); "failed" otherwise, so the grant stays stored. */
export async function revokeToken(cfg: GoogleConfig, token: string, fetchImpl: typeof fetch = fetch): Promise<"ok" | "failed"> {
  try {
    const { status, body } = await post(cfg.revokeUrl, { token }, fetchImpl);
    return status === 200 || (status === 400 && body.error === "invalid_token") ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export type GscSite = { siteUrl: string; permissionLevel: string };
export async function listGscSites(cfg: GoogleConfig, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<GscSite[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiBase}/webmasters/v3/sites`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new GoogleError("upstream", "Search Console 목록을 가져오지 못했습니다.");
  }
  if (res.status !== 200) throw new GoogleError("upstream", "Search Console 목록을 가져오지 못했습니다.");
  let body: { siteEntry?: unknown };
  try {
    body = JSON.parse((await res.text()).slice(0, 500_000));
  } catch {
    throw new GoogleError("bad_response", "Google 응답을 확인하지 못했습니다.");
  }
  const entries = Array.isArray(body.siteEntry) ? body.siteEntry : [];
  return entries
    .filter((e): e is GscSite => !!e && typeof e.siteUrl === "string" && typeof e.permissionLevel === "string" && e.siteUrl.length <= 500)
    .filter((e) => e.permissionLevel !== "siteUnverifiedUser")
    .slice(0, 500);
}
