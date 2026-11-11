import { bearerToken } from "@/lib/mobile";
import { json } from "@/lib/server";
import { headers } from "next/headers";
import { getAccount, supabaseEnv, WorkspaceError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** `local`: no Supabase configured. Otherwise reports the logged-in email and role, if any. */
export async function GET() {
  if (!supabaseEnv()) return json({ mode: "local" });
  const bearer = bearerToken(await headers()) !== null;
  let account;
  try {
    account = await getAccount({ bearer });
  } catch (e) {
    if (e instanceof WorkspaceError) return json({ error: e.message }, e.status);
    return json({ mode: "account", user: null, signup: process.env.ALLOW_SIGNUP !== "false" });
  }
  if (bearer && account.mode !== "account") return json({ error: "로그인이 필요합니다." }, 401);
  return json({
    mode: "account",
    user: account.mode === "account" ? { email: account.user.email ?? "", role: account.role } : null,
    signup: process.env.ALLOW_SIGNUP !== "false",
  });
}