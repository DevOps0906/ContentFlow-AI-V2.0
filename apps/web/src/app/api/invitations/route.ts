import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

type Row = { id: string; workspace_name: string; role: string; invited_by_email: string; created_at: string };

/** Invitations addressed to the logged-in user's confirmed email. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { data, error } = await account.supabase.rpc("my_invitations");
  if (error) return json({ error: "초대를 불러오지 못했습니다." }, 500);
  return json({
    invitations: (data as Row[]).map((r) => ({
      id: r.id,
      workspaceName: r.workspace_name,
      role: r.role,
      invitedBy: r.invited_by_email,
      createdAt: r.created_at,
    })),
  });
}