import { requireAccount } from "@/lib/api";
import { isUuid } from "@/lib/articles-db";
import { workTimeMs, type ArticleHistory, type DeliveryAttempt, type StateEvent } from "@/lib/delivery";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

type EventRow = { from_state: StateEvent["fromState"]; to_state: StateEvent["toState"]; created_at: string };
type AttemptRow = {
  channel: DeliveryAttempt["channel"];
  attempt: number;
  failure_type: DeliveryAttempt["failureType"];
  url: string | null;
  duration_ms: number | null;
  created_at: string;
};

/** Read-only history of one article. Row level security limits it to the caller's workspaces. */
export async function GET(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  const { supabase, workspaceId } = account;

  const [events, attempts] = await Promise.all([
    // Oldest first: working time is measured from the first transition.
    supabase
      .from("article_state_events")
      .select("from_state,to_state,created_at")
      .eq("workspace_id", workspaceId)
      .eq("article_id", id)
      .order("created_at", { ascending: true })
      .limit(500),
    supabase
      .from("delivery_attempts")
      .select("channel,attempt,failure_type,url,duration_ms,created_at")
      .eq("workspace_id", workspaceId)
      .eq("article_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (events.error || attempts.error) return json({ error: "기록을 불러오지 못했습니다." }, 500);

  const stateEvents: StateEvent[] = (events.data as EventRow[]).map((r) => ({
    fromState: r.from_state,
    toState: r.to_state,
    createdAt: r.created_at,
  }));
  const history: ArticleHistory = {
    events: stateEvents,
    attempts: (attempts.data as AttemptRow[]).map((r) => ({
      channel: r.channel,
      attempt: r.attempt,
      failureType: r.failure_type,
      url: r.url,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    })),
    workTimeMs: workTimeMs(stateEvents),
  };
  return json(history);
}
