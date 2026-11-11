import { ARTICLE_COLUMNS, dbError, isUuid, parseReviewDecision, rowToArticle, type ArticleRow } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { json, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** A person's evidence and rights decision. The database trigger decides who may set it and when. */
export async function PATCH(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  let decision;
  try {
    decision = parseReviewDecision(await readJson(req));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const { data, error } = await account.supabase
    .from("articles")
    .update({ evidence_status: decision.evidenceStatus, rights_status: decision.rightsStatus })
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select(ARTICLE_COLUMNS)
    .maybeSingle();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  if (!data) return json({ error: "이 콘텐츠를 검토할 권한이 없습니다." }, 403);
  return json({ article: rowToArticle(data as ArticleRow) });
}
