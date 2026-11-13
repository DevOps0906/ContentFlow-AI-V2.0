import { requireAccount } from "@/lib/api";
import { isUuid } from "@/lib/articles-db";
import { POLL_MS } from "@/lib/publish-queue";
import { enqueue, listJobs, QueueError } from "@/lib/publish-queue-server";
import { json, readJson, sharedLimited, wpConfig } from "@/lib/server";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";

const fail = (e: unknown) =>
  e instanceof QueueError
    ? json({ error: e.message, code: e.code }, e.status)
    : json({ error: "발행 큐 요청을 처리하지 못했습니다." }, 500);

/** Read only: no job is started or changed by looking. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  try {
    return json({ jobs: await listJobs(account), nextPollMs: POLL_MS, canEdit: canEdit(account.role) });
  } catch (e) {
    return fail(e);
  }
}

/** Accepts one article: 202 with the job, nothing is sent here. */
export async function POST(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "발행 큐는 편집 권한이 있는 멤버만 사용할 수 있습니다." }, 403);
  const config = wpConfig();
  if (!config)
    return json(
      { error: "WordPress가 연결되지 않았습니다. WP_BASE_URL, WP_USERNAME, WP_APP_PASSWORD를 설정해주세요." },
      503,
    );
  if (await sharedLimited(account.supabase, `wp:${account.user.id}`, 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const id = (body as { articleId?: unknown } | null)?.articleId;
  if (typeof id !== "string" || !isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  try {
    return json({ job: await enqueue(account, config, id) }, 202);
  } catch (e) {
    return fail(e);
  }
}
