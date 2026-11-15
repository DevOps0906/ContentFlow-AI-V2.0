import { requireAccount } from "@/lib/api";
import { AnalyticsError, disconnect } from "@/lib/analytics-connections-server";
import { isUuid } from "@/lib/articles-db";
import { googleConfig } from "@/lib/google-oauth";
import { json, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

const NOTICE = "Google이 철회 요청을 받지 않아 토큰을 보관 중입니다. 다시 시도하거나 Google 계정의 서드파티 연결 페이지에서 직접 철회해주세요.";

/**
 * Ends one connection. Body { purge?: boolean }: false (default) keeps the imported rows. When it was
 * the last connection on its grant the token is revoked at Google and deleted; if Google refuses, the
 * grant stays stored and `revoke: "failed"` asks for a retry (/api/integrations/google/grants/{id}/revoke).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "연결은 소유자·관리자만 해제할 수 있습니다." }, 403);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 연결 ID입니다." }, 400);
  if (await sharedLimited(account.supabase, `an-disconnect:${account.user.id}`, 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let purge = false;
  try {
    const text = await req.text();
    if (text.length > 1_000) throw new Error("too large");
    if (text.trim()) purge = (JSON.parse(text) as { purge?: unknown } | null)?.purge === true;
  } catch {
    return json({ error: "잘못된 요청입니다." }, 400);
  }
  try {
    const r = await disconnect(account, googleConfig(), id, purge);
    return json({ ok: true, revoke: r.revoke, grantId: r.revoke === "failed" ? r.grantId : null, ...(r.revoke === "failed" ? { notice: NOTICE } : {}) });
  } catch (e) {
    if (e instanceof AnalyticsError) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: "연결을 해제하지 못했습니다." }, 500);
  }
}
