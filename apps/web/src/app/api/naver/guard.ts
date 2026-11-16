// Shared guard for the Naver routes (§11 보호, §11.1): same order as /api/ai/generate.
// sameOrigin → login → edit role (account mode) or this machine only (local mode) → rate limit.
// Input size is checked by each route after this.
import type { RunLog } from "@/lib/agent-runs";
import { isLocalHost } from "@/lib/naver-research";
import { json, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { canEdit } from "@/lib/team";

type GuardOptions = { prefix: string; perMinute: number; feature: string };
const NAVER: GuardOptions = { prefix: "naver", perMinute: 10, feature: "네이버 레퍼런스·AI 제목" };

/** Also used by the Coupang routes (AFFILIATE_COMMERCE.md §4.2) with their own prefix and limit. */
export async function naverGuard(req: Request, opts: GuardOptions = NAVER): Promise<{ ok: true; log: RunLog; limiter: Parameters<typeof sharedLimited>[0] } | { ok: false; res: Response }> {
  if (!sameOrigin(req)) return { ok: false, res: json({ error: "허용되지 않은 요청입니다." }, 403) };
  const account = await getAccount();
  if (account.mode === "anonymous") return { ok: false, res: json({ error: "로그인이 필요합니다." }, 401) };
  if (account.mode === "account" && !canEdit(account.role))
    return { ok: false, res: json({ error: `${opts.feature}은 편집 권한이 있는 멤버만 쓸 수 있습니다.` }, 403) };
  // Local mode has no login: answer only when the app is opened on this machine.
  if (account.mode === "local" && !isLocalHost(req.headers.get("host")))
    return { ok: false, res: json({ error: "로컬 모드에서는 이 컴퓨터(localhost)에서만 쓸 수 있습니다." }, 503) };
  const limitKey = account.mode === "account" ? `${opts.prefix}:${account.user.id}` : `${opts.prefix}:local`;
  if (await sharedLimited(account.mode === "account" ? account.supabase : null, limitKey, opts.perMinute, 60_000))
    return { ok: false, res: json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429) };
  return {
    ok: true,
    limiter: account.mode === "account" ? account.supabase : null,
    log: account.mode === "account" ? { client: account.supabase, workspaceId: account.workspaceId, userId: account.user.id } : null,
  };
}
