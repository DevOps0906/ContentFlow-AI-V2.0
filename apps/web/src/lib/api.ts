// Shared guard for account-only API routes.
import { headers } from "next/headers";
import { bearerToken } from "./mobile";
import { getAccount, WorkspaceError } from "./supabase";
import { json, sameOrigin } from "./server";

export type Authed = Extract<Awaited<ReturnType<typeof getAccount>>, { mode: "account" }>;

/**
 * Returns the logged-in account, or the Response to send back. Writes (anything but GET) must
 * come from this site's own pages. Every account route calls this itself: the proxy is not the
 * only gate. A Bearer (mobile) caller is refused with 403 unless the route opts in with
 * `{ bearer: true }`; only read-only GET routes may do that.
 */
export async function requireAccount(req: Request, opts: { bearer?: boolean } = {}): Promise<Response | Authed> {
  const bearer = bearerToken(await headers()) !== null;
  if (bearer && (!opts.bearer || req.method !== "GET")) return json({ error: "허용되지 않은 요청입니다." }, 403);
  if (!bearer && req.method !== "GET" && !sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  let account;
  try {
    account = await getAccount({ bearer: bearer && opts.bearer });
  } catch (e) {
    if (e instanceof WorkspaceError) return json({ error: e.message }, e.status);
    throw e;
  }
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  return account;
}