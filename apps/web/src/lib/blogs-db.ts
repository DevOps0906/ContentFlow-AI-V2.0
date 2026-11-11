// Server-side checks for blog accounts. The database trigger (0018) enforces the same rule.
import type { Authed } from "./api";
import { fetchAll } from "./paging";

export const ARCHIVED_BLOG_MESSAGE = "보관된 블로그 계정에는 새로 연결하거나 기록할 수 없습니다. 계정을 복원한 뒤 다시 시도해주세요.";

/** The archived accounts among `ids` (this workspace only). */
export async function archivedBlogIds(account: Authed, ids: (string | null)[]): Promise<Set<string>> {
  const list = [...new Set(ids.filter((id): id is string => !!id))];
  if (list.length === 0) return new Set();
  const { data, error } = await account.supabase
    .from("blogs")
    .select("id")
    .eq("workspace_id", account.workspaceId)
    .eq("status", "archived")
    .in("id", list);
  if (error) throw new Error("블로그 계정을 확인하지 못했습니다.");
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

/**
 * Everything already stored for the given (archived) accounts. Rows for an archived account are
 * accepted only when they are in this list: the database ignores those as duplicates.
 */
export function storedForBlogs<T>(account: Authed, table: "keyword_trends" | "blog_metric_snapshots", columns: string, blogIds: string[]) {
  return fetchAll<T>((from, to) =>
    account.supabase
      .from(table)
      .select(columns)
      .eq("workspace_id", account.workspaceId)
      .in("blog_id", blogIds)
      .order("id", { ascending: true })
      .range(from, to) as never,
  );
}
