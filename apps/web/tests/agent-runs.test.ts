import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, parseUsage, runModel, runSummary, type RunLog } from "../src/lib/agent-runs";
import { aiConfig, reviewConfig, type AiConfig } from "../src/lib/server";

const price = { inputPer1M: 1, outputPer1M: 2, currency: "USD" };
const config: AiConfig = { provider: "openai" as const, apiKey: "secret-key", model: "m", baseUrl: "https://ai.example/v1", price };
const answer = (extra: object = {}) => ({ choices: [{ message: { content: "ok" } }], ...extra });
const usage = { usage: { prompt_tokens: 1000, completion_tokens: 500 } };

type Row = Record<string, unknown>;
function storage(fail?: "error" | "throw") {
  const rows: Row[] = [];
  const log: RunLog = {
    workspaceId: "ws",
    userId: "u",
    client: {
      from: (table) => {
        assert.equal(table, "agent_runs");
        return {
          insert: async (row) => {
            if (fail === "throw") throw new Error("network down");
            rows.push(row);
            return { error: fail === "error" ? { code: "42P01", message: "missing table" } : null };
          },
        };
      },
    },
  };
  return { rows, log };
}
const respond = (body: unknown, status = 200) =>
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
const parse = (data: unknown) => {
  const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) throw new Error("empty");
  return content;
};
const call = (log: RunLog, cfg = config) =>
  runModel({
    config: cfg,
    task: "draft",
    promptVersion: "draft-v1",
    messages: [{ role: "user", content: "민감한 프롬프트" }],
    temperature: 0,
    maxTokens: 10,
    parse,
    log,
  });

afterEach(() => mock.restoreAll());

test("a successful call records one row with usage, cost and no prompt or key", async () => {
  respond(answer(usage));
  const { rows, log } = storage();
  const result = await call(log);
  assert.equal(result.ok && result.value, "ok");
  assert.equal(rows.length, 1);
  const { duration_ms, ...rest } = rows[0];
  assert.equal(typeof duration_ms, "number");
  assert.deepEqual(rest, {
    workspace_id: "ws",
    created_by: "u",
    task: "draft",
    model: "m",
    prompt_version: "draft-v1",
    status: "succeeded",
    tokens_in: 1000,
    tokens_out: 500,
    cost_estimate: 0.002,
    cost_currency: "USD",
  });
  assert.ok(!JSON.stringify(rows[0]).includes("민감한") && !JSON.stringify(rows[0]).includes("secret-key"));
});

test("without usage the tokens and cost are NULL, never 0", async () => {
  respond(answer());
  const { rows, log } = storage();
  const result = await call(log);
  assert.ok(result.ok);
  assert.equal(rows[0].tokens_in, null);
  assert.equal(rows[0].tokens_out, null);
  assert.equal(rows[0].cost_estimate, null);
  assert.equal(rows[0].cost_currency, null);
});

test("malformed or partial usage stays unknown and yields no cost", () => {
  for (const bad of [null, undefined, "x", {}, { usage: null }, { usage: "x" }, { usage: { prompt_tokens: "1", completion_tokens: -1 } }, { usage: { prompt_tokens: 1.5 } }, { usage: { prompt_tokens: 3_000_000_000 } }])
    assert.deepEqual(parseUsage(bad), { tokensIn: null, tokensOut: null }, JSON.stringify(bad));
  const partial = parseUsage({ usage: { prompt_tokens: 7 } });
  assert.deepEqual(partial, { tokensIn: 7, tokensOut: null });
  assert.deepEqual(estimateCost(partial.tokensIn, partial.tokensOut, price), { costEstimate: null, costCurrency: null });
});

test("without a price the tokens are kept and the cost is NULL", async () => {
  respond(answer(usage));
  const { rows, log } = storage();
  await call(log, { ...config, price: null });
  assert.equal(rows[0].tokens_in, 1000);
  assert.equal(rows[0].cost_estimate, null);
  assert.equal(rows[0].cost_currency, null);
});

test("an HTTP error is recorded as failed", async () => {
  respond({ error: "nope" }, 429);
  const { rows, log } = storage();
  const result = await call(log);
  assert.deepEqual(result, { ok: false, reason: "http", httpStatus: 429 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].tokens_in, null);
});

test("a timeout is recorded as timeout", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new DOMException("too slow", "TimeoutError");
  });
  const { rows, log } = storage();
  const result = await call(log);
  assert.deepEqual(result, { ok: false, reason: "timeout" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "timeout");
});

test("a network error is recorded as failed", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  const { rows, log } = storage();
  const result = await call(log);
  assert.ok(!result.ok && result.reason === "error");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
});

test("an unusable answer is failed but keeps the tokens it spent", async () => {
  respond({ choices: [{ message: { content: "" } }], ...usage });
  const { rows, log } = storage();
  const result = await call(log);
  assert.ok(!result.ok && result.reason === "error");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].tokens_in, 1000);
  assert.equal(rows[0].cost_estimate, 0.002);
});

test("a failure to store the log does not fail the response and leaves a warning", async () => {
  for (const mode of ["error", "throw"] as const) {
    respond(answer(usage));
    const warn = mock.method(console, "warn", () => {});
    const result = await call(storage(mode).log);
    assert.ok(result.ok, mode);
    assert.equal(warn.mock.callCount(), 1, mode);
    mock.restoreAll();
  }
});

test("local mode returns the run without storing anything", async () => {
  respond(answer(usage));
  const result = await call(null);
  assert.ok(result.ok);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.tokensIn, 1000);
  assert.equal(result.run.costCurrency, "USD");
});

test("unit prices come from the environment and invalid ones mean no price", () => {
  const env = (o: Record<string, string>) => ({ OPENAI_API_KEY: "k", OPENAI_MODEL: "a", ...o }) as unknown as NodeJS.ProcessEnv;
  const priced = { AI_PRICE_INPUT_PER_1M: "0.5", AI_PRICE_OUTPUT_PER_1M: "1.5", AI_PRICE_CURRENCY: "usd" };
  assert.deepEqual(aiConfig(env(priced))?.price, { inputPer1M: 0.5, outputPer1M: 1.5, currency: "USD" });
  assert.equal(aiConfig(env({}))?.price, null);
  assert.equal(aiConfig(env({ ...priced, AI_PRICE_CURRENCY: "" }))?.price, null);
  assert.equal(aiConfig(env({ ...priced, AI_PRICE_CURRENCY: "dollar" }))?.price, null);
  assert.equal(aiConfig(env({ ...priced, AI_PRICE_INPUT_PER_1M: "" }))?.price, null);
  assert.equal(aiConfig(env({ ...priced, AI_PRICE_OUTPUT_PER_1M: "-1" }))?.price, null);
  assert.equal(aiConfig(env({ ...priced, AI_PRICE_OUTPUT_PER_1M: "abc" }))?.price, null);
  // The review shares the writer's price only when it really is the same model.
  assert.equal(reviewConfig(env(priced))?.price?.inputPer1M, 0.5);
  assert.equal(reviewConfig(env({ ...priced, QA_MODEL: "b" }))?.price, null);
  const qa = { ...priced, QA_MODEL: "b", QA_PRICE_INPUT_PER_1M: "3", QA_PRICE_OUTPUT_PER_1M: "4" };
  assert.deepEqual(reviewConfig(env(qa))?.price, { inputPer1M: 3, outputPer1M: 4, currency: "USD" });
});

test("the summary shows N/A for unknown values and labels figures as a reference", () => {
  const run = { status: "succeeded" as const, model: "m", promptVersion: "draft-v1", durationMs: 1500 };
  const unknown = runSummary({ ...run, tokensIn: null, tokensOut: null, costEstimate: null, costCurrency: null });
  assert.ok(unknown.includes("입력 N/A / 출력 N/A") && unknown.includes("예상 비용 N/A"));
  assert.ok(unknown.includes("1.5초") && unknown.includes("참고값"));
  const known = runSummary({ ...run, tokensIn: 1000, tokensOut: 5, costEstimate: 0.0000015, costCurrency: "USD" });
  assert.ok(known.includes("입력 1,000 / 출력 5") && known.includes("0.0000015 USD"));
});
