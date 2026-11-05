import { isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { teamError } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Revoke (owner/admin) or decline (the invitee). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 초대 ID입니다." }, 400);
  const { error } = await account.supabase.rpc("delete_invitation", { inv: id });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ ok: true });
}