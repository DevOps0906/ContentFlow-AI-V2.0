import { coupangAvailability } from "@/lib/coupang";
import { json } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Whether the panel can call Coupang here. Only the state and a message; never a key. */
export async function GET() {
  const account = await getAccount();
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  const a = coupangAvailability(account.mode === "account" ? { mode: "account", workspaceId: account.workspaceId } : { mode: "local" });
  return json(a.state === "ready" ? { state: "ready", message: "" } : a);
}
