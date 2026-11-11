import { AI_PROVIDERS, AI_PROVIDER_LABEL, configuredProviders, defaultProvider, json, providerModels } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Which AI providers have a key on the server, with their default models. Never returns keys. */
export async function GET() {
  const viewer = await getAccount().catch(() => ({ mode: "anonymous" as const }));
  if (viewer.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  const ready = configuredProviders();
  return json({
    default: defaultProvider(),
    providers: AI_PROVIDERS.map((id) => {
      const m = providerModels(id);
      return { id, label: AI_PROVIDER_LABEL[id], configured: ready.includes(id), model: m.model, qaModel: m.qaModel };
    }),
  });
}
