import { parseCredentials } from "@/lib/auth";
import { json, rateLimited, readJson, sameOrigin } from "@/lib/server";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const supabase = await serverClient();
  if (!supabase) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  let creds;
  try {
    creds = parseCredentials(await readJson(req, 5_000), { strict: false });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (rateLimited(`login:${creds.email}`, 8, 60_000))
    return json({ error: "시도가 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const { error } = await supabase.auth.signInWithPassword(creds);
  // Same message for unknown user and wrong password: no account enumeration.
  if (error) return json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." }, 401);
  return json({ ok: true });
}
