import { requireAccount } from "@/lib/api";
import { buildUsage, type EntitlementRow } from "@/lib/blog-usage";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

type LimitRow = { plan_code: string; limit_key: string; limit_value: number };

/** plan_limits rows → the old entitlement shape. Grace period columns were dropped with the old table. */
function entitlementOf(rows: LimitRow[] | null): EntitlementRow | null {
  const get = (key: string) => rows?.find((r) => r.limit_key === key)?.limit_value;
  const included = get("included_blogs");
  const max = get("max_blogs");
  const overage = get("overage_allowed");
  if (included === undefined || max === undefined || overage === undefined) return null;
  return { included_blogs: included, max_blogs: max, overage_allowed: overage === 1, grace_until: null, grace_active_cap: null };
}

/** Active blogs, included/max numbers, this month's peak and overage slots of the workspace (any member). */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  // Blog limits live in nomad_core.plan_limits (product contentflow, keys included_blogs · max_blogs ·
  // overage_allowed 0/1). A missing key answers 404 like the old missing row (the triggers also refuse).
  const [limits, count, snap] = await Promise.all([
    account.supabase
      .schema("public")
      .rpc("nomad_plan_limits", { target_organization: account.workspaceId, target_product: "contentflow" }),
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
  if (limits.error || count.error || snap.error) return json({ error: "블로그 사용량을 불러오지 못했습니다." }, 500);
  const ent = entitlementOf(limits.data as LimitRow[] | null);
  if (!ent) return json({ error: "블로그 사용량을 불러오지 못했습니다." }, 404);
  return json(
    buildUsage(
      ent,
      count.count ?? 0,
      snap.data as { period_start: string; peak_active: number } | null,
      account.role,
    ),
  );
}
