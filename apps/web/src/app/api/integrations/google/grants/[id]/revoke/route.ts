import { requireAccount } from "@/lib/api";
import { AnalyticsError, revokeGrant } from "@/lib/analytics-connections-server";
import { isUuid } from "@/lib/articles-db";
import { googleConfig } from "@/lib/google-oauth";
import { json, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Retries the Google revoke of a grant no connection uses (after a failed revoke). Deletes it only on success. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "연결은 소유자·관리자만 할 수 있습니다." }, 403);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 연결 ID입니다." }, 400);
  if (await sharedLimited(account.supabase, `goog-revoke:${account.user.id}`, 10, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  try {
    const revoke = await revokeGrant(account, googleConfig(), id);
    return json({ revoke, ...(revoke === "failed" ? { notice: REVOKE_NOTICE } : {}) });
  } catch (e) {
    if (e instanceof AnalyticsError) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: "Google 권한을 철회하지 못했습니다." }, 500);
  }
}

const REVOKE_NOTICE = "Google이 철회 요청을 받지 않아 토큰을 보관 중입니다. 다시 시도하거나 Google 계정의 서드파티 연결 페이지에서 직접 철회해주세요.";
