import { requireAccount } from "@/lib/api";
import { runSync, SyncError } from "@/lib/analytics-sync-server";
import { isUuid } from "@/lib/articles-db";
import { googleConfig } from "@/lib/google-oauth";
import { json, sharedLimited } from "@/lib/server";
import { canManageTeam } from "@/lib/team";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Sync now" for one connection (owner/admin, same-origin). 200 { status, rows, range, runId } | 409 (cooldown,
 * in progress, not active, grant owner gone, NEEDS_REAUTH) | 422 SYNC_CAP_EXCEEDED | 502 { code, status: failed|delayed }.
 * The 15-minute cooldown and the one-running rule are enforced by the database.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageTeam(account.role)) return json({ error: "동기화는 소유자·관리자만 할 수 있습니다." }, 403);
  const cfg = googleConfig();
  if (!cfg) return json({ error: "Google 연결이 설정되지 않았습니다.", code: "not_configured" }, 503);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 연결 ID입니다." }, 400);
  if (await sharedLimited(account.supabase, `an-sync:${account.user.id}`, 30, 60_000)) return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  try {
    return json(await runSync(account, cfg, id));
  } catch (e) {
    if (e instanceof SyncError) return json({ error: e.message, code: e.code, ...(e.runStatus ? { status: e.runStatus } : {}) }, e.status);
    return json({ error: "동기화를 처리하지 못했습니다." }, 500);
  }
}
