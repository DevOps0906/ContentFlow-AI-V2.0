import { requireAccount } from "@/lib/api";
import { dbError } from "@/lib/articles-db";
import {
  dbToImprovement,
  IMPROVEMENT_COLUMNS,
  improvementError,
  parseImprovement,
  parseImprovementUpdate,
  toDbImprovement,
  type ImprovementDbRow,
} from "@/lib/improvements";
import { fetchAll } from "@/lib/paging";
import { json, readJson, sharedLimited } from "@/lib/server";
import { canManageImprovements } from "@/lib/team";

export const dynamic = "force-dynamic";

const forbidden = "개선 큐는 소유자·관리자·편집자·검수자만 기록할 수 있습니다.";
function failed(error: { code?: string; message?: string }) {
  const e = improvementError(error) ?? dbError(error);
  return json({ error: e.message }, e.status);
}

export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { supabase, workspaceId, role } = account;
  try {
    const [rows, members] = await Promise.all([
      fetchAll<ImprovementDbRow>((from, to) =>
        supabase
          .from("improvement_tasks")
          .select(IMPROVEMENT_COLUMNS)
          .eq("workspace_id", workspaceId)
          .order("review_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      supabase.rpc("workspace_members", { ws: workspaceId }),
    ]);
    if (members.error) throw new Error("members");
    return json({
      tasks: rows.map(dbToImprovement),
      members: (members.data as { user_id: string; email: string }[]).map((m) => ({ id: m.user_id, email: m.email })),
      canManage: canManageImprovements(role),
    });
  } catch {
    return json({ error: "개선 큐를 불러오지 못했습니다." }, 500);
  }
}

/** Adds a task. Only records work to do: no article is changed and nothing is published. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageImprovements(account.role)) return json({ error: forbidden }, 403);
  let input;
  try {
    input = parseImprovement(await readJson(req, 8_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `improve:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("improvement_tasks")
    .insert(toDbImprovement(input, account.workspaceId, account.user.id))
    .select(IMPROVEMENT_COLUMNS)
    .single();
  if (error) return failed(error);
  return json({ task: dbToImprovement(data as ImprovementDbRow) });
}

/** Updates progress: state, result version and assignee. Evidence and target stay as recorded. */
export async function PATCH(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canManageImprovements(account.role)) return json({ error: forbidden }, 403);
  let input;
  try {
    input = parseImprovementUpdate(await readJson(req, 2_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  if (await sharedLimited(account.supabase, `improve:${account.user.id}`, 60, 60_000))
    return json({ error: "요청이 너무 잦습니다." }, 429);
  const { data, error } = await account.supabase
    .from("improvement_tasks")
    .update({ state: input.state, result_version: input.resultVersion, assignee_id: input.assigneeId })
    .eq("id", input.id)
    .eq("workspace_id", account.workspaceId)
    .select(IMPROVEMENT_COLUMNS)
    .maybeSingle();
  if (error) return failed(error);
  if (!data) return json({ error: "개선 작업을 찾을 수 없습니다." }, 404);
  return json({ task: dbToImprovement(data as ImprovementDbRow) });
}
