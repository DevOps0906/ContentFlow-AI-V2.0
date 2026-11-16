// Publishing queue, server side (CF-24). Runs as the requesting user's session: the database
// functions decide who may enqueue, claim and cancel. No service role, no browser-to-database path.
import { ARTICLE_COLUMNS, rowToArticle, type ArticleRow } from "./articles-db";
import type { Article } from "./content";
import { assertDeliverable, DeliveryError, rpcDeliveryCheck, trackDelivery } from "./delivery";
import {
  decide,
  idOf,
  PUBLISH_COLUMNS,
  PUBLISH_RPC,
  PUBLISH_TABLE,
  remoteKey,
  rowToJob,
  type JobRow,
  type Outcome,
  type PublishJob,
} from "./publish-queue";
import type { Authed } from "./api";
import { sendDraft, type WpConfig } from "./wordpress";

type DbError = { code?: string; message?: string } | null;
export class QueueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const messages: Record<string, [string, number]> = {
  QUEUE_NOT_APPROVED: ["승인된 글만 발행 큐에 넣을 수 있습니다.", 409],
  QUEUE_DUPLICATE: ["이미 대기 중이거나 진행 중인 발행이 있습니다.", 409],
  QUEUE_FULL: ["대기열이 가득 찼습니다. 일부를 취소하거나 잠시 후 다시 시도해주세요.", 429],
  JOB_RUNNING: ["이미 진행 중이라 취소할 수 없습니다.", 409],
  JOB_NOT_CANCELLABLE: ["이 상태의 작업은 취소할 수 없습니다.", 409],
  JOB_NOT_RUNNING: ["이미 처리가 끝났거나 다른 곳에서 처리 중인 작업입니다.", 409],
};
/** Maps what a database function raised to a user message and status. The raw text stays in the server log. */
export function queueError(error: DbError, fallback: string): QueueError {
  const text = `${error?.message ?? ""}`;
  const code = Object.keys(messages).find((c) => text.includes(c));
  if (code) return new QueueError(messages[code][0], messages[code][1], code);
  if (error?.code === "42501" || /permission|forbidden|권한/i.test(text))
    return new QueueError("발행 큐는 편집 권한이 있는 멤버만 사용할 수 있습니다.", 403);
  if (error?.code === "PGRST202" || error?.code === "42883" || error?.code === "42P01")
    return new QueueError("발행 큐가 아직 준비되지 않았습니다. 마이그레이션을 확인해주세요.", 503);
  console.warn("publish queue db error", error?.code ?? "", text.slice(0, 200));
  return new QueueError(fallback, 500);
}

async function jobById(supabase: Authed["supabase"], id: string): Promise<PublishJob | null> {
  const { data, error } = await supabase.from(PUBLISH_TABLE).select(PUBLISH_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw queueError(error, "발행 작업을 불러오지 못했습니다.");
  return data ? rowToJob(data as unknown as JobRow) : null;
}

/** `workspaceId` is the job's, not the session's active one: a claim can come from any workspace the caller edits. */
async function loadArticle(account: Authed, id: string, workspaceId: string): Promise<Article | null> {
  const { data, error } = await account.supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", workspaceId)
    .maybeSingle();
  if (error) throw new QueueError("콘텐츠를 불러오지 못했습니다.", 500);
  return data ? rowToArticle(data as ArticleRow) : null;
}

/** Accepts an approved article. Nothing is sent here; a second request returns the existing job. */
export async function enqueue(account: Authed, config: WpConfig, articleId: string): Promise<PublishJob> {
  const { supabase } = account;
  const article = await loadArticle(account, articleId, account.workspaceId);
  if (!article) throw new QueueError("콘텐츠를 찾을 수 없습니다.", 404);
  if (article.status !== "export_ready" && article.status !== "publish_failed")
    throw new QueueError("내보내기 준비 또는 발행 실패 상태의 글만 큐에 넣을 수 있습니다.", 409, "QUEUE_NOT_APPROVED");
  try {
    await assertDeliverable(article, rpcDeliveryCheck(supabase));
  } catch (e) {
    const refused = e instanceof DeliveryError && e.failureType === "not_sendable";
    throw new QueueError(
      e instanceof Error ? e.message : "전달 가능 여부를 확인하지 못했습니다.",
      refused ? 409 : 500,
      refused ? "QUEUE_NOT_APPROVED" : undefined,
    );
  }
  let key: string;
  try {
    key = remoteKey(config.baseUrl);
  } catch {
    throw new QueueError("WordPress 주소를 확인해주세요.", 503);
  }
  const { data, error } = await supabase.rpc(PUBLISH_RPC.enqueue, { p_article_id: articleId, p_remote_key: key });
  if (error) throw queueError(error, "발행 큐에 추가하지 못했습니다.");
  const id = idOf(data);
  const job = id ? await jobById(supabase, id) : null;
  if (!job) throw new QueueError("발행 작업을 확인하지 못했습니다.", 500);
  return job;
}

export async function cancelJob(account: Authed, jobId: string): Promise<PublishJob> {
  const { error } = await account.supabase.rpc(PUBLISH_RPC.cancel, { p_job_id: jobId });
  if (error) throw queueError(error, "취소하지 못했습니다.");
  const job = await jobById(account.supabase, jobId);
  if (!job) throw new QueueError("발행 작업을 찾을 수 없습니다.", 404);
  return job;
}

export async function listJobs(account: Authed, limit = 100): Promise<PublishJob[]> {
  const { supabase, workspaceId } = account;
  const { data, error } = await supabase
    .from(PUBLISH_TABLE)
    .select(PUBLISH_COLUMNS)
    .eq("organization_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw queueError(error, "발행 큐를 불러오지 못했습니다.");
  const jobs = ((data ?? []) as unknown as JobRow[]).map(rowToJob);
  const ids = [...new Set(jobs.map((j) => j.articleId))];
  if (!ids.length) return jobs;
  const titles = await supabase.from("articles").select("id,title").eq("organization_id", workspaceId).in("id", ids);
  const byId = new Map(((titles.data ?? []) as { id: string; title: string }[]).map((a) => [a.id, a.title]));
  return jobs.map((j) => ({ ...j, title: byId.get(j.articleId) }));
}

async function finish(
  account: Authed,
  jobId: string,
  outcome: Outcome,
  retryAt: Date | null,
  error: string | null,
): Promise<void> {
  const { error: e } = await account.supabase.rpc(PUBLISH_RPC.finish, {
    p_job_id: jobId,
    p_outcome: outcome,
    p_retry_at: retryAt ? retryAt.toISOString() : null,
    p_error: error,
  });
  if (e) throw queueError(e, "발행 결과를 저장하지 못했습니다.");
}

export type DrainResult = { processed: 0 | 1; job?: PublishJob; article?: Article; created?: boolean };

/**
 * Takes at most one due job of this site and sends it. The database claim moves the article to
 * `publishing`; the result moves it on (`draft_created` / `publish_failed`). One job per request
 * keeps the worst case (one WordPress send) inside the route's time limit.
 * Only the failure type is stored as the reason: remote error text never leaves the server log.
 */
export async function drainOne(account: Authed, config: WpConfig): Promise<DrainResult> {
  const { supabase, user } = account;
  let key: string;
  try {
    key = remoteKey(config.baseUrl);
  } catch {
    throw new QueueError("WordPress 주소를 확인해주세요.", 503);
  }
  const claimed = await supabase.rpc(PUBLISH_RPC.claim, { p_remote_key: key });
  if (claimed.error) throw queueError(claimed.error, "발행 작업을 선점하지 못했습니다.");
  const id = idOf(claimed.data);
  if (!id) return { processed: 0 };
  const job = await jobById(supabase, id);
  if (!job) return { processed: 0 };

  const article = await loadArticle(account, job.articleId, job.workspaceId);
  if (!article) {
    await finish(account, job.id, "fail", null, "not_found");
    return { processed: 1, job: (await jobById(supabase, job.id)) ?? job };
  }
  const sending = { ...article, status: "publishing" as const };
  let created: boolean | undefined;
  try {
    const sent = await trackDelivery(
      { client: supabase, workspaceId: job.workspaceId, userId: user.id },
      article.id,
      async () => {
        await assertDeliverable(sending, rpcDeliveryCheck(supabase));
        return sendDraft(config, sending, article.remote?.postId);
      },
    );
    created = sent.created;
    const remote = { postId: sent.postId, url: sent.url, syncedAt: new Date().toISOString() };
    const saved = await supabase
      .from("articles")
      .update({ remote })
      .eq("id", article.id)
      .eq("organization_id", job.workspaceId)
      .select("id")
      .maybeSingle();
    // The draft exists remotely; a person must look if it could not be recorded.
    if (saved.error || !saved.data) await finish(account, job.id, "attention", null, "unknown");
    else await finish(account, job.id, "success", null, null);
  } catch (e) {
    if (e instanceof QueueError) throw e;
    const d = decide(e, job.attempts, job.maxAttempts);
    console.warn("publish job failed", job.id, d.failureType, e instanceof Error ? e.message.slice(0, 200) : "");
    await finish(account, job.id, d.outcome, d.retryAt, d.failureType);
  }
  return {
    processed: 1,
    job: (await jobById(supabase, job.id)) ?? job,
    article: (await loadArticle(account, article.id, job.workspaceId)) ?? undefined,
    created,
  };
}
