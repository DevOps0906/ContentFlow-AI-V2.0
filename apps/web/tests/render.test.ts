import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approvalFields, articleToFields, parseIncomingArticle, rowToArticle, type ArticleRow } from "../src/lib/articles-db";
import { applyRendererRule, exportHtml, isArticle, saveRevision, type Article } from "../src/lib/content";
import {
  assertDeliverable,
  assertSameAsStored,
  deliveryBlockMessages,
  DeliveryError,
  parseVerdict,
  rendererUnrecordedMessage,
  rpcDeliveryCheck,
  staleCopyMessage,
} from "../src/lib/delivery";
import {
  AD_PROFILES,
  deliveryBlocks,
  LAYOUT_PROFILES,
  previewBlocks,
  RENDERER_VERSION,
  renderFragment,
} from "../src/lib/render";
import { tistoryPackage } from "../src/lib/tistory";
import { toWpContent } from "../src/lib/wordpress";

const article: Article = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  title: "포트 오류 해결",
  keyword: "포트",
  templateId: "T02",
  platform: "wordpress",
  body: "## 원인\n포트가 겹칩니다.\n\n## 해결\n<script>x()</script>",
  sourceUrl: "https://example.com/source",
  status: "export_ready",
  updatedAt: "2026-11-06T00:00:00Z",
  rendererVersion: RENDERER_VERSION,
};
const a01: Article = { ...article, adProfile: "A01" };
const migration = readFileSync(
  new URL("../../../supabase/migrations/0010_display_profiles_and_approval_hash.sql", import.meta.url),
  "utf8",
);

test("profile lists match the database checks", () => {
  const list = (column: string) =>
    [...(migration.match(new RegExp(`${column} in \\(([^)]*)\\)`))?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(list("layout_profile"), [...LAYOUT_PROFILES]);
  assert.deepEqual(list("ad_profile"), [...AD_PROFILES]);
});

test("the HTML export and WordPress share one escaped fragment", () => {
  const fragment = renderFragment(article);
  assert.equal(toWpContent(article), fragment);
  assert.ok(exportHtml(article).includes(fragment));
  assert.ok(fragment.includes("<h2>원인</h2>"));
  assert.ok(fragment.includes("&lt;script&gt;"));
  assert.ok(!fragment.includes("<script>"));
  assert.ok(fragment.includes("<p>출처: https://example.com/source</p>"));
});

test("the source URL is escaped in the shared fragment", () => {
  const html = renderFragment({ ...article, sourceUrl: 'https://x/"><img src=x onerror=alert(1)>' });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&quot;&gt;&lt;img"));
});

test("the layout profile reaches the delivered wrapper", () => {
  assert.ok(renderFragment(article).startsWith('<div class="cf-layout cf-layout-l01">'));
  assert.ok(renderFragment({ ...article, layoutProfile: "L02" }).startsWith('<div class="cf-layout cf-layout-l02">'));
});

test("A01 candidates appear in the preview only", () => {
  assert.deepEqual(previewBlocks(a01).map((b) => b.kind), [
    "heading",
    "paragraph",
    "ad-slot",
    "heading",
    "paragraph",
    "source",
  ]);
  assert.deepEqual(previewBlocks(article), deliveryBlocks(article), "A00 shows no candidates");
  assert.equal(renderFragment(a01), renderFragment(article));
  assert.equal(exportHtml(a01), exportHtml(article));
  assert.ok(!exportHtml(a01).includes("광고"));
});

test("a candidate never falls between adjacent headings, before the first, or in a code fence", () => {
  const kinds = (body: string) => previewBlocks({ ...a01, body }).map((b) => b.kind);
  assert.deepEqual(kinds("## 첫째\n## 둘째\n본문"), ["heading", "heading", "paragraph", "source"]);
  assert.deepEqual(kinds("본문\n```\n## 코드\n```\n끝"), ["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "source"]);
});

test("a code fence opens only without a closing run and closes only on a line of backticks", () => {
  const kinds = (body: string) => deliveryBlocks({ ...article, body }).map((b) => b.kind);
  const source = "source";
  assert.deepEqual(kinds("```인라인```\n## 제목"), ["paragraph", "heading", source], "same-line pair opens nothing");
  assert.deepEqual(kinds("```ts\n## 코드\n```\n## 제목"), ["paragraph", "paragraph", "paragraph", "heading", source]);
  assert.deepEqual(kinds("```\n``` 설명\n## 코드\n```  \n## 제목"), [
    "paragraph",
    "paragraph",
    "paragraph",
    "paragraph",
    "heading",
    source,
  ], "text after the backticks does not close");
});

test("a profile change voids the approval; absent and default are the same profile", () => {
  for (const patch of [{ layoutProfile: "L02" as const }, { adProfile: "A01" as const }])
    assert.equal(saveRevision({ ...article, ...patch }, article).status, "drafting");
  const { layoutProfile: _l, adProfile: _a, ...older } = article;
  void _l;
  void _a;
  assert.equal(saveRevision({ ...older, layoutProfile: "L01", adProfile: "A00" }, older).status, "export_ready");
});

test("stored articles validate their profiles", () => {
  assert.ok(isArticle({ ...article, layoutProfile: "L02", adProfile: "A01" }));
  assert.ok(!isArticle({ ...article, layoutProfile: "L99" }));
  assert.ok(!isArticle({ ...article, adProfile: "A99" }));
  assert.ok(!isArticle({ ...article, rendererVersion: 1 }));
});

test("a renderer version sent in a PUT is never written", () => {
  const claimed = parseIncomingArticle({ ...article, status: "approved", rendererVersion: "client", renderer_version: "client" });
  assert.ok(!("renderer_version" in articleToFields(claimed)));
  assert.deepEqual(approvalFields(claimed.status, "approval_pending"), { renderer_version: RENDERER_VERSION });
  assert.deepEqual(approvalFields(claimed.status, "approved"), {}, "a save of an approved article keeps its version");
  assert.deepEqual(approvalFields("drafting", "approved"), {});
  assert.deepEqual(approvalFields("approved", undefined), {}, "an insert carries none");
});

test("profiles are written when present, never cleared by omission, and map from rows", () => {
  const { layoutProfile: _l, adProfile: _a, ...older } = article;
  void _l;
  void _a;
  assert.ok(!("layout_profile" in articleToFields(older)));
  assert.equal(articleToFields(a01).ad_profile, "A01");
  const row = {
    ...articleToFields(a01),
    id: a01.id,
    updated_at: a01.updatedAt,
    remote: null,
    keyword_id: null,
    published_url: null,
    layout_profile: "L02",
    ad_profile: "A01",
    renderer_version: null,
    evidence_status: "unreviewed",
    rights_status: "unreviewed",
  } as ArticleRow;
  const mapped = rowToArticle(row);
  assert.equal(mapped.layoutProfile, "L02");
  assert.equal(mapped.rendererVersion, undefined);
  assert.equal(rowToArticle({ ...row, renderer_version: "r1" }).rendererVersion, "r1");
});

test("local storage records the renderer on approval and ignores anything else", () => {
  const waiting = { ...article, status: "approval_pending" as const, rendererVersion: undefined };
  const approved = applyRendererRule({ ...waiting, status: "approved" }, waiting);
  assert.equal(approved.rendererVersion, RENDERER_VERSION);
  const forged = applyRendererRule({ ...article, rendererVersion: "forged" }, article);
  assert.equal(forged.rendererVersion, article.rendererVersion);
  const stale = { ...article, rendererVersion: "old" };
  assert.equal(applyRendererRule({ ...stale, status: "published" }, stale).rendererVersion, "old");
  assert.equal(applyRendererRule({ ...stale, rendererVersion: "x" }).rendererVersion, undefined);
});

test("local mode compares the renderer version only", async () => {
  await assert.doesNotReject(assertDeliverable(article));
  for (const rendererVersion of [undefined, "r0"])
    await assert.rejects(assertDeliverable({ ...article, rendererVersion }), (e: DeliveryError) => e.failureType === "not_sendable");
});

test("the local gate still refuses unapproved and unreviewed content", async () => {
  await assert.rejects(assertDeliverable({ ...article, status: "drafting" }), /승인된 콘텐츠/);
  await assert.rejects(assertDeliverable({ ...article, sourceUrl: "javascript:1" }), /근거 자료/);
});

test("account mode lets the database decide, whatever the browser copy says", async () => {
  await assert.doesNotReject(assertDeliverable({ ...article, rendererVersion: undefined }, async () => ({ ok: true })));
  for (const reason of ["hash_version", "hash_mismatch", "renderer_mismatch"] as const)
    await assert.rejects(
      assertDeliverable(article, async () => ({ ok: false, reason })),
      (e: DeliveryError) => e.failureType === "not_sendable" && e.message === deliveryBlockMessages[reason],
    );
});

test("an approval with no recorded renderer asks for a new approval, in both modes", async () => {
  const unrecorded = { ...article, rendererVersion: undefined };
  const isRequired = (e: DeliveryError) => e.message === rendererUnrecordedMessage && /재승인 필요/.test(e.message);
  await assert.rejects(assertDeliverable(unrecorded), isRequired);
  await assert.rejects(assertDeliverable(unrecorded, async () => ({ ok: false, reason: "renderer_mismatch" })), isRequired);
  await assert.rejects(assertDeliverable({ ...article, rendererVersion: "r0" }), (e: DeliveryError) => e.message === deliveryBlockMessages.renderer_mismatch);
});

test("a copy behind the server's is refused; only delivered fields and the state count", () => {
  assert.doesNotThrow(() => assertSameAsStored(article, { ...article, updatedAt: "2026-11-07T00:00:00Z" }));
  assert.doesNotThrow(() => assertSameAsStored(article, { ...article, layoutProfile: "L01", adProfile: "A00" }), "absent is the default");
  for (const change of [{ body: "다른 본문" }, { title: "다른 제목" }, { sourceUrl: "https://example.com/b" }, { adProfile: "A01" as const }, { status: "drafting" as const }])
    assert.throws(() => assertSameAsStored(article, { ...article, ...change }), (e: DeliveryError) => e.failureType === "not_sendable" && e.message === staleCopyMessage);
});

test("the database reasons all have a message", () => {
  const reasons = [...migration.matchAll(/'reason', '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reasons)].sort(), Object.keys(deliveryBlockMessages).sort());
});

test("a malformed verdict blocks the delivery", () => {
  assert.deepEqual(parseVerdict({ ok: true }), { ok: true });
  for (const bad of [null, undefined, {}, { ok: "true" }, { ok: 1 }, "ok"])
    assert.deepEqual(parseVerdict(bad), { ok: false, reason: "unknown" });
  assert.deepEqual(parseVerdict({ ok: false, reason: "hash_mismatch" }), { ok: false, reason: "hash_mismatch" });
  assert.deepEqual(parseVerdict({ ok: false, reason: "__proto__x" }), { ok: false, reason: "unknown" });
});

test("the RPC gets this deployment's renderer, and an RPC failure blocks", async () => {
  let args: Record<string, unknown> | undefined;
  const ok = rpcDeliveryCheck({
    rpc: async (fn, a) => {
      assert.equal(fn, "article_delivery_check");
      args = a;
      return { data: { ok: true }, error: null };
    },
  });
  assert.deepEqual(await ok(article.id), { ok: true });
  assert.deepEqual(args, { p_article_id: article.id, p_renderer_version: RENDERER_VERSION });
  const down = rpcDeliveryCheck({ rpc: async () => ({ data: null, error: { message: "down" } }) });
  await assert.rejects(assertDeliverable(article, down), (e: DeliveryError) => e.failureType !== "not_sendable");
});

test("a Tistory package goes through the same gate", async () => {
  await assert.rejects(tistoryPackage({ ...article, rendererVersion: "r0" }), /다시 승인/);
  await assert.rejects(tistoryPackage(article, async () => ({ ok: false, reason: "hash_mismatch" })), /내용이 달라졌습니다/);
  assert.ok((await tistoryPackage(article, async () => ({ ok: true }))).name.endsWith("-tistory.zip"));
});
