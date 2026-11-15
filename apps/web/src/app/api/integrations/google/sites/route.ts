import { requireAccount } from "@/lib/api";
import { adsenseAccountsOfGrant, AnalyticsError, sitesOfGrant } from "@/lib/analytics-connections-server";
import { isUuid } from "@/lib/articles-db";
import { googleConfig } from "@/lib/google-oauth";
import { json, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Search Console properties (or, with ?provider=adsense, AdSense accounts) the connected Google account can see (for the picker). Owner/admin only. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "연결은 소유자·관리자만 할 수 있습니다." }, 403);
  const cfg = googleConfig();
  if (!cfg) return json({ error: "Google 연결이 설정되지 않았습니다.", code: "not_configured" }, 503);
  const grant = new URL(req.url).searchParams.get("grant") ?? "";
  if (!isUuid(grant)) return json({ error: "잘못된 연결 ID입니다." }, 400);
  if (await sharedLimited(account.supabase, `goog-sites:${account.user.id}`, 30, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  try {
    if (new URL(req.url).searchParams.get("provider") === "adsense") return json({ accounts: await adsenseAccountsOfGrant(account, cfg, grant) });
    return json({ sites: await sitesOfGrant(account, cfg, grant) });
  } catch (e) {
    if (e instanceof AnalyticsError) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: "속성 목록을 불러오지 못했습니다." }, 500);
  }
}
