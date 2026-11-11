// Server-only: model lists per provider and request-time selection of provider and models.
// A selection is accepted only for a provider whose key is set and for models that the provider
// itself lists, so the browser can not make the server call arbitrary models.
import { createHash } from "node:crypto";
import {
  AI_PROVIDERS,
  aiConfig,
  configuredProviders,
  reviewConfig,
  type AiConfig,
  type AiProvider,
  type AiSelection,
} from "./server";

const TTL_MS = 10 * 60_000;
const NOT_TEXT = /tts|image|imagen|embed|veo|dall-e|whisper|moderation|transcribe|realtime|audio|live/i;
const cache = new Map<string, { at: number; models: string[] }>();

/** Provider ids come back as "models/<id>" from Gemini; the chat endpoint wants the bare id. */
export function parseModelList(json: unknown): string[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("모델 목록 형식이 올바르지 않습니다.");
  const ids = data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.replace(/^models\//, ""))
    .filter((id) => !NOT_TEXT.test(id));
  return [...new Set(ids)].sort();
}

/** The provider's text models, cached for 10 minutes. Throws when the provider can not answer. */
export async function listModels(
  config: AiConfig,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string[]> {
  // The key is hashed into the cache key so a changed key is never served another key's list.
  const key = `${config.provider}|${config.baseUrl}|${createHash("sha256").update(config.apiKey).digest("hex").slice(0, 16)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.models;
  const res = await fetchImpl(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`모델 목록 응답 오류(${res.status})`);
  const models = parseModelList(await res.json());
  cache.set(key, { at: now, models });
  return models;
}
export function resetModelCache() {
  cache.clear();
}

/** AI_ALLOWED_MODELS (comma list, optional): when set, only these models may be chosen. */
export function allowedModels(models: string[], env = process.env): string[] {
  const allow = (env.AI_ALLOWED_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return allow.length ? models.filter((m) => allow.includes(m)) : models;
}

/** Reads the optional `ai` field of a request body. Wrong types are a client error. */
export function parseSelection(input: unknown): AiSelection {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object") throw new Error("AI 설정 형식이 올바르지 않습니다.");
  const r = input as Record<string, unknown>;
  const str = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || v.length > 100) throw new Error(`${name} 형식이 올바르지 않습니다.`);
    return v.trim() || undefined;
  };
  const provider = str(r.provider, "AI 제공자");
  if (provider && !(AI_PROVIDERS as readonly string[]).includes(provider))
    throw new Error("지원하지 않는 AI 제공자입니다.");
  return { provider: provider as AiProvider | undefined, model: str(r.model, "모델"), qaModel: str(r.qaModel, "검수 모델") };
}

type Resolved<C> = { ok: true; config: C } | { ok: false; status: number; error: string };
const NOT_CONNECTED = "AI가 연결되지 않았습니다. GEMINI_API_KEY 또는 OPENAI_API_KEY를 설정해주세요.";

async function checked(
  base: AiConfig,
  wanted: (string | undefined)[],
  fetchImpl: typeof fetch,
  env = process.env,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const chosen = wanted.filter((m): m is string => !!m);
  if (!chosen.length) return { ok: true };
  let models: string[];
  try {
    models = allowedModels(await listModels(base, fetchImpl), env);
  } catch {
    return { ok: false, status: 502, error: "모델 목록을 확인하지 못했습니다. 키와 연결을 확인해주세요." };
  }
  const bad = chosen.find((m) => !models.includes(m));
  return bad ? { ok: false, status: 400, error: "사용할 수 없는 모델입니다. 설정의 AI API에서 다시 선택해주세요." } : { ok: true };
}

/** Provider and model for a draft. Unselected values fall back to the server defaults. */
export async function resolveDraft(
  sel: AiSelection,
  env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Resolved<AiConfig>> {
  if (!configuredProviders(env).length) return { ok: false, status: 503, error: NOT_CONNECTED };
  if (sel.provider && !configuredProviders(env).includes(sel.provider))
    return { ok: false, status: 400, error: "선택한 AI 제공자의 키가 설정되지 않았습니다." };
  const config = aiConfig(env, sel);
  if (!config) return { ok: false, status: 503, error: NOT_CONNECTED };
  const ok = await checked(config, [sel.model], fetchImpl, env);
  return ok.ok ? { ok: true, config } : ok;
}

export async function resolveReview(
  sel: AiSelection,
  env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Resolved<NonNullable<ReturnType<typeof reviewConfig>>>> {
  if (!configuredProviders(env).length) return { ok: false, status: 503, error: NOT_CONNECTED };
  if (sel.provider && !configuredProviders(env).includes(sel.provider))
    return { ok: false, status: 400, error: "선택한 AI 제공자의 키가 설정되지 않았습니다." };
  const config = reviewConfig(env, sel);
  if (!config) return { ok: false, status: 503, error: NOT_CONNECTED };
  const ok = await checked(config, [sel.model, sel.qaModel], fetchImpl, env);
  return ok.ok ? { ok: true, config } : ok;
}
