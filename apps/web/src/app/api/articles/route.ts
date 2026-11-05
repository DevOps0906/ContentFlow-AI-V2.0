import { ARTICLE_COLUMNS, rowToArticle, type ArticleRow } from "@/lib/articles-db";
import { json } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** All articles of the caller's workspace (RLS also limits this to workspace members). */
export async function GET() {
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  const { data, error } = await account.supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("workspace_id", account.workspaceId)
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) return json({ error: "콘텐츠를 불러오지 못했습니다." }, 500);
  return json({ articles: (data as ArticleRow[]).map(rowToArticle) });
}