import { isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { teamError, WORKSPACE_COOKIE_NAME } from "@/lib/team";
import { cookies } from "next/headers";
import { sessionCookieOptions } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 초대 ID입니다." }, 400);
  // Core accepts by token: look it up among the caller's own invitations.
  const mine = await account.supabase.schema("public").rpc("nomad_my_invitations");
  if (mine.error) return json({ error: "초대를 불러오지 못했습니다." }, 500);
  const token = ((mine.data ?? []) as { id: string; token: string }[]).find((r) => r.id === id)?.token;
  if (!token) return json({ error: "초대를 찾을 수 없습니다." }, 404);
  const { data, error } = await account.supabase.schema("public").rpc("nomad_accept_invitation", { invite_token: token });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  // Switch to the workspace the user just joined.
  if (typeof data === "string")
    (await cookies()).set(WORKSPACE_COOKIE_NAME, data, { ...sessionCookieOptions(), maxAge: 60 * 60 * 24 * 30 });
  return json({ ok: true, workspaceId: data });
}