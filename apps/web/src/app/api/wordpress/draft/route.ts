import { isArticle } from "@/lib/content";
import { sendDraft } from "@/lib/wordpress";
import { json, rateLimited, readJson, sameOrigin, wpConfig } from "@/lib/server";

export const dynamic = "force-dynamic";

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
  let article;
  try {
    const body = await readJson(req);
    if (!isArticle(body)) throw new Error("콘텐츠 형식이 올바르지 않습니다.");
    article = body;
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  try {
    const result = await sendDraft(config, article, article.remote?.postId);
    return json({ postId: result.postId, url: result.url, created: result.created });
  } catch (e) {
    // Messages come from our own checks or are trimmed WordPress errors; no credentials.
    return json({ error: e instanceof Error ? e.message : "WordPress 전송에 실패했습니다." }, 502);
  }
}
