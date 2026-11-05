import { isUuid, ARTICLE_COLUMNS, rowToArticle, type ArticleRow } from "@/lib/articles-db";
import { isArticle } from "@/lib/content";
import { buildReviewMessages, parseReview } from "@/lib/review";
import { json, readJson, reviewConfig, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { canEdit, canDecide } from "@/lib/team";

export const dynamic = "force-dynamic";

/**
 * Second-opinion review. Advice only: nothing is saved and no state changes. In an account the
 * article is read from the database by id (the client can not submit text of its own choosing
 * to be reviewed under someone else's workspace).
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const config = reviewConfig();
  if (!config) return json({ error: "AI가 연결되지 않았습니다. OPENAI_API_KEY를 설정해주세요." }, 503);
  const account = await getAccount();
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (account.mode === "account" && !(canEdit(account.role) || canDecide(account.role)))
    return json({ error: "검수 권한이 없습니다." }, 403);
  if (
    await sharedLimited(
      account.mode === "account" ? account.supabase : null,
      account.mode === "account" ? `review:${account.user.id}` : "review:local",
      10,
      60_000,
    )
  )
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);

  let body: unknown;
  try {
    body = await readJson(req, 300_000);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  let article;
  if (account.mode === "account") {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
    const found = await account.supabase
      .from("articles")
      .select(ARTICLE_COLUMNS)
      .eq("id", id)
      .eq("workspace_id", account.workspaceId)
      .maybeSingle();
    if (found.error) return json({ error: "콘텐츠를 불러오지 못했습니다." }, 500);
    if (!found.data) return json({ error: "콘텐츠를 찾을 수 없습니다." }, 404);
    article = rowToArticle(found.data as ArticleRow);
  } else {
    if (!isArticle(body)) return json({ error: "콘텐츠 형식이 올바르지 않습니다." }, 400);
    article = body;
  }
  if (!article.body.trim()) return json({ error: "검수할 본문이 없습니다." }, 400);

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: buildReviewMessages(article), temperature: 0.2, max_tokens: 1500 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return json({ error: `AI 서비스 응답 오류(${res.status}). 키, 모델, 한도를 확인해주세요.` }, 502);
    const content = ((await res.json()) as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    return json({ findings: parseReview(content), model: config.model, sameModel: config.sameModel });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return json({ error: timeout ? "AI 응답 시간이 초과되었습니다." : e instanceof Error && /검수 응답/.test(e.message) ? e.message : "AI 검수를 하지 못했습니다." }, 502);
  }
}