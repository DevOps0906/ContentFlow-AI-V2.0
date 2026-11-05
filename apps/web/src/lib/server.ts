// Server-only helpers: environment config and request guards for the API routes.
// Secrets are read here and never sent to the browser.
import { createHash } from "node:crypto";
import type { WpConfig } from "./wordpress";

export type AiConfig = { apiKey: string; model: string; baseUrl: string };

export function aiConfig(env = process.env): AiConfig | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    baseUrl: (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
  };
}
/** Model used for the second opinion. Using the writer model would defeat the purpose, so a
 * separate QA_MODEL is preferred; falling back to the same model is reported to the user. */
export function reviewConfig(env = process.env): (AiConfig & { sameModel: boolean }) | null {
  const base = aiConfig(env);
  if (!base) return null;
  const model = env.QA_MODEL?.trim() || base.model;
  return { ...base, model, sameModel: model === base.model };
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
