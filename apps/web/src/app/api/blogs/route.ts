import { requireAccount } from "@/lib/api";
import { dbError } from "@/lib/articles-db";
import { BLOG_COLUMNS, dbToBlog, parseBlog, parseBlogUpdate, type BlogDbRow } from "@/lib/blogs";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canManageBlogs } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Every account of the active workspace, archived ones too: their past data stays filterable. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { data, error } = await account.supabase
    .from("blogs")
    .select(BLOG_COLUMNS)
    .eq("workspace_id", account.workspaceId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) return json({ error: "블로그 계정을 불러오지 못했습니다." }, 500);
  return json({ blogs: (data as BlogDbRow[]).map(dbToBlog), canManage: canManageBlogs(account.role) });
}

/** Adds an account (owner/admin; RLS enforces it too). */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageBlogs(account.role)) return json({ error: "블로그 계정은 소유자·관리자만 관리할 수 있습니다." }, 403);
  let fields;
  try {
    fields = parseBlog(await readJson(req, 4_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `blog:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("blogs")
    .insert({ ...fields, workspace_id: account.workspaceId })
    .select(BLOG_COLUMNS)
    .single();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ blog: dbToBlog(data as BlogDbRow) });
}

/** Edits or archives an account (owner/admin; RLS enforces it too). Accounts are never deleted here. */
export async function PATCH(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageBlogs(account.role)) return json({ error: "블로그 계정은 소유자·관리자만 관리할 수 있습니다." }, 403);
  let update;
  try {
    update = parseBlogUpdate(await readJson(req, 4_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `blog:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("blogs")
    .update(update.fields)
    .eq("id", update.id)
    .eq("workspace_id", account.workspaceId)
    .select(BLOG_COLUMNS)
    .maybeSingle();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  if (!data) return json({ error: "블로그 계정을 찾을 수 없습니다." }, 404);
  return json({ blog: dbToBlog(data as BlogDbRow) });
}
