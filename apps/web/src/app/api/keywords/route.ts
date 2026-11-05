import { dbError } from "@/lib/articles-db";
import { KEYWORD_COLUMNS, parseNewKeywords, rowToKeyword, type KeywordRow } from "@/lib/keywords-db";
import { json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { fetchAll } from "@/lib/paging";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  try {
    // max_rows is 1000: read in pages. id is the final tie-break so pages never overlap.
    const rows = await fetchAll<KeywordRow>((from, to) =>
      account.supabase
        .from("keywords")
        .select(KEYWORD_COLUMNS)
        .eq("workspace_id", account.workspaceId)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return json({ keywords: rows.map(rowToKeyword) });
  } catch {
    return json({ error: "키워드를 불러오지 못했습니다." }, 500);
  }
}

/** Adds keywords. Duplicates (already stored) are skipped by the database, never overwritten. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (await sharedLimited(account.supabase, `kw:${account.user.id}`, 30, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  let items;
  try {
    items = parseNewKeywords(await readJson(req, 400_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const rows = items.map((k) => ({
    ...k,
    workspace_id: account.workspaceId,
    created_by: account.user.id,
  }));
  const { data, error } = await account.supabase
    .from("keywords")
    .upsert(rows, { onConflict: "workspace_id,phrase_key", ignoreDuplicates: true })
    .select("id");
  if (error) {
    const e = dbError(error);
    const limit = /limit reached/.test(error.message ?? "");
    return json(
      { error: limit ? "키워드는 워크스페이스당 5,000개까지 저장할 수 있습니다." : e.message },
      limit ? 409 : e.status,
    );
  }
  const added = data?.length ?? 0;
  return json({ added, duplicates: rows.length - added });
}