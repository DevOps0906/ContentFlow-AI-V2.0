import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/api";
import { appOrigin } from "@/lib/auth";
import { CALLBACK_PATH, googleConfig, OAUTH_COOKIE, OAUTH_COOKIE_PATH, startFlow } from "@/lib/google-oauth";
import { sessionCookieOptions } from "@/lib/supabase";
import { json, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Begins the Search Console consent: returns the Google URL and sets the sealed state/PKCE cookie. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "연결은 소유자·관리자만 할 수 있습니다." }, 403);
  const cfg = googleConfig();
  if (!cfg) return json({ error: "Google 연결이 설정되지 않았습니다.", code: "not_configured" }, 503);
  if (await sharedLimited(account.supabase, `goog-start:${account.user.id}`, 10, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const flow = startFlow(cfg, `${appOrigin(req)}${CALLBACK_PATH}`, account.user.id, account.workspaceId);
  const res = NextResponse.json({ url: flow.url }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(OAUTH_COOKIE, flow.cookie, { ...sessionCookieOptions(), path: OAUTH_COOKIE_PATH, maxAge: flow.maxAgeSeconds });
  return res;
}
