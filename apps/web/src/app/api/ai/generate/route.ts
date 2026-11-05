import { buildMessages, parseCompletion, validateAiRequest } from "@/lib/ai";
import { aiConfig, json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const config = aiConfig();
  if (!config)
    return json({ error: "AI가 연결되지 않았습니다. OPENAI_API_KEY를 설정해주세요." }, 503);
  // The proxy already turns anonymous visitors away; the route checks again and spends API
  // credits only for people who may edit.
  const account = await getAccount();
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (account.mode === "account" && !canEdit(account.role))
    return json({ error: "AI 초안은 편집 권한이 있는 멤버만 만들 수 있습니다." }, 403);
  const limitKey = account.mode === "account" ? `ai:${account.user.id}` : "ai:local";
  if (await sharedLimited(account.mode === "account" ? account.supabase : null, limitKey, 10, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let request;
  try {
    request = validateAiRequest(await readJson(req, 20_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(request),
        temperature: 0.6,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok)
      return json({ error: `AI 서비스 응답 오류(${res.status}). 키, 모델, 한도를 확인해주세요.` }, 502);
    const body = parseCompletion(await res.json());
    // The draft is returned for the operator to edit; nothing is saved or approved here.
    return json({ body, model: config.model });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return json(
      { error: timeout ? "AI 응답 시간이 초과되었습니다." : "AI 초안을 만들지 못했습니다." },
      502,
    );
  }
}
