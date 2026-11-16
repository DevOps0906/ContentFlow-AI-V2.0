import { requireAccount } from "@/lib/api";
import { json } from "@/lib/server";
import { myOrganizations } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Workspaces the user belongs to, with their role in each, and which one is active. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  let list;
  try {
    list = await myOrganizations(account.supabase);
  } catch {
    return json({ error: "워크스페이스를 불러오지 못했습니다." }, 500);
  }
  return json({
    active: account.workspaceId,
    workspaces: list.map((x) => ({ id: x.id, name: x.name, role: x.role })),
  });
}
