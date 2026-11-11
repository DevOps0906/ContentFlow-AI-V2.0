import { requireAccount } from "@/lib/api";
import { dbError } from "@/lib/articles-db";
import { json, readJson, sharedLimited } from "@/lib/server";
import {
  dbToSiteCheck,
  mergeSiteChecks,
  parseSiteCheck,
  SITE_CHECK_COLUMNS,
  toDbSiteCheck,
  type SiteCheckDbRow,
} from "@/lib/site-checks";
import { canRecordSiteChecks } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Every item of the active workspace; items nobody recorded come back as unknown. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role } = account;
  const [rows, members] = await Promise.all([
    supabase.from("site_checks").select(SITE_CHECK_COLUMNS).eq("workspace_id", workspaceId),
    supabase.rpc("workspace_members", { ws: workspaceId }),
  ]);
  if (rows.error || members.error) return json({ error: "사이트 점검을 불러오지 못했습니다." }, 500);
  const emails = new Map((members.data as { user_id: string; email: string }[]).map((m) => [m.user_id, m.email]));
  const saved = (rows.data as SiteCheckDbRow[]).map((r) => dbToSiteCheck(r, emails.get(r.checked_by) ?? null));
  return json({ checks: mergeSiteChecks(saved), canRecord: canRecordSiteChecks(role) });
}

/** Records one item (owner/admin; RLS enforces it too). The database stamps who and when. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canRecordSiteChecks(account.role))
    return json({ error: "사이트 점검은 소유자·관리자만 기록할 수 있습니다." }, 403);
  let input;
  try {
    input = parseSiteCheck(await readJson(req, 8_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `site:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("site_checks")
    .upsert(toDbSiteCheck(input, account.workspaceId), { onConflict: "workspace_id,check_key" })
    .select(SITE_CHECK_COLUMNS)
    .single();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ check: dbToSiteCheck(data as SiteCheckDbRow, account.user.email ?? null) });
}
