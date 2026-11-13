import { isUuid } from "@/lib/articles-db";
import { isArticle } from "@/lib/content";
import { assertDeliverable } from "@/lib/delivery";
import { reasonOf } from "@/lib/publish-queue";
import { drainOne, enqueue, QueueError } from "@/lib/publish-queue-server";
import { sendDraft, type WpConfig } from "@/lib/wordpress";
import { json, readJson, sameOrigin, sharedLimited, wpConfig } from "@/lib/server";
import { canEdit } from "@/lib/team";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Authed = Extract<Awaited<ReturnType<typeof getAccount>>, { mode: "account" }>;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const config = wpConfig();
  if (!config)
    return json(
      { error: "WordPress가 연결되지 않았습니다. WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD를 설정해주세요." },
      503,
    );
  const account = await getAccount();
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (account.mode === "account" && !canEdit(account.role))
    return json({ error: "WordPress 전송은 편집 권한이 있는 멤버만 할 수 있습니다." }, 403);
  const limitKey = account.mode === "account" ? `wp:${account.user.id}` : "wp:local";
  if (await sharedLimited(account.mode === "account" ? account.supabase : null, limitKey, 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  return account.mode === "account"
    ? accountFlow(account, config, body)
    : localFlow(config, body);
}

/** Local (no database) mode: the browser owns the state and sends the whole article. */
async function localFlow(config: WpConfig, body: unknown) {
  if (!isArticle(body)) return json({ error: "콘텐츠 형식이 올바르지 않습니다." }, 400);
  try {
    await assertDeliverable(body);
    const r = await sendDraft(config, body, body.remote?.postId);
    return json({ postId: r.postId, url: r.url, created: r.created });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "WordPress 전송에 실패했습니다." }, 502);
  }
}

/**
 * Account mode (compatibility path): the article is queued, then this request tries that one job
 * right away. It answers like the old synchronous send when the job finishes here (200 / 502) and
 * with 202 + the job when it has to wait (site busy, retry scheduled).
 */
async function accountFlow(account: Authed, config: WpConfig, body: unknown) {
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  let job;
  try {
    job = await enqueue(account, config, id);
  } catch (e) {
    return e instanceof QueueError ? json({ error: e.message }, e.status) : json({ error: "WordPress 전송에 실패했습니다." }, 500);
  }
  try {
    const r = await drainOne(account, config);
    if (r.job?.id !== job.id || !r.article) return json({ job: r.job?.id === job.id ? r.job : job }, 202);
    if (r.job.status === "succeeded") return json({ article: r.article, created: r.created ?? false });
    if (r.job.status === "queued") return json({ job: r.job }, 202);
    return json({ error: reasonOf(r.job) || "WordPress 전송에 실패했습니다.", article: r.article }, 502);
  } catch (e) {
    // A server error after the claim leaves the job running until the stale reclaim (up to 5 minutes).
    return e instanceof QueueError && e.status < 500
      ? json({ error: e.message }, e.status)
      : json({ error: "발행 처리 중 오류가 발생했어요. 최대 5분 뒤 발행 큐에서 다시 시도합니다." }, 502);
  }
}
