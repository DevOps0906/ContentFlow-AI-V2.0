import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Workspaces the user belongs to, with their role in each, and which one is active. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const m = await account.supabase
    .from("memberships")
    .select("workspace_id, role")
    .eq("user_id", account.user.id)
    .order("created_at", { ascending: true });
  if (m.error) return json({ error: "워크스페이스를 불러오지 못했습니다." }, 500);
  const ids = (m.data ?? []).map((x) => x.workspace_id as string);
  const w = ids.length
    ? await account.supabase.from("workspaces").select("id, name").in("id", ids)
    : { data: [], error: null };
  if (w.error) return json({ error: "워크스페이스를 불러오지 못했습니다." }, 500);
  const names = new Map((w.data ?? []).map((x) => [x.id as string, x.name as string]));
  return json({
    active: account.workspaceId,
    workspaces: (m.data ?? []).map((x) => ({
      id: x.workspace_id as string,
      name: names.get(x.workspace_id as string) ?? "워크스페이스",
      role: x.role,
    })),
  });
}