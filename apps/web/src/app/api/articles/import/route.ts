import { dbError, articleToFields, isUuid, toImportable } from "@/lib/articles-db";
import { isArticle } from "@/lib/content";
import { json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * One-time import of the browser-stored articles. Reviewed/approved/published items come in
 * as `drafting`: the account has no approval snapshot for them, so they must be approved again.
 * Existing ids are skipped, never overwritten.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode !== "account") return json({ error: "로그인이 필요합니다." }, 401);
  if (await sharedLimited(account.supabase, `import:${account.user.id}`, 5, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  let list: unknown;
  try {
    list = ((await readJson(req, 5_000_000)) as { articles?: unknown })?.articles;
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (!Array.isArray(list) || list.length > 500)
    return json({ error: "가져올 콘텐츠는 500개 이하의 목록이어야 합니다." }, 400);
  const valid = list.filter(isArticle).map(toImportable);

  const existing = await account.supabase
    .from("articles")
    .select("id")
    .eq("workspace_id", account.workspaceId)
    .in("id", valid.map((a) => a.id));
  if (existing.error) return json({ error: "저장소 처리 중 오류가 발생했습니다." }, 500);
  const have = new Set((existing.data ?? []).map((r) => r.id as string));

  let imported = 0;
  let failed = 0;
  for (const a of valid) {
    if (have.has(a.id) || !isUuid(a.id)) continue;
    const { error } = await account.supabase.from("articles").insert({
      id: a.id,
      workspace_id: account.workspaceId,
      owner_id: account.user.id,
      ...articleToFields(a),
    });
    if (error) {
      failed++;
      if (dbError(error).status === 403) break;
    } else imported++;
  }
  return json({
    imported,
    skipped: valid.filter((a) => have.has(a.id)).length,
    invalid: list.length - valid.length,
    failed,
  });
}