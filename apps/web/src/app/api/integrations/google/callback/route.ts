import { NextResponse, type NextRequest } from "next/server";
import { requireAccount } from "@/lib/api";
import { AnalyticsError, storeGrant } from "@/lib/analytics-connections-server";
import { appOrigin } from "@/lib/auth";
import { CALLBACK_PATH, checkFlow, exchangeCode, GoogleError, googleConfig, OAUTH_COOKIE, OAUTH_COOKIE_PATH, revokeToken } from "@/lib/google-oauth";
import { sessionCookieOptions } from "@/lib/supabase";
import { json } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

/**
 * Google sends the browser back here. Nothing is exchanged unless: the sealed cookie opens and is not
 * expired, state matches (one use: the cookie is cleared on every outcome), the session user is the one
 * who started it, and that user is still owner/admin of the same workspace. Failures redirect with a
 * reason code only.
 */
export async function GET(req: NextRequest) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const cfg = googleConfig();
  if (!cfg) return json({ error: "Google 연결이 설정되지 않았습니다.", code: "not_configured" }, 503);

  const done = (params: Record<string, string>) => {
    const url = new URL("/settings", appOrigin(req));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = NextResponse.redirect(url, 303);
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(OAUTH_COOKIE, "", { ...sessionCookieOptions(), path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const fail = (reason: string) => done({ google: "error", reason });

  const q = req.nextUrl.searchParams;
  const check = checkFlow(cfg.ring, req.cookies.get(OAUTH_COOKIE)?.value, q.get("state"), account.user.id);
  if (!check.ok) return fail(check.code);
  if (q.get("error")) return fail("denied");
  const code = q.get("code");
  if (!code || code.length > 2000) return fail("no_code");
  if (check.flow.w !== account.workspaceId) return fail("workspace_changed");
  if (!canManageTeam(account.role)) return fail("forbidden");

  let unstored: string | null = null;
  try {
    const redirectUri = `${appOrigin(req)}${CALLBACK_PATH}`;
    const tokens = await exchangeCode(cfg, code, check.flow.v, redirectUri, fetch, check.flow.p);
    unstored = tokens.refreshToken;
    const grantId = await storeGrant(account, cfg.ring, cfg.clientId, tokens.sub, tokens.refreshToken);
    // The access token is not kept; the refresh token is stored encrypted.
    return done({ google: "connected", grant: grantId, provider: check.flow.p });
  } catch (e) {
    // A token Google issued but we could not store is not left alive.
    if (unstored) await revokeToken(cfg, unstored);
    if (e instanceof GoogleError) return fail(e.code);
    if (e instanceof AnalyticsError) return fail(e.code);
    return fail("failed");
  }
}
