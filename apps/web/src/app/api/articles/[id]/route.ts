import {
  ARTICLE_COLUMNS,
  articleToFields,
  dbError,
  isUuid,
  parseIncomingArticle,
  rowToArticle,
  type ArticleRow,
} from "@/lib/articles-db";
import { json, readJson, sameOrigin } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

type Authed = Extract<Awaited<ReturnType<typeof getAccount>>, { mode: "account" }>;
async function guard(req: Request): Promise<Response | Authed> {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  return account;
}

/**
 * Create or update. The state in the body is only a request: the database trigger accepts it
 * only if it is a legal transition for the stored state (and voids approvals on edits).
 */
export async function PUT(req: Request, ctx: Ctx) {
  const account = await guard(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  let article;
  try {
    article = parseIncomingArticle(await readJson(req));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (article.id !== id) return json({ error: "콘텐츠 ID가 일치하지 않습니다." }, 400);

  const existing = await account.supabase
    .from("articles")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .maybeSingle();
  if (existing.error) return json({ error: "저장소 처리 중 오류가 발생했습니다." }, 500);

  const fields = articleToFields(article);
  const result = existing.data
    ? await account.supabase
        .from("articles")
        .update(fields)
        .eq("id", id)
        .eq("workspace_id", account.workspaceId)
        .select(ARTICLE_COLUMNS)
        .maybeSingle()
    : await account.supabase
        .from("articles")
        .insert({ id, workspace_id: account.workspaceId, owner_id: account.user.id, ...fields })
        .select(ARTICLE_COLUMNS)
        .maybeSingle();
  if (result.error) {
    const e = dbError(result.error);
    return json({ error: e.message }, e.status);
  }
  // RLS hides rows the caller may not change: an update then matches nothing.
  if (!result.data) return json({ error: "이 콘텐츠를 수정할 권한이 없습니다." }, 403);
  return json({ article: rowToArticle(result.data as ArticleRow) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const account = await guard(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  const { data, error } = await account.supabase
    .from("articles")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  if (!data?.length) return json({ error: "삭제할 수 없거나 이미 삭제된 콘텐츠입니다." }, 404);
  return json({ ok: true });
}