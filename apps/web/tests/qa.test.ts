import { test } from "node:test";
import assert from "node:assert/strict";
import { runQa } from "../src/lib/qa";
import { reviewErrors, type Article } from "../src/lib/content";

const body = "## 해결\n" + "포트 사용 여부를 확인하고 충돌하는 프로세스를 종료합니다. ".repeat(12);
const article: Article = {
  id: "a",
  title: "Next.js 포트 3000 오류 해결 방법",
  keyword: "포트 3000",
  templateId: "T02",
  platform: "wordpress",
  body,
  sourceUrl: "https://nextjs.org/docs",
  status: "drafting",
  updatedAt: "2026-11-06T00:00:00Z",
};
const codes = (a: Article, others: Article[] = []) => runQa(a, others).warnings.map((w) => w.code);

test("a clean article has no blockers and no warnings, and says how many checks ran", () => {
  const r = runQa(article);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.checked > 0);
});

test("blockers are exactly the review rules the database enforces", () => {
  for (const patch of [{ title: "" }, { sourceUrl: "javascript:1" }, { body: "## a\n" }, { body: "## a\n본문 [확인 필요]" }])
    assert.deepEqual(runQa({ ...article, ...patch }).blockers, reviewErrors({ ...article, ...patch }));
  assert.ok(runQa({ ...article, title: "" }).blockers.length > 0);
});

test("advisory checks warn without blocking", () => {
  const r = runQa({ ...article, title: "짧은글", body: "## a\n짧음\n## b\n", keyword: "없는키워드" });
  const c = r.warnings.map((w) => w.code);
  for (const code of ["title-length", "short-body", "empty-sections", "keyword-missing"]) assert.ok(c.includes(code), code);
  assert.deepEqual(r.blockers, []);
  assert.ok(codes({ ...article, body: "이어진 본문 ".repeat(80) }).includes("no-headings"));
  assert.ok(codes({ ...article, title: "x".repeat(70) }).includes("title-length"));
});

test("guarantee phrases and placeholder sources are flagged", () => {
  assert.ok(codes({ ...article, body: body + "\n이 방법은 수익 보장입니다." }).includes("guarantee"));
  assert.ok(codes({ ...article, body: body + "\n무조건 성공합니다." }).includes("guarantee"));
  assert.ok(codes({ ...article, sourceUrl: "https://example.com/doc" }).includes("placeholder-source"));
  assert.ok(codes({ ...article, sourceUrl: "http://localhost:3000/x" }).includes("placeholder-source"));
  assert.ok(!codes(article).includes("placeholder-source"));
});

test("duplicates are detected by normalized title and keyword, ignoring itself and ideas", () => {
  const other = { ...article, id: "b", title: "  next.js 포트 3000 오류 해결 방법 " };
  assert.ok(codes(article, [other]).includes("duplicate-title"));
  assert.ok(codes(article, [other]).includes("keyword-overlap"));
  assert.ok(!codes(article, [article]).includes("duplicate-title"));
  assert.ok(!codes(article, [{ ...other, status: "idea" as const, title: "다른 제목" }]).includes("keyword-overlap"));
  assert.ok(!codes(article, [{ ...other, title: "전혀 다른 제목입니다", keyword: "다른" }]).length);
});