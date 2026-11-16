import { requireAccount } from "@/lib/api";
import { buildUsage, type EntitlementRow } from "@/lib/blog-usage";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Active blogs, included/max numbers, this month's peak and overage slots of the workspace (any member). */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  // Blog limits moved to nomad_core.plan_limits (keys included_blogs · max_blogs · overage_allowed),
  // which has no Data API read RPC yet: until one exists the usage answers 404 like a missing row.
  const ent = { data: null as EntitlementRow | null, error: null };
  const [count, snap] = await Promise.all([
    account.supabase
      .from("blogs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", account.workspaceId)
      .eq("status", "active"),
    account.supabase
      .from("blog_usage_snapshots")
      .select("period_start,peak_active")
      .eq("organization_id", account.workspaceId)
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (ent.error || count.error || snap.error) return json({ error: "블로그 사용량을 불러오지 못했습니다." }, 500);
  if (!ent.data) return json({ error: "블로그 사용량을 불러오지 못했습니다." }, 404);
  return json(
    buildUsage(
      ent.data as EntitlementRow,
      count.count ?? 0,
      snap.data as { period_start: string; peak_active: number } | null,
      account.role,
    ),
  );
}
