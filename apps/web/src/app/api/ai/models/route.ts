import { allowedModels, listModels, parseSelection } from "@/lib/ai-models";
import { aiConfig, json, readJson, sameOrigin, sharedLimited } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Text models the chosen provider offers. Only a provider whose key is set is queried. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount().catch(() => ({ mode: "anonymous" as const }));
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  if (account.mode === "account" && !canEdit(account.role)) return json({ error: "편집 권한이 있는 멤버만 사용할 수 있습니다." }, 403);
  if (await sharedLimited(account.mode === "account" ? account.supabase : null, `ai-models:${account.mode === "account" ? account.user.id : "local"}`, 20, 60_000))
    return json({ error: "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요." }, 429);
  let provider;
  try {
    provider = parseSelection(await readJson(req, 2_000)).provider;
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const config = aiConfig(process.env, { provider });
  if (!config) return json({ error: "선택한 AI 제공자의 키가 설정되지 않았습니다." }, 400);
  try {
    return json({ provider: config.provider, models: allowedModels(await listModels(config)) });
  } catch {
    return json({ error: "모델 목록을 가져오지 못했습니다. 키와 연결을 확인해주세요." }, 502);
  }
}
