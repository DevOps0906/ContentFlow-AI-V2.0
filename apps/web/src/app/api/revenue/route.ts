import { dbError } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { fetchAll } from "@/lib/paging";
import { dbToRevenue, parseRevenueBatch, REVENUE_COLUMNS, toDbRows, type RevenueDbRow } from "@/lib/revenue-db";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canImportRevenue } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  try {
    const rows = await fetchAll<RevenueDbRow>((from, to) =>
      account.supabase
        .from("revenue_rows")
        .select(REVENUE_COLUMNS)
        .eq("workspace_id", account.workspaceId)
        .order("report_date", { ascending: true })
        .order("row_key", { ascending: true })
        .range(from, to),
    );
    return json({ rows: rows.map(dbToRevenue), canImport: canImportRevenue(account.role) });
  } catch {
    return json({ error: "수익 데이터를 불러오지 못했습니다." }, 500);
  }
}

/**
 * Adds rows. Rows already stored (same key) are skipped by the database, never overwritten; a
 * partly overlapping report period is refused by the database as a whole.
 */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canImportRevenue(account.role))
    return json({ error: "수익 데이터는 소유자·관리자만 가져올 수 있습니다." }, 403);
  let rows;
  try {
    rows = parseRevenueBatch(await readJson(req, 1_500_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `rev:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("revenue_rows")
    .upsert(toDbRows(rows, account.workspaceId, account.user.id), {
      onConflict: "workspace_id,row_key",
      ignoreDuplicates: true,
    })
    .select("row_key");
  if (error) {
    if (/period overlap/.test(error.message ?? ""))
      return json({ error: "기존 보고서 기간과 일부만 겹쳐 저장하지 않았습니다. 겹치지 않는 기간이나 똑같은 기간으로 다시 내보내 주세요." }, 409);
    const limit = /limit reached/.test(error.message ?? "");
    const e = dbError(error);
    return json(
      { error: limit ? "수익 데이터는 워크스페이스당 20,000행까지 저장할 수 있습니다." : e.message },
      limit ? 409 : e.status,
    );
  }
  const added = data?.length ?? 0;
  return json({ added, duplicates: rows.length - added });
}

/** Deletes every revenue row of the active workspace (owner/admin; RLS enforces it too). */
export async function DELETE(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canImportRevenue(account.role))
    return json({ error: "수익 데이터는 소유자·관리자만 삭제할 수 있습니다." }, 403);
  const { error } = await account.supabase
    .from("revenue_rows")
    .delete()
    .eq("workspace_id", account.workspaceId);
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  return json({ ok: true });
}