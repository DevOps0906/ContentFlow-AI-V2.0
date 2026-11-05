import { json } from "@/lib/server";
import { serverClient, supabaseEnv } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** `local`: no Supabase configured. Otherwise reports the logged-in email, if any. */
export async function GET() {
  if (!supabaseEnv()) return json({ mode: "local" });
  const supabase = await serverClient();
  const { data } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  return json({
    mode: "account",
    user: data.user ? { email: data.user.email ?? "" } : null,
    signup: process.env.ALLOW_SIGNUP !== "false",
  });
}
