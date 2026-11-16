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
  // The invitee declines their own invitation; anyone else revokes (core allows owner/admin only).
  const mine = await account.supabase.schema("public").rpc("nomad_my_invitations");
  if (mine.error) return json({ error: "초대를 불러오지 못했습니다." }, 500);
  const own = ((mine.data ?? []) as { id: string }[]).some((r) => r.id === id);
  const { error } = own
    ? await account.supabase.schema("public").rpc("nomad_decline_invitation", { invitation_id: id })
    : await account.supabase.schema("public").rpc("nomad_revoke_invitation", { invitation_id: id });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ ok: true });
}