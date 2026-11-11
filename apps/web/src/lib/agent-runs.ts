// AI call log (P0-05): one record per finished call, kept as an operating reference only.
// Account mode inserts it into `agent_runs`; local mode only returns it. Prompts and answers are
// never logged. Safe to import from client components: the server module is imported as a type.
import type { AiConfig, AiPrice } from "./server";

export type RunTask = "draft" | "review";
export type RunStatus = "succeeded" | "failed" | "timeout";
export type RunInfo = {
  status: RunStatus;
  model: string;
  promptVersion: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  costEstimate: number | null;
  costCurrency: string | null;
};

type InsertClient = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
  };
};
/** Where the run is stored; null in local mode. */
export type RunLog = { client: InsertClient; workspaceId: string; userId: string } | null;

type RunFailure =
  | { ok: false; reason: "http"; httpStatus: number }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: unknown };

const MAX_INT_COLUMN = 2_147_483_647;
const tokenCount = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT_COLUMN ? v : null;

/** Missing or malformed usage stays null: "unknown" must never read as 0 tokens. */
export function parseUsage(json: unknown): { tokensIn: number | null; tokensOut: number | null } {
  const usage = (json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  return { tokensIn: tokenCount(usage?.prompt_tokens), tokensOut: tokenCount(usage?.completion_tokens) };
}

export function estimateCost(
  tokensIn: number | null,
  tokensOut: number | null,
  price: AiPrice | null,
): { costEstimate: number | null; costCurrency: string | null } {
  if (tokensIn === null || tokensOut === null || !price) return { costEstimate: null, costCurrency: null };
  const cost = (tokensIn * price.inputPer1M + tokensOut * price.outputPer1M) / 1_000_000;
  return { costEstimate: Number(cost.toFixed(8)), costCurrency: price.currency };
}

/** A failure to store the log never fails the AI response: it only leaves a server warning. */
async function saveRun(log: RunLog, task: RunTask, run: RunInfo) {
  if (!log) return;
  try {
    const { error } = await log.client.from("agent_runs").insert({
      workspace_id: log.workspaceId,
      created_by: log.userId,
      task,
      model: run.model,
      prompt_version: run.promptVersion,
      status: run.status,
      tokens_in: run.tokensIn,
      tokens_out: run.tokensOut,
      duration_ms: run.durationMs,
      cost_estimate: run.costEstimate,
      cost_currency: run.costCurrency,
    });
    if (error) console.warn("agent_runs insert failed", error.code ?? "", error.message ?? "");
  } catch (e) {
    console.warn("agent_runs insert failed", e instanceof Error ? e.message : "");
  }
}

/** Calls the chat completion endpoint and records the outcome exactly once, whatever it was. */
export async function runModel<T>(opts: {
  config: AiConfig;
  task: RunTask;
  promptVersion: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  maxTokens: number;
  parse: (json: unknown) => T;
  log: RunLog;
}): Promise<{ ok: true; value: T; run: RunInfo } | RunFailure> {
  const { config } = opts;
  const started = Date.now();
  let usage: ReturnType<typeof parseUsage> = { tokensIn: null, tokensOut: null };
  let result: { ok: true; value: T } | RunFailure;
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: opts.messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      result = { ok: false, reason: "http", httpStatus: res.status };
    } else {
      const data: unknown = await res.json();
      // Read before parsing: an unusable answer still spent these tokens.
      usage = parseUsage(data);
      result = { ok: true, value: opts.parse(data) };
    }
  } catch (e) {
    result =
      e instanceof Error && e.name === "TimeoutError"
        ? { ok: false, reason: "timeout" }
        : { ok: false, reason: "error", error: e };
  }
  const run: RunInfo = {
    status: result.ok ? "succeeded" : result.reason === "timeout" ? "timeout" : "failed",
    model: config.model,
    promptVersion: opts.promptVersion,
    ...usage,
    durationMs: Date.now() - started,
    ...estimateCost(usage.tokensIn, usage.tokensOut, config.price),
  };
  await saveRun(opts.log, opts.task, run);
  return result.ok ? { ...result, run } : result;
}

/** One-line display. Unknown values read N/A, and the figures are labelled as a reference. */
export function runSummary(run: RunInfo): string {
  const tokens = (n: number | null) => (n === null ? "N/A" : n.toLocaleString("en-US"));
  const cost =
    run.costEstimate === null
      ? "N/A"
      : `${run.costEstimate.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${run.costCurrency}`;
  return `프롬프트 ${run.promptVersion} · 토큰 입력 ${tokens(run.tokensIn)} / 출력 ${tokens(run.tokensOut)} · ${(run.durationMs / 1000).toFixed(1)}초 · 예상 비용 ${cost} (참고값)`;
}
