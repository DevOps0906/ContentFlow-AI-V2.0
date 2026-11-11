import { parseCredentials } from "@/lib/auth";
import { json, readJson, sharedLimited } from "@/lib/server";
import { bearerClient, supabaseEnv } from "@/lib/supabase";
import { ipLimit, tokenBody } from "@/lib/token-session";

export const dynamic = "force-dynamic";

/** Mobile sign-in: returns the session as JSON. No cookies are read or written. */
export async function POST(req: Request) {
  const env = supabaseEnv();
  if (!env) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  const supabase = bearerClient(env);
  const ip = ipLimit(req, 10, 60);
  if (await sharedLimited(supabase, `token-${ip.key}`, ip.max, 60_000))
    return json({ error: "시도가 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let creds;
  try {
    creds = parseCredentials(await readJson(req, 5_000), { strict: false });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(supabase, `login:${creds.email}`, 8, 60_000))
    return json({ error: "시도가 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const { data, error } = await supabase.auth.signInWithPassword(creds);
  if (error || !data.session) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, 401);
  return json(tokenBody(data.session));
}
