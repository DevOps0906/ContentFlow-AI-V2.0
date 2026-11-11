import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedModels, listModels, parseModelList, parseSelection, resetModelCache, resolveDraft, resolveReview } from "../src/lib/ai-models";
import { aiConfig, defaultProvider, GEMINI_BASE_URL, reviewConfig } from "../src/lib/server";
import { parseChoice } from "../src/lib/ai-settings";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const SECRET = "sekret-key-123456";
const listFetch = (ids: string[], calls: string[] = []) =>
  (async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json({ data: ids.map((id) => ({ id })) });
  }) as unknown as typeof fetch;

test("provider defaults: Gemini when its key exists, AI_PROVIDER wins only if configured", () => {
  assert.equal(defaultProvider(env({})), null);
  assert.equal(defaultProvider(env({ OPENAI_API_KEY: "o" })), "openai");
  assert.equal(defaultProvider(env({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" })), "gemini");
  assert.equal(defaultProvider(env({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", AI_PROVIDER: "openai" })), "openai");
  assert.equal(defaultProvider(env({ GEMINI_API_KEY: "g", AI_PROVIDER: "openai" })), "gemini");
});

test("Gemini config uses the OpenAI-compatible endpoint and its own models", () => {
  const c = aiConfig(env({ GEMINI_API_KEY: "g" }));
  assert.equal(c?.provider, "gemini");
  assert.equal(c?.baseUrl, GEMINI_BASE_URL);
  assert.equal(c?.model, "gemini-3.5-flash");
  const r = reviewConfig(env({ GEMINI_API_KEY: "g", GEMINI_MODEL: "a", GEMINI_QA_MODEL: "b", QA_MODEL: "z" }));
  assert.equal(r?.model, "b");
  assert.equal(r?.sameModel, false);
  assert.equal(reviewConfig(env({ GEMINI_API_KEY: "g" }))?.sameModel, true);
});

test("selecting OpenAI keeps OPENAI_BASE_URL (fake e2e server) and QA_MODEL", () => {
  const e = env({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", OPENAI_BASE_URL: "http://h/v1/", QA_MODEL: "q" });
  const c = reviewConfig(e, { provider: "openai" });
  assert.equal(c?.baseUrl, "http://h/v1");
  assert.equal(c?.model, "q");
  assert.equal(aiConfig(env({ GEMINI_API_KEY: "g" }), { provider: "openai" }), null);
});

test("model list drops tts/image/embedding models and the models/ prefix", () => {
  const list = parseModelList({
    data: [{ id: "models/gemini-3.8-flash" }, { id: "gemini-tts-x" }, { id: "gemini-image-y" }, { id: "text-embedding-3" }, { id: "gpt-4o-mini" }, {}],
  });
  assert.deepEqual(list, ["gemini-3.8-flash", "gpt-4o-mini"]);
  assert.throws(() => parseModelList({}));
});

test("model list is cached for 10 minutes", async () => {
  resetModelCache();
  const calls: string[] = [];
  const cfg = aiConfig(env({ GEMINI_API_KEY: "g" }))!;
  const f = listFetch(["m1"], calls);
  await listModels(cfg, f, 0);
  await listModels(cfg, f, 9 * 60_000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/models"));
  await listModels(cfg, f, 11 * 60_000);
  assert.equal(calls.length, 2);
});

test("only listed models of a configured provider are accepted", async () => {
  resetModelCache();
  const e = env({ GEMINI_API_KEY: SECRET });
  const f = listFetch(["gemini-a", "gemini-b"]);
  const ok = await resolveDraft({ model: "gemini-b" }, e, f);
  assert.ok(ok.ok && ok.config.model === "gemini-b");
  const bad = await resolveDraft({ model: "gpt-4o" }, e, f);
  assert.ok(!bad.ok && bad.status === 400);
  const wrongProvider = await resolveDraft({ provider: "openai" }, e, f);
  assert.ok(!wrongProvider.ok && wrongProvider.status === 400);
  const none = await resolveDraft({}, env({}), f);
  assert.ok(!none.ok && none.status === 503);
  const review = await resolveReview({ model: "gemini-a", qaModel: "gemini-b" }, e, f);
  assert.ok(review.ok && review.config.model === "gemini-b" && !review.config.sameModel);
  const badQa = await resolveReview({ qaModel: "nope" }, e, f);
  assert.ok(!badQa.ok && badQa.status === 400);
});

test("a failing model list is a 502 that never contains the key", async () => {
  resetModelCache();
  const f = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
  const r = await resolveDraft({ model: "x" }, env({ GEMINI_API_KEY: SECRET }), f);
  assert.ok(!r.ok && r.status === 502);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("request selection and stored choice are validated", () => {
  assert.deepEqual(parseSelection(undefined), {});
  assert.deepEqual(parseSelection({ provider: "gemini", model: " m ", qaModel: "" }), { provider: "gemini", model: "m", qaModel: undefined });
  assert.throws(() => parseSelection({ provider: "evil" }));
  assert.throws(() => parseSelection({ model: 5 }));
  assert.throws(() => parseSelection("x"));
  assert.deepEqual(parseChoice("not json"), {});
  assert.deepEqual(parseChoice(JSON.stringify({ provider: "x", model: "m" })), { provider: undefined, model: "m", qaModel: undefined });
});

test("a chosen model other than the default is not costed at the default price", () => {
  const priced = { GEMINI_API_KEY: "g", AI_PRICE_INPUT_PER_1M: "1", AI_PRICE_OUTPUT_PER_1M: "2", AI_PRICE_CURRENCY: "USD" };
  assert.ok(aiConfig(env(priced))?.price);
  assert.ok(aiConfig(env(priced), { model: "gemini-3.5-flash" })?.price);
  assert.equal(aiConfig(env(priced), { model: "gemini-2.5-pro" })?.price, null);
  assert.equal(reviewConfig(env(priced), { model: "gemini-2.5-pro" })?.price, null);
  const qa = { ...priced, GEMINI_QA_MODEL: "q", QA_PRICE_INPUT_PER_1M: "3", QA_PRICE_OUTPUT_PER_1M: "4" };
  assert.ok(reviewConfig(env(qa))?.price);
  assert.equal(reviewConfig(env(qa), { qaModel: "other" })?.price, null);
});

test("AI_ALLOWED_MODELS limits the choice to its intersection with the provider list", async () => {
  assert.deepEqual(allowedModels(["a", "b"], env({})), ["a", "b"]);
  assert.deepEqual(allowedModels(["a", "b", "c"], env({ AI_ALLOWED_MODELS: " b, c ,x" })), ["b", "c"]);
  resetModelCache();
  const e = env({ GEMINI_API_KEY: "g", AI_ALLOWED_MODELS: "gemini-a" });
  const f = listFetch(["gemini-a", "gemini-b"]);
  assert.ok((await resolveDraft({ model: "gemini-a" }, e, f)).ok);
  const r = await resolveDraft({ model: "gemini-b" }, e, f);
  assert.ok(!r.ok && r.status === 400);
});
