import { appOrigin, parseEmail } from "@/lib/auth";
import { json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Sends a password-reset e-mail. Always answers the same way: no account enumeration. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const supabase = await serverClient();
  if (!supabase) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  let email: string;
  try {
    email = parseEmail(await readJson(req, 2_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(supabase, `reset:${email}`, 3, 3_600_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  if (await sharedLimited(supabase, "reset:all", 30, 3_600_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appOrigin(req)}/auth/callback?next=/reset`,
  });
  return json({ ok: true });
}