import { ARTICLE_COLUMNS, isUuid, rowToArticle, type ArticleRow } from "@/lib/articles-db";
import { isArticle } from "@/lib/content";
import { sendDraft, type WpConfig } from "@/lib/wordpress";
import { json, rateLimited, readJson, sameOrigin, wpConfig } from "@/lib/server";
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
  if (rateLimited("wp", 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  const account = await getAccount();
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
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
    const r = await sendDraft(config, body, body.remote?.postId);
    return json({ postId: r.postId, url: r.url, created: r.created });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "WordPress 전송에 실패했습니다." }, 502);
  }
}

/**
 * Account mode: only the article id is accepted. State and content come from the database,
 * so a client can not send an unapproved or edited copy. `publishing` is claimed with a
 * conditional update, which also stops two simultaneous sends from creating two drafts.
 */
async function accountFlow(account: Authed, config: WpConfig, body: unknown) {
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  const { supabase, workspaceId } = account;

  const found = await supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (found.error) return json({ error: "콘텐츠를 불러오지 못했습니다." }, 500);
  if (!found.data) return json({ error: "콘텐츠를 찾을 수 없습니다." }, 404);
  const current = rowToArticle(found.data as ArticleRow);
  if (current.status !== "export_ready" && current.status !== "publish_failed")
    return json({ error: "내보내기 준비 또는 발행 실패 상태의 글만 전송할 수 있습니다." }, 409);

  const claim = await supabase
    .from("articles")
    .update({ state: "publishing" })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .eq("state", current.status)
    .select(ARTICLE_COLUMNS)
    .maybeSingle();
  if (claim.error) return json({ error: "상태를 바꾸지 못했습니다." }, 409);
  if (!claim.data) return json({ error: "이미 전송 중이거나 상태가 바뀌었습니다." }, 409);

  try {
    const sent = await sendDraft(
      config,
      { ...current, status: "publishing" },
      current.remote?.postId,
    );
    const done = await supabase
      .from("articles")
      .update({
        state: "draft_created",
        remote: { postId: sent.postId, url: sent.url, syncedAt: new Date().toISOString() },
      })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select(ARTICLE_COLUMNS)
      .maybeSingle();
    if (done.error || !done.data)
      return json(
        { error: `WordPress에는 초안이 생성됐지만(글 ${sent.postId}) 상태 저장에 실패했습니다. 직접 확인해주세요.` },
        500,
      );
    return json({ article: rowToArticle(done.data as ArticleRow), created: sent.created });
  } catch (e) {
    const failed = await supabase
      .from("articles")
      .update({ state: "publish_failed" })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select(ARTICLE_COLUMNS)
      .maybeSingle();
    return json(
      {
        error: e instanceof Error ? e.message : "WordPress 전송에 실패했습니다.",
        article: failed.data ? rowToArticle(failed.data as ArticleRow) : undefined,
      },
      502,
    );
  }
}
