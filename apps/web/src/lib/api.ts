// Shared guard for account-only API routes.
import { getAccount } from "./supabase";
import { json, sameOrigin } from "./server";

export type Authed = Extract<Awaited<ReturnType<typeof getAccount>>, { mode: "account" }>;

/**
 * Returns the logged-in account, or the Response to send back. Writes (anything but GET) must
 * come from this site's own pages. Every account route calls this itself: the proxy is not the
 * only gate.
 */
export async function requireAccount(req: Request): Promise<Response | Authed> {
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  return account;
}