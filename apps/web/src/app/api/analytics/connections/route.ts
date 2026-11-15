import { requireAccount } from "@/lib/api";
import { adsenseInfos, AnalyticsError, createAdsenseConnection, createGscConnection, listConnections } from "@/lib/analytics-connections-server";
import { lastRuns } from "@/lib/analytics-sync-server";
import { isUuid } from "@/lib/articles-db";
import { ADSENSE_ACCOUNT_RE, googleConfig } from "@/lib/google-oauth";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

const fail = (e: unknown) =>
  e instanceof AnalyticsError ? json({ error: e.message, code: e.code }, e.status) : json({ error: "연결 요청을 처리하지 못했습니다." }, 500);

/** Members read. `configured: false` means Google is not set up on this server: the screen says "not connected". */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  try {
    const { connections, unusedGrants } = await listConnections(account);
    const runs = await lastRuns(account);
    const adsense = await adsenseInfos(account, connections.filter((c) => c.provider === "adsense").map((c) => c.id));
    return json({
      configured: googleConfig() !== null,
      canManage: canManageTeam(account.role),
      connections: connections.map((c) => ({ ...c, lastRun: runs.get(c.id) ?? null, ...(adsense.has(c.id) ? { adsense: adsense.get(c.id) } : {}) })),
      unusedGrants,
    });
  } catch (e) {
    return fail(e);
  }
}

/** Connects one Search Console property to a blog, or (provider "adsense") one AdSense account to the workspace. Owner/admin only. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "연결은 소유자·관리자만 할 수 있습니다." }, 403);
  const cfg = googleConfig();
  if (!cfg) return json({ error: "Google 연결이 설정되지 않았습니다.", code: "not_configured" }, 503);
  if (await sharedLimited(account.supabase, `an-connect:${account.user.id}`, 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let body: { provider?: unknown; grantId?: unknown; siteUrl?: unknown; accountName?: unknown; blogId?: unknown } | null;
  try {
    body = (await readJson(req, 4_000)) as typeof body;
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const { provider, grantId, siteUrl, accountName, blogId } = body ?? {};
  if (typeof grantId !== "string" || !isUuid(grantId)) return json({ error: "잘못된 연결 ID입니다." }, 400);
  if (provider === "adsense") {
    if (typeof accountName !== "string" || !ADSENSE_ACCOUNT_RE.test(accountName)) return json({ error: "AdSense 계정을 선택해주세요." }, 400);
    try {
      return json({ connection: await createAdsenseConnection(account, cfg, { grantId, accountName }) }, 201);
    } catch (e) {
      return fail(e);
    }
  }
  if (provider !== undefined && provider !== "gsc") return json({ error: "지원하지 않는 연결 종류입니다." }, 400);
  if (typeof siteUrl !== "string" || !siteUrl.trim() || siteUrl.length > 500) return json({ error: "속성을 선택해주세요." }, 400);
  if (blogId != null && (typeof blogId !== "string" || !isUuid(blogId))) return json({ error: "잘못된 블로그 ID입니다." }, 400);
  try {
    return json({ connection: await createGscConnection(account, cfg, { grantId, siteUrl, blogId: (blogId as string | null | undefined) ?? null }) }, 201);
  } catch (e) {
    return fail(e);
  }
}
