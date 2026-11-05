import { aiConfig, json, supabaseUrl, wpConfig } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Which integrations are configured. Never returns keys, passwords or full URLs. */
export async function GET() {
  const ai = aiConfig();
  const wp = wpConfig();
  const sb = supabaseUrl();
  let supabase: "not_configured" | "reachable" | "unreachable" = "not_configured";
  if (sb) {
    try {
      const res = await fetch(`${sb}/auth/v1/health`, {
        signal: AbortSignal.timeout(3000),
        headers: process.env.SUPABASE_PUBLISHABLE_KEY
          ? { apikey: process.env.SUPABASE_PUBLISHABLE_KEY }
          : {},
      });
      supabase = res.ok ? "reachable" : "unreachable";
    } catch {
      supabase = "unreachable";
    }
  }
  return json({
    ai: { configured: !!ai, model: ai?.model ?? null },
    wordpress: { configured: !!wp, host: wp ? new URL(wp.baseUrl).host : null },
    supabase: { status: supabase },
  });
}
