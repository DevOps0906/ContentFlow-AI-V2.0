// Server-only helpers: environment config and request guards for the API routes.
// Secrets are read here and never sent to the browser.
import { createHash } from "node:crypto";
import type { WpConfig } from "./wordpress";

export type AiPrice = { inputPer1M: number; outputPer1M: number; currency: string };
export type AiConfig = { provider: AiProvider; apiKey: string; model: string; baseUrl: string; price: AiPrice | null };

/** Unit prices are optional. Anything missing or invalid means no price, so the cost reads N/A. */
function parsePrice(input: string | undefined, output: string | undefined, currency: string | undefined): AiPrice | null {
  const inputPer1M = input?.trim() ? Number(input) : NaN;
  const outputPer1M = output?.trim() ? Number(output) : NaN;
  const code = currency?.trim().toUpperCase() ?? "";
  if (!Number.isFinite(inputPer1M) || inputPer1M < 0) return null;
  if (!Number.isFinite(outputPer1M) || outputPer1M < 0) return null;
  return /^[A-Z]{3}$/.test(code) ? { inputPer1M, outputPer1M, currency: code } : null;
}

export type AiProvider = "gemini" | "openai";
export const AI_PROVIDERS: readonly AiProvider[] = ["gemini", "openai"];
export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { gemini: "Google Gemini", openai: "OpenAI" };
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export type AiSelection = { provider?: AiProvider; model?: string; qaModel?: string };

function providerKey(provider: AiProvider, env: NodeJS.ProcessEnv) {
  return (provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY)?.trim() || "";
}
/** Providers whose key is set on the server. The key itself never leaves this module's callers. */
export function configuredProviders(env = process.env): AiProvider[] {
  return AI_PROVIDERS.filter((p) => !!providerKey(p, env));
}
/** AI_PROVIDER when its key is set; otherwise Gemini, then OpenAI, whichever has a key. */
export function defaultProvider(env = process.env): AiProvider | null {
  const wanted = env.AI_PROVIDER?.trim().toLowerCase();
  const ready = configuredProviders(env);
  if (wanted && (AI_PROVIDERS as readonly string[]).includes(wanted) && ready.includes(wanted as AiProvider))
    return wanted as AiProvider;
  return ready[0] ?? null;
}
export function providerModels(provider: AiProvider, env = process.env): { model: string; qaModel: string | null } {
  if (provider === "gemini")
    return { model: env.GEMINI_MODEL?.trim() || "gemini-3.5-flash", qaModel: env.GEMINI_QA_MODEL?.trim() || null };
  return { model: env.OPENAI_MODEL?.trim() || "gpt-4o-mini", qaModel: env.QA_MODEL?.trim() || null };
}

export function aiConfig(env = process.env, sel?: AiSelection): AiConfig | null {
  const provider = sel?.provider ?? defaultProvider(env);
  if (!provider) return null;
  const apiKey = providerKey(provider, env);
  if (!apiKey) return null;
  const defaultModel = providerModels(provider, env).model;
  return {
    provider,
    apiKey,
    model: sel?.model || defaultModel,
    baseUrl:
      provider === "gemini"
        ? GEMINI_BASE_URL
        : (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    // The configured unit price belongs to the default model; a chosen other model reads N/A.
    price:
      sel?.model && sel.model !== defaultModel
        ? null
        : parsePrice(env.AI_PRICE_INPUT_PER_1M, env.AI_PRICE_OUTPUT_PER_1M, env.AI_PRICE_CURRENCY),
  };
}
/** Model used for the second opinion. Using the writer model would defeat the purpose, so a
 * separate QA model (QA_MODEL / GEMINI_QA_MODEL) is preferred; falling back to the same model
 * is reported to the user. */
export function reviewConfig(env = process.env, sel?: AiSelection): (AiConfig & { sameModel: boolean }) | null {
  const base = aiConfig(env, sel);
  if (!base) return null;
  const model = sel?.qaModel || providerModels(base.provider, env).qaModel || base.model;
  const sameModel = model === base.model;
  // A different model is never costed at the writer model's price.
  const qaPriced = !sel?.qaModel || sel.qaModel === providerModels(base.provider, env).qaModel;
  const price = sameModel ? base.price : !qaPriced ? null : parsePrice(env.QA_PRICE_INPUT_PER_1M, env.QA_PRICE_OUTPUT_PER_1M, env.AI_PRICE_CURRENCY);
  return { ...base, model, price, sameModel };
}
export function wpConfig(env = process.env): WpConfig | null {
  const baseUrl = env.WP_BASE_URL?.trim();
  const username = env.WP_USERNAME?.trim();
  const appPassword = env.WP_APP_PASSWORD?.trim();
  return baseUrl && username && appPassword ? { baseUrl, username, appPassword } : null;
}
export function supabaseUrl(env = process.env) {
  return env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
}

/** Rejects cross-site and non-browser POSTs: the app has no login yet. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const hits = new Map<string, number[]>();
/** Sliding-window limiter, per process. Protects API credits and the CMS from loops. */
export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};
/**
 * Rate limit shared by every instance (database function `rate_limit_hit`). The key is hashed so
 * no email address is stored. If the database can not answer, the per-process limiter is used:
 * it never fails open.
 */
export async function sharedLimited(
  client: RpcClient | null,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  if (client) {
    try {
      const { data, error } = await client.rpc("rate_limit_hit", {
        p_key: `${key.split(":")[0]}:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`,
        p_max: max,
        p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
      });
      if (!error && typeof data === "boolean") return data;
    } catch {
      // fall through to the local limiter
    }
  }
  return rateLimited(key, max, windowMs);
}
export function resetRateLimits() {
  hits.clear();
}

export async function readJson(req: Request, maxBytes = 200_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("요청이 너무 큽니다.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("요청 형식이 올바르지 않습니다.");
  }
}
export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
