import { parseCredentials } from "@/lib/auth";
import { json, rateLimited, readJson, sameOrigin } from "@/lib/server";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const supabase = await serverClient();
  if (!supabase) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  if (process.env.ALLOW_SIGNUP === "false")
    return json({ error: "현재 새 계정을 만들 수 없습니다." }, 403);
  let creds;
  try {
    creds = parseCredentials(await readJson(req, 5_000), { strict: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (rateLimited("signup", 10, 60_000))
    return json({ error: "시도가 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const { data, error } = await supabase.auth.signUp(creds);
  if (error) return json({ error: "계정을 만들지 못했습니다. 이미 가입된 이메일일 수 있어요." }, 400);
  // With email confirmation enabled there is no session yet.
  return json({ ok: true, needsConfirmation: !data.session });
}
