import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportHtml,
  parseArticles,
  reviewErrors,
  saveRevision,
  type Article,
} from "../src/lib/content";
import { templates, templateBody } from "../src/lib/templates";
const article: Article = {
  id: "test",
  title: "포트 오류 해결",
  keyword: "포트",
  templateId: "T02",
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
      "draft",
    );
  assert.equal(saveRevision(article, article).status, "approved");
});
test("review blocks empty skeleton and unsafe source protocols", () => {
  assert.ok(reviewErrors({ ...article, body: templateBody("T02") }).length);
  assert.ok(
    reviewErrors({ ...article, sourceUrl: "javascript:alert(1)" }).length,
  );
  assert.deepEqual(reviewErrors(article), []);
});
test("HTML export rejects drafts and escapes markup rather than executing it", () => {
  assert.throws(() => exportHtml({ ...article, status: "draft" }));
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
});
