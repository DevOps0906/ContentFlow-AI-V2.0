import { requireAccount } from "@/lib/api";
import { drainOne, QueueError } from "@/lib/publish-queue-server";
import { json, sharedLimited, wpConfig } from "@/lib/server";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";
// One WordPress send is at most ~45 s (several 15 s requests): one job per request fits.
export const maxDuration = 60;

/** Sends at most one due job with the caller's own session. POST only: GET never starts work. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "발행 큐는 편집 권한이 있는 멤버만 사용할 수 있습니다." }, 403);
  const config = wpConfig();
  if (!config) return json({ processed: 0 });
  if (await sharedLimited(account.supabase, `wpdrain:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  try {
    const r = await drainOne(account, config);
    return json({ processed: r.processed, job: r.job });
  } catch (e) {
    return e instanceof QueueError
      ? json({ error: e.message, code: e.code }, e.status)
      : json({ error: "발행 큐를 처리하지 못했습니다." }, 500);
  }
}
