import { isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { json, readJson } from "@/lib/server";
import { isRole, teamError } from "@/lib/team";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ userId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { userId } = await ctx.params;
  if (!isUuid(userId)) return json({ error: "잘못된 사용자 ID입니다." }, 400);
  let role: unknown;
  try {
    role = ((await readJson(req, 1_000)) as { role?: unknown } | null)?.role;
  } catch {
    return json({ error: "잘못된 요청입니다." }, 400);
  }
  if (!isRole(role) || role === "owner") return json({ error: "부여할 수 없는 역할입니다." }, 400);
  const { error } = await account.supabase.schema("public").rpc("nomad_change_member_role", {
    target_organization: account.workspaceId,
    target_user: userId,
    new_role: role,
  });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ ok: true });
}

/** Removes a member, or lets the caller leave (their own id). */
export async function DELETE(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { userId } = await ctx.params;
  if (!isUuid(userId)) return json({ error: "잘못된 사용자 ID입니다." }, 400);
  const { error } = await account.supabase
    .schema("public")
    .rpc("nomad_remove_member", { target_organization: account.workspaceId, target_user: userId });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ ok: true });
}