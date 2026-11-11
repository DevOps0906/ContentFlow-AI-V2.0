import { dbError, isUuid } from "@/lib/articles-db";
import { requireAccount } from "@/lib/api";
import { ARCHIVED_BLOG_MESSAGE, archivedBlogIds, storedForBlogs } from "@/lib/blogs-db";
import {
  dbToMetric,
  METRIC_COLUMNS,
  METRIC_CONFLICT,
  metricKey,
  metricsToDbRows,
  parseMetricBatch,
  type MetricDbRow,
} from "@/lib/blog-metrics";
import { fetchAll } from "@/lib/paging";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  try {
    const rows = await fetchAll<MetricDbRow>((from, to) =>
      account.supabase
        .from("blog_metric_snapshots")
        .select(METRIC_COLUMNS)
        .eq("workspace_id", account.workspaceId)
        .order("measured_on", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return json({ rows: rows.map(dbToMetric), canWrite: canEdit(account.role) });
  } catch {
    return json({ error: "성과 기록을 불러오지 못했습니다." }, 500);
  }
}

/** Adds values. A measurement already stored is skipped by the database, never overwritten. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "성과 기록은 소유자·관리자·편집자만 입력할 수 있습니다." }, 403);
  let rows;
  try {
    rows = parseMetricBatch(await readJson(req, 2_000_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `blog-metric:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  try {
    // Archived accounts take no new records; a value that is already stored is just ignored.
    const archived = await archivedBlogIds(account, rows.map((r) => r.blogId));
    if (archived.size > 0) {
      const known = new Set(
        (await storedForBlogs<MetricDbRow>(account, "blog_metric_snapshots", METRIC_COLUMNS, [...archived])).map((r) => metricKey(dbToMetric(r))),
      );
      if (rows.some((r) => r.blogId !== null && archived.has(r.blogId) && !known.has(metricKey(r))))
        return json({ error: ARCHIVED_BLOG_MESSAGE }, 409);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "블로그 계정을 확인하지 못했습니다." }, 500);
  }
  const { data, error } = await account.supabase
    .from("blog_metric_snapshots")
    .upsert(metricsToDbRows(rows, account.workspaceId, account.user.id), { onConflict: METRIC_CONFLICT, ignoreDuplicates: true })
    .select("id");
  if (error) {
    const limit = /limit reached/.test(error.message ?? "");
    const e = dbError(error);
    return json({ error: limit ? "성과 기록은 워크스페이스당 30,000개까지 저장할 수 있습니다." : e.message }, limit ? 409 : e.status);
  }
  const added = data?.length ?? 0;
  return json({ added, duplicates: rows.length - added });
}

/** Deletes one value of the active workspace (owner/admin/editor; RLS enforces it too). */
export async function DELETE(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "성과 기록은 소유자·관리자·편집자만 삭제할 수 있습니다." }, 403);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isUuid(id)) return json({ error: "잘못된 ID입니다." }, 400);
  const { data, error } = await account.supabase
    .from("blog_metric_snapshots")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  if (!data?.length) return json({ error: "삭제할 수 없거나 이미 삭제된 값입니다." }, 404);
  return json({ ok: true });
}
