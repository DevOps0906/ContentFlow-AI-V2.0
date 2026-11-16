// Coupang routes (AFFILIATE_COMMERCE.md §4.2 보호): the Naver guard order with a `coupang:` key,
// 5 per user per minute (r2 ③), then the shared limit for the one key (search 40/min, deeplink 10/hour).
import { COUPANG_LIMITS, type CoupangOptions } from "@/lib/coupang";
import { json, sharedLimited } from "@/lib/server";
import { naverGuard } from "../naver/guard";

export async function coupangGuard(
  req: Request,
  kind: "search" | "deeplink",
): Promise<{ ok: true; opts: CoupangOptions } | { ok: false; res: Response }> {
  const guard = await naverGuard(req, { prefix: "coupang", perMinute: COUPANG_LIMITS.userPerMinute, feature: "쿠팡 상품 검색·링크 변환" });
  if (!guard.ok) return guard;
  const log = guard.log;
  return {
    ok: true,
    opts: {
      caller: log ? { mode: "account", workspaceId: log.workspaceId } : { mode: "local" },
      globalLimited: () =>
        kind === "search"
          ? sharedLimited(guard.limiter, "coupang:global:search", COUPANG_LIMITS.searchGlobalPerMinute, 60_000)
          : sharedLimited(guard.limiter, "coupang:global:deeplink", COUPANG_LIMITS.deeplinkGlobalPerHour, 3_600_000),
    },
  };
}

export function badRequest(e: unknown) {
  return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
}
