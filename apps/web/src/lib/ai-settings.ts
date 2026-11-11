// Browser-side AI choice (provider and models). It holds ids only, never keys. Storage can be
// blocked or full, so every access is guarded: a failure just means "use the server defaults".
export type AiChoice = { provider?: "gemini" | "openai"; model?: string; qaModel?: string };
export const AI_CHOICE_KEY = "contentflow.ai.choice.v1";

export function parseChoice(raw: string | null): AiChoice {
  try {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!v || typeof v !== "object") return {};
    const s = (x: unknown) => (typeof x === "string" && x && x.length <= 100 ? x : undefined);
    return {
      provider: v.provider === "gemini" || v.provider === "openai" ? v.provider : undefined,
      model: s(v.model),
      qaModel: s(v.qaModel),
    };
  } catch {
    return {};
  }
}
export function loadChoice(): AiChoice {
  try {
    return parseChoice(localStorage.getItem(AI_CHOICE_KEY));
  } catch {
    return {};
  }
}
/** Returns false when the browser refused to store it. */
export function saveChoice(choice: AiChoice): boolean {
  try {
    localStorage.setItem(AI_CHOICE_KEY, JSON.stringify(choice));
    return true;
  } catch {
    return false;
  }
}
