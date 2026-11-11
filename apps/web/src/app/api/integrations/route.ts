import { aiConfig, json, supabaseUrl, wpConfig } from "@/lib/server";
import { getAccount } from "@/lib/supabase";
import { SUPABASE_TARGET_LABEL, supabaseConfigIssues, supabaseTarget } from "@/lib/supabase-target";

export const dynamic = "force-dynamic";

/** Which integrations are configured. Never returns keys, passwords or full URLs. */
export async function GET() {
  const ai = aiConfig();
  const wp = wpConfig();
  const sb = supabaseUrl();
  const target = supabaseTarget();
  // Target and config issues are only shown to a logged-in user, or in local mode (no Supabase).
  const viewer = await getAccount().catch(() => ({ mode: "anonymous" as const }));
  const detail = viewer.mode !== "anonymous";
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
    ai: { configured: !!ai, model: ai?.model ?? null, provider: ai?.provider ?? null },
    wordpress: { configured: !!wp, host: wp ? new URL(wp.baseUrl).host : null },
    supabase: {
      status: supabase,
      ...(detail
        ? { target, label: SUPABASE_TARGET_LABEL[target], issues: supabaseConfigIssues() }
        : {}),
    },
  });
}
