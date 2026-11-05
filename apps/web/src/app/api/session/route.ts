import { json } from "@/lib/server";
import { getAccount, supabaseEnv } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** `local`: no Supabase configured. Otherwise reports the logged-in email and role, if any. */
export async function GET() {
  if (!supabaseEnv()) return json({ mode: "local" });
  let account;
  try {
    account = await getAccount();
  } catch {
    return json({ mode: "account", user: null, signup: process.env.ALLOW_SIGNUP !== "false" });
  }
  return json({
    mode: "account",
    user: account.mode === "account" ? { email: account.user.email ?? "", role: account.role } : null,
    signup: process.env.ALLOW_SIGNUP !== "false",
  });
}