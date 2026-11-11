import { dbError, isUuid } from "@/lib/articles-db";
import { parseBlogLink } from "@/lib/blogs";
import { ARCHIVED_BLOG_MESSAGE, archivedBlogIds } from "@/lib/blogs-db";
import { KEYWORD_COLUMNS, rowToKeyword, type KeywordRow } from "@/lib/keywords-db";
import { json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { canManageBlogs } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Links a keyword to a blog account or clears the link (owner/admin; a trigger enforces it too). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (!canManageBlogs(account.role)) return json({ error: "키워드의 블로그 계정은 소유자·관리자만 바꿀 수 있습니다." }, 403);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 키워드 ID입니다." }, 400);
  let blogId;
  try {
    blogId = parseBlogLink(await readJson(req, 1_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `kw:${account.user.id}`, 30, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  if (blogId) {
    // Archived accounts take no new links; keeping the current one is fine.
    const current = await account.supabase.from("keywords").select("blog_id").eq("id", id).eq("workspace_id", account.workspaceId).maybeSingle();
    if (current.error) return json({ error: "키워드를 확인하지 못했습니다." }, 500);
    if (current.data?.blog_id !== blogId) {
      try {
        if ((await archivedBlogIds(account, [blogId])).has(blogId)) return json({ error: ARCHIVED_BLOG_MESSAGE }, 409);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "블로그 계정을 확인하지 못했습니다." }, 500);
      }
    }
  }
  const { data, error } = await account.supabase
    .from("keywords")
    .update({ blog_id: blogId })
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select(KEYWORD_COLUMNS)
    .maybeSingle();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  if (!data) return json({ error: "키워드를 찾을 수 없습니다." }, 404);
  return json({ keyword: rowToKeyword(data as KeywordRow) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 키워드 ID입니다." }, 400);
  const { data, error } = await account.supabase
    .from("keywords")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  if (!data?.length) return json({ error: "삭제할 수 없거나 이미 삭제된 키워드입니다." }, 404);
  return json({ ok: true });
}
