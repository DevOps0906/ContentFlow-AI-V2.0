import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { canManageTeam, grantableRoles, type Role } from "@/lib/team";

export const dynamic = "force-dynamic";

type Member = { user_id: string; email: string; role: Role; created_at: string };

/** Members of the active workspace, plus pending invitations for owner/admin. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role, user } = account;
  const members = await supabase.rpc("workspace_members", { ws: workspaceId });
  if (members.error) return json({ error: "멤버를 불러오지 못했습니다." }, 500);
  let invitations: unknown[] = [];
  if (canManageTeam(role)) {
    const inv = await supabase
      .from("invitations")
      .select("id,email,role,created_at,accepted_at")
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false });
    if (inv.error) return json({ error: "초대 목록을 불러오지 못했습니다." }, 500);
    invitations = inv.data ?? [];
  }
  return json({
    role,
    me: user.id,
    grantable: grantableRoles(role),
    members: (members.data as Member[]).map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: m.role,
      joinedAt: m.created_at,
    })),
    invitations,
  });
}