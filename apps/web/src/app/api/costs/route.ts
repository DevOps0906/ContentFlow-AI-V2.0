import { requireAccount } from "@/lib/api";
import { dbError, isUuid } from "@/lib/articles-db";
import {
  AGENT_RUN_COST_COLUMNS,
  COST_COLUMNS,
  dbToCost,
  parseCostEntry,
  summarizeCosts,
  summarizeRunEstimates,
  toDbCost,
  type AgentRunCostRow,
  type CostDbRow,
} from "@/lib/costs";
import { fetchAll } from "@/lib/paging";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canRecordCosts } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Ledger entries with per-currency totals, and the AI call estimates as a separate reference. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role } = account;
  try {
    const [rows, runs] = await Promise.all([
      fetchAll<CostDbRow>((from, to) =>
        supabase
          .from("cost_entries")
          .select(COST_COLUMNS)
          .eq("workspace_id", workspaceId)
          .order("occurred_on", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAll<AgentRunCostRow>((from, to) =>
        supabase
          .from("agent_runs")
          .select(AGENT_RUN_COST_COLUMNS)
          .eq("workspace_id", workspaceId)
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ]);
    const entries = rows.map(dbToCost);
    return json({
      entries,
      totals: summarizeCosts(entries),
      runEstimates: summarizeRunEstimates(runs),
      canRecord: canRecordCosts(role),
    });
  } catch {
    return json({ error: "원가 정보를 불러오지 못했습니다." }, 500);
  }
}

/** Records one manual entry (owner/admin; RLS enforces it too). */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canRecordCosts(account.role)) return json({ error: "원가는 소유자·관리자만 기록할 수 있습니다." }, 403);
  let input;
  try {
    input = parseCostEntry(await readJson(req, 4_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `cost:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("cost_entries")
    .insert(toDbCost(input, account.workspaceId, account.user.id))
    .select(COST_COLUMNS)
    .single();
  if (error) {
    const e = dbError(error);
    return json({ error: e.message }, e.status);
  }
  return json({ entry: dbToCost(data as CostDbRow) });
}

/** Removes a mistaken entry of the active workspace (owner/admin; RLS enforces it too). */
export async function DELETE(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canRecordCosts(account.role)) return json({ error: "원가는 소유자·관리자만 삭제할 수 있습니다." }, 403);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isUuid(id)) return json({ error: "잘못된 요청입니다." }, 400);
  const { data, error } = await account.supabase
    .from("cost_entries")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  if (!data?.length) return json({ error: "원가 기록을 찾을 수 없습니다." }, 404);
  return json({ ok: true });
}
