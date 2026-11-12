import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportHtml,
  loadArticles,
  parseArticles,
  parseLegacyArticles,
  reviewErrors,
  saveRevision,
  type Article,
} from "../src/lib/content";
import { requiresApproval } from "../src/lib/lifecycle";
import { templates, templateBody } from "../src/lib/templates";
const article: Article = {
  id: "test",
  title: "포트 오류 해결",
  keyword: "포트",
  templateId: "T03",
  platform: "wordpress",
  body: "## 해결\n다른 프로세스의 포트 사용을 확인합니다.",
  sourceUrl: "https://example.com/source",
  status: "approved",
  updatedAt: "2026-11-05T00:00:00Z",
};
test("10 templates provide distinct selectable content structures", () => {
  assert.equal(new Set(templates.map((t) => t.id)).size, 10);
  for (const t of templates) {
    assert.ok(templateBody(t.id).includes(t.blocks[0]));
    assert.ok(t.evidence);
  }
});
test("changing approved title, body, evidence or template invalidates approval", () => {
  for (const patch of [
    { title: "새 제목" },
    { body: "새 본문" },
    { sourceUrl: "https://example.com/new" },
    { templateId: "T04" },
    { platform: "tistory" as const },
  ])
    assert.equal(
      saveRevision({ ...article, ...patch }, article).status,
      "drafting",
    );
  assert.equal(saveRevision(article, article).status, "approved");
});
test("editing in any reviewed, approved or published state returns to drafting", () => {
  for (const status of [
    ...requiresApproval,
    "qa_pending",
    "approval_pending",
    "needs_revision",
  ] as const) {
    const prev = { ...article, status };
    assert.equal(saveRevision({ ...prev, body: "변경" }, prev).status, "drafting");
    assert.equal(saveRevision(prev, prev).status, status);
  }
  // Planning states keep their state while the brief is being filled in.
  const idea = { ...article, status: "idea" as const };
  assert.equal(saveRevision({ ...idea, title: "새 아이디어" }, idea).status, "idea");
});
test("review blocks empty skeleton and unsafe source protocols", () => {
  assert.ok(reviewErrors({ ...article, body: templateBody("T02") }).length);
  assert.ok(
    reviewErrors({ ...article, sourceUrl: "javascript:alert(1)" }).length,
  );
  assert.deepEqual(reviewErrors(article), []);
});
test("unresolved AI placeholders block review until a person removes them", () => {
  for (const marker of ["[확인 필요]", "[출처 확인 필요: 가격]", "[직접 경험 작성]"])
    assert.ok(reviewErrors({ ...article, body: `## 해결\n본문 ${marker}` }).length, marker);
  assert.deepEqual(reviewErrors({ ...article, body: "## 해결\n확인을 마친 본문" }), []);
});
test("HTML export rejects unapproved states and escapes markup rather than executing it", () => {
  for (const status of ["drafting", "qa_pending", "approval_pending", "needs_revision", "idea"] as const)
    assert.throws(() => exportHtml({ ...article, status }));
  for (const status of requiresApproval)
    assert.doesNotThrow(() => exportHtml({ ...article, status }));
  const html = exportHtml({
    ...article,
    title: "<script>alert(1)</script>",
    body: '## <img onerror="alert(1)">\n<script>attack()</script>',
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
});
test("invalid storage cannot silently replace valid content", () => {
  assert.deepEqual(parseArticles(null), []);
  assert.deepEqual(parseArticles(JSON.stringify([article])), [article]);
  assert.throws(() => parseArticles("{bad"));
  assert.throws(() =>
    parseArticles(JSON.stringify([{ ...article, templateId: "missing" }])),
  );
  assert.throws(() =>
    parseArticles(JSON.stringify([{ ...article, updatedAt: "bad" }])),
  );
  assert.throws(() => parseArticles(JSON.stringify([{ ...article, status: "draft" }])));
});
test("v1 storage is migrated to lifecycle states without changing the original", () => {
  const v1 = JSON.stringify([
    { ...article, id: "a", status: "draft" },
    { ...article, id: "b", status: "review" },
    { ...article, id: "c", status: "approved" },
  ]);
  const before = v1;
  assert.deepEqual(
    parseLegacyArticles(v1).map((a) => a.status),
    ["drafting", "approval_pending", "approved"],
  );
  assert.equal(v1, before);
  assert.throws(() => parseLegacyArticles(JSON.stringify([{ ...article, status: "published" }])));
  // v2 takes precedence, even when it is an empty list.
  assert.deepEqual(loadArticles("[]", v1), []);
  assert.equal(loadArticles(null, v1).length, 3);
  assert.deepEqual(loadArticles(null, null), []);
});
