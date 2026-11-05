import { json, sameOrigin } from "@/lib/server";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const supabase = await serverClient();
  if (supabase) await supabase.auth.signOut();
  return json({ ok: true });
}
