import { cookies } from "next/headers";
import { isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { json, readJson } from "@/lib/server";
import { sessionCookieOptions } from "@/lib/supabase";
import { WORKSPACE_COOKIE_NAME } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Switches the active workspace. Only a workspace the user belongs to can be chosen. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  let id: unknown;
  try {
    id = ((await readJson(req, 1_000)) as { id?: unknown } | null)?.id;
  } catch {
    return json({ error: "잘못된 요청입니다." }, 400);
  }
  if (typeof id !== "string" || !isUuid(id)) return json({ error: "잘못된 워크스페이스 ID입니다." }, 400);
  const m = await account.supabase
    .from("memberships")
    .select("workspace_id")
    .eq("user_id", account.user.id)
    .eq("workspace_id", id)
    .maybeSingle();
  if (m.error) return json({ error: "워크스페이스를 확인하지 못했습니다." }, 500);
  if (!m.data) return json({ error: "속해 있지 않은 워크스페이스입니다." }, 403);
  (await cookies()).set(WORKSPACE_COOKIE_NAME, id, { ...sessionCookieOptions(), maxAge: 60 * 60 * 24 * 30 });
  return json({ ok: true });
}