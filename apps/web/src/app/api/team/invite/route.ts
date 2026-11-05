import { requireAccount } from "@/lib/api";
import { json, readJson, sharedLimited } from "@/lib/server";
import { parseInvite, teamError } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  let invite;
  try {
    invite = parseInvite(await readJson(req, 2_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `invite:${account.user.id}`, 20, 3_600_000))
    return json({ error: "초대를 너무 많이 보냈습니다. 잠시 후 다시 시도해주세요." }, 429);
  const { data, error } = await account.supabase.rpc("invite_member", {
    ws: account.workspaceId,
    p_email: invite.email,
    p_role: invite.role,
  });
  if (error) {
    const e = teamError(error);
    return json({ error: e.message }, e.status);
  }
  // No email is sent: the invitee sees it after signing up or logging in with this address.
  return json({ ok: true, id: data });
}