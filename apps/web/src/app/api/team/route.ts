import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { grantableRoles, type Role } from "@/lib/team";

export const dynamic = "force-dynamic";

type Member = { user_id: string; email: string; role: Role; is_reviewer: boolean };

/** Members of the active workspace, plus pending invitations for owner/admin. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role, user } = account;
  const members = await supabase.rpc("workspace_members", { ws: workspaceId });
  if (members.error) return json({ error: "멤버를 불러오지 못했습니다." }, 500);
  // nomad_core.invitations is not exposed to the Data API and core has no list RPC for an
  // organization's pending invitations yet, so owner/admin get an empty list for now.
  const invitations: unknown[] = [];
  return json({
    role,
    me: user.id,
    grantable: grantableRoles(role),
    members: (members.data as Member[]).map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: m.role,
      isReviewer: m.is_reviewer,
    })),
    invitations,
  });
}