import { dbError, isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { fetchAll } from "@/lib/paging";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canEdit } from "@/lib/team";
import { dbToTrend, parseTrendBatch, TREND_COLUMNS, TREND_CONFLICT, trendsToDbRows, type TrendDbRow } from "@/lib/trends";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  try {
    const rows = await fetchAll<TrendDbRow>((from, to) =>
      account.supabase
        .from("keyword_trends")
        .select(TREND_COLUMNS)
        .eq("workspace_id", account.workspaceId)
        .order("measured_on", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return json({ rows: rows.map(dbToTrend), canWrite: canEdit(account.role) });
  } catch {
    return json({ error: "트렌드 데이터를 불러오지 못했습니다." }, 500);
  }
}

/** Adds rows. A measurement already stored is skipped by the database, never overwritten. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "트렌드 데이터는 소유자·관리자·편집자만 입력할 수 있습니다." }, 403);
  let rows;
  try {
    rows = parseTrendBatch(await readJson(req, 1_000_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `trend:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("keyword_trends")
    .upsert(trendsToDbRows(rows, account.workspaceId, account.user.id), { onConflict: TREND_CONFLICT, ignoreDuplicates: true })
    .select("id");
  if (error) {
    const limit = /limit reached/.test(error.message ?? "");
    const e = dbError(error);
    return json({ error: limit ? "트렌드 데이터는 워크스페이스당 20,000행까지 저장할 수 있습니다." : e.message }, limit ? 409 : e.status);
  }
  const added = data?.length ?? 0;
  return json({ added, duplicates: rows.length - added });
}

/** Deletes one row of the active workspace (owner/admin/editor; RLS enforces it too). */
export async function DELETE(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "트렌드 데이터는 소유자·관리자·편집자만 삭제할 수 있습니다." }, 403);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isUuid(id)) return json({ error: "잘못된 ID입니다." }, 400);
  const { data, error } = await account.supabase
    .from("keyword_trends")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  if (!data?.length) return json({ error: "삭제할 수 없거나 이미 삭제된 행입니다." }, 404);
  return json({ ok: true });
}
