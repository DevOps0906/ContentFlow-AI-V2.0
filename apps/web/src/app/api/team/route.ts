import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { canManageTeam, grantableRoles, type Role } from "@/lib/team";

export const dynamic = "force-dynamic";

type Member = { user_id: string; email: string; role: Role; is_reviewer: boolean };
type InvitationRow = { id: string; email: string; role: Role; invited_by: string | null; expires_at: string; created_at: string };

/** Members of the active workspace, plus pending invitations for owner/admin. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role, user } = account;
  const members = await supabase.rpc("workspace_members", { ws: workspaceId });
  if (members.error) return json({ error: "멤버를 불러오지 못했습니다." }, 500);
  const memberRows = members.data as Member[];
  let invitations: unknown[] = [];
  if (canManageTeam(role)) {
    // Unaccepted invitations, expired ones included (they block a re-invite, so they stay cancellable).
    // Core returns the inviter's user id only: the email comes from the member list.
    const inv = await supabase.schema("public").rpc("nomad_organization_invitations", { target_organization: workspaceId });
    if (inv.error) return json({ error: "초대 목록을 불러오지 못했습니다." }, 500);
    invitations = (inv.data as InvitationRow[]).map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      invitedBy: memberRows.find((m) => m.user_id === i.invited_by)?.email ?? "",
      expires_at: i.expires_at,
      created_at: i.created_at,
    }));
  }
  return json({
    role,
    me: user.id,
    grantable: grantableRoles(role),
    members: memberRows.map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: m.role,
      isReviewer: m.is_reviewer,
    })),
    invitations,
  });
}