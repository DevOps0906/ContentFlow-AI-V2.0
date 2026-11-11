import { json, readJson, sharedLimited } from "@/lib/server";
import { bearerClient, supabaseEnv } from "@/lib/supabase";
import { ipLimit, tokenBody } from "@/lib/token-session";

export const dynamic = "force-dynamic";

/** Mobile refresh: swaps a refresh token for a new session. Fails after revoke. */
export async function POST(req: Request) {
  const env = supabaseEnv();
  if (!env) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  const supabase = bearerClient(env);
  const ip = ipLimit(req, 30, 120);
  if (await sharedLimited(supabase, `refresh-${ip.key}`, ip.max, 60_000))
    return json({ error: "시도가 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let token = "";
  try {
    const body = (await readJson(req, 5_000)) as { refresh_token?: unknown };
    if (typeof body?.refresh_token === "string") token = body.refresh_token.trim();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (!token || token.length > 500) return json({ error: "잘못된 요청입니다." }, 400);
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: token });
  if (error || !data.session) return json({ error: "다시 로그인해주세요." }, 401);
  return json(tokenBody(data.session));
}
