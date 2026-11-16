import { runModel } from "@/lib/agent-runs";
import { parseSelection, resolveDraft } from "@/lib/ai-models";
import {
  annotateTitles,
  buildTitleMessages,
  NAVER_TITLE_PROMPT_VERSION,
  parseTitles,
  validateTitleRequest,
} from "@/lib/naver-research";
import { json, readJson } from "@/lib/server";
import { naverGuard } from "../guard";

export const dynamic = "force-dynamic";

/** R2: 5 AI title candidates with the §10 title checks. No blog search data reaches the AI (§11.2). Nothing is stored. */
export async function POST(req: Request) {
  const guard = await naverGuard(req);
  if (!guard.ok) return guard.res;
  let request;
  let selection;
  try {
    const body = await readJson(req, 20_000);
    request = validateTitleRequest(body);
    selection = parseSelection((body as { ai?: unknown }).ai);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  const resolved = await resolveDraft(selection);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status);
  const config = resolved.config;
  // agent_runs.task has no naver value; the prompt version tells these runs apart (§11.1).
  const result = await runModel({
    config,
    task: "draft",
    promptVersion: NAVER_TITLE_PROMPT_VERSION,
    messages: buildTitleMessages(request),
    temperature: 0.8,
    maxTokens: 800,
    parse: parseTitles,
    log: guard.log,
    // Tighter than the draft defaults: a short JSON answer is expected (§11.1).
    timeoutMs: 30_000,
    maxBytes: 256 * 1024,
  });
  if (result.ok)
    return json({ titles: annotateTitles(result.value, request), model: config.model, provider: config.provider, run: result.run });
  if (result.reason === "http")
    return json({ error: `AI 서비스 응답 오류(${result.httpStatus}). 키, 모델, 한도를 확인해주세요.` }, 502);
  return json(
    { error: result.reason === "timeout" ? "AI 응답 시간이 초과되었습니다." : "AI 제목 응답 형식이 올바르지 않습니다. 다시 시도해주세요." },
    502,
  );
}
