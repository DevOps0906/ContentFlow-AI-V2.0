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
  const { data, error } = await account.supabase.rpc("accept_invitation", { inv: id });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  // Switch to the workspace the user just joined.
  if (typeof data === "string")
    (await cookies()).set(WORKSPACE_COOKIE_NAME, data, { ...sessionCookieOptions(), maxAge: 60 * 60 * 24 * 30 });
  return json({ ok: true, workspaceId: data });
}