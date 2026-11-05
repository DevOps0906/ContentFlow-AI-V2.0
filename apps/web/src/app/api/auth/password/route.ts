import { parseNewPassword } from "@/lib/auth";
import { requireAccount } from "@/lib/api";
import { json, readJson, sharedLimited } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Sets a new password for the logged-in user (a recovery link logs the user in first). */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  let password: string;
  try {
    password = parseNewPassword(await readJson(req, 2_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `pw:${account.user.id}`, 10, 3_600_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const { error } = await account.supabase.auth.updateUser({ password });
  if (error) return json({ error: "비밀번호를 바꾸지 못했습니다. 다른 비밀번호로 다시 시도해주세요." }, 400);
  return json({ ok: true });
}