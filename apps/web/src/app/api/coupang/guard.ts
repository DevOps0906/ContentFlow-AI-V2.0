// Coupang routes (AFFILIATE_COMMERCE.md §4.2 보호): the Naver guard order with a `coupang:` key,
// 5 per user per minute (r2 ③), then the shared hourly limit for the one key.
import { COUPANG_LIMITS, type CoupangOptions } from "@/lib/coupang";
import { json, sharedLimited } from "@/lib/server";
import { naverGuard } from "../naver/guard";

export async function coupangGuard(req: Request): Promise<{ ok: true; opts: CoupangOptions } | { ok: false; res: Response }> {
  const guard = await naverGuard(req, { prefix: "coupang", perMinute: COUPANG_LIMITS.userPerMinute, feature: "쿠팡 상품 검색·링크 변환" });
  if (!guard.ok) return guard;
  const log = guard.log;
  return {
    ok: true,
    opts: {
      caller: log ? { mode: "account", workspaceId: log.workspaceId } : { mode: "local" },
      globalLimited: () => sharedLimited(guard.limiter, "coupang:global", COUPANG_LIMITS.globalPerHour, 3_600_000),
    },
  };
}

export function badRequest(e: unknown) {
  return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
}
