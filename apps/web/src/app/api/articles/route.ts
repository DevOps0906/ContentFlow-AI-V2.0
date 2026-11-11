import { ARTICLE_COLUMNS, rowToArticle, type ArticleRow } from "@/lib/articles-db";
import { json } from "@/lib/server";
import { fetchAll } from "@/lib/paging";
import { requireAccount } from "@/lib/api";

export const dynamic = "force-dynamic";

/** All articles of the caller's workspace (RLS also limits this to workspace members). */
export async function GET(req: Request) {
  const account = await requireAccount(req, { bearer: true });
  if (account instanceof Response) return account;
  try {
    const rows = await fetchAll<ArticleRow>((from, to) =>
      account.supabase
        .from("articles")
        .select(ARTICLE_COLUMNS)
        .eq("workspace_id", account.workspaceId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return json({ articles: rows.map(rowToArticle) });
  } catch {
    return json({ error: "콘텐츠를 불러오지 못했습니다." }, 500);
  }
}