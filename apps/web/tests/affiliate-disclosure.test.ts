import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyReviewRule,
  contentChanged,
  disclosureErrors,
  disclosureWindow,
  hasAffiliateLink,
  hasDisclosure,
  hasNaverShortLink,
  isArticle,
  type Article,
} from "../src/lib/content";
import { approvalRejection, withStoredAffiliate, articleToFields, rowToArticle, ARTICLE_COLUMNS, type ArticleRow } from "../src/lib/articles-db";
import { runQa } from "../src/lib/qa";

// Shared with supabase/tests/rls.sql, which runs the same rows through migration 0028.
type Fixture = {
  name: string;
  title: string;
  body: string;
  prefix?: { text: string; times: number };
  link: boolean;
  disclosed: boolean;
  naverMe?: boolean;
  /** 0029 article-level mark (absent = false) and the expected approval gate (absent = !link || disclosed). */
  affiliate?: boolean;
  ok?: boolean;
};
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(__dirname, "../../../supabase/tests/disclosure-fixtures.json"), "utf8"),
);
const bodyOf = (f: Fixture) => (f.prefix ? f.prefix.text.repeat(f.prefix.times) : "") + f.body;

test("shared disclosure fixtures", () => {
  assert.ok(fixtures.length > 10);
  for (const f of fixtures) {
    const a = { title: f.title, body: bodyOf(f) };
    assert.equal(hasAffiliateLink(a), f.link, `${f.name} (link)`);
    assert.equal(hasDisclosure(a), f.disclosed, `${f.name} (disclosure)`);
    assert.equal(hasNaverShortLink(a), !!f.naverMe, `${f.name} (naver.me)`);
    const ok = f.ok ?? (!f.link || f.disclosed);
    assert.equal(disclosureErrors({ ...a, affiliate: f.affiliate }).length, ok ? 0 : 1, `${f.name} (gate)`);
  }
});

test("the window counts code points, not UTF-16 units", () => {
  assert.equal(Array.from(disclosureWindow({ title: "T", body: "😀".repeat(400) })).length, 300);
});

const article: Article = {
  id: "a",
  title: "무선 청소기 추천",
  keyword: "무선 청소기",
  templateId: "T03",
  platform: "wordpress",
  body: "## 추천\n구매 https://link.coupang.com/a/1",
  sourceUrl: "https://example.org/spec",
  status: "approval_pending",
  updatedAt: "2026-11-16T00:00:00Z",
  evidenceStatus: "ok",
  rightsStatus: "ok",
};
const disclosed = { ...article, body: `이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n${article.body}` };

test("local approval needs the disclosure; later states are not checked again", () => {
  assert.throws(() => applyReviewRule({ ...article, status: "approved" }, article), /고지/);
  assert.equal(applyReviewRule({ ...disclosed, status: "approved" }, disclosed).status, "approved");
  const published = { ...article, status: "published" as const };
  assert.equal(applyReviewRule({ ...published, status: "monitoring" }, published).status, "monitoring");
});

test("the API refuses only entering approval without the disclosure (r4)", () => {
  for (const status of ["qa_pending", "approval_pending"] as const)
    assert.equal(approvalRejection({ ...article, status }, "drafting"), undefined, status);
  assert.match(approvalRejection({ ...article, status: "approved" }, "approval_pending") ?? "", /고지/);
  assert.equal(approvalRejection({ ...disclosed, status: "approved" }, "approval_pending"), undefined);
  assert.equal(approvalRejection({ ...article, status: "approved" }, "approved"), undefined);
  assert.equal(approvalRejection({ ...article, status: "monitoring" }, "published"), undefined);
});

test("naver.me only warns, and never blocks", () => {
  const naver = { ...article, body: "## 추천\n지도 https://naver.me/abc" };
  const report = runQa(naver);
  assert.ok(report.warnings.some((w) => w.code === "naver-me-disclosure"));
  assert.deepEqual(disclosureErrors(naver), []);
  assert.equal(approvalRejection({ ...naver, status: "approved" }, "approval_pending"), undefined);
});

test("an article marked as affiliate needs the disclosure without a Coupang link (0029)", () => {
  const naver = { ...article, body: "## 추천\n구매 https://naver.me/abc" };
  const marked = { ...naver, affiliate: true };
  assert.match(approvalRejection({ ...marked, status: "approved" }, "approval_pending") ?? "", /제휴·광고/);
  assert.throws(() => applyReviewRule({ ...marked, status: "approved" }, marked), /고지/);
  const withBc = { ...marked, body: `이 글은 네이버 쇼핑 커넥트 활동으로, 구매 시 판매 수수료를 받습니다.\n${naver.body}` };
  assert.equal(approvalRejection({ ...withBc, status: "approved" }, "approval_pending"), undefined);
  // Only entering approval is checked: a published article marked later keeps moving.
  const published = { ...marked, status: "published" as const, publishedUrl: "https://blog.example/p" };
  assert.equal(applyReviewRule({ ...published, status: "monitoring" }, published).status, "monitoring");
});

test("the mark is not a content change and is never cleared by omission (0029 r2)", () => {
  const saved = { ...article, status: "approved" as const, affiliate: true };
  assert.equal(contentChanged({ ...saved, affiliate: false }, saved), false);
  assert.equal(applyReviewRule({ ...article, affiliate: true }, article).evidenceStatus, "ok");
  assert.ok(!("affiliate" in articleToFields(article)));
  assert.equal(articleToFields({ ...article, affiliate: false }).affiliate, false);
  assert.equal(articleToFields({ ...article, affiliate: true }).affiliate, true);
  assert.ok(ARTICLE_COLUMNS.split(",").includes("affiliate"));
  assert.equal(rowToArticle({ affiliate: true } as ArticleRow).affiliate, true);
  assert.equal(rowToArticle({ affiliate: false } as ArticleRow).affiliate, undefined);
  assert.ok(isArticle({ ...article, affiliate: true }));
  assert.ok(!isArticle({ ...article, affiliate: "yes" }));
});

test("migration 0029 keeps the mark out of the approval hash and `changed`", () => {
  const sql = readFileSync(join(__dirname, "../../../supabase/migrations/0029_article_affiliate_flag.sql"), "utf8");
  const changed = sql.match(/changed := \(([^)]*)\)/)![1];
  assert.ok(!changed.includes("affiliate"));
  const hash = sql.match(/article_content_hash_v2\(([^;]*)\);/)![1];
  assert.ok(!hash.includes("affiliate"));
});

test("local save without the mark keeps the stored one; only an explicit false clears it", () => {
  const naver = { ...article, body: "## 추천\n구매 https://naver.me/abc" };
  const saved = { ...naver, affiliate: true };
  const { affiliate: _omit, ...omitted } = saved;
  void _omit;
  assert.equal(applyReviewRule(omitted, saved).affiliate, true);
  assert.throws(() => applyReviewRule({ ...omitted, status: "approved" }, saved), /제휴·광고/);
  assert.equal(applyReviewRule({ ...naver, affiliate: false }, saved).affiliate, false);
});

test("the API judges approval with the stored mark when the request omits it", () => {
  const naver = { ...article, body: "## 추천\n구매 https://naver.me/abc", status: "approved" as const };
  assert.equal(withStoredAffiliate(naver, { affiliate: true }).affiliate, true);
  assert.match(approvalRejection(withStoredAffiliate(naver, { affiliate: true }), "approval_pending") ?? "", /제휴·광고/);
  assert.equal(approvalRejection(withStoredAffiliate(naver, { affiliate: false }), "approval_pending"), undefined);
  assert.equal(withStoredAffiliate({ ...naver, affiliate: false }, { affiliate: true }).affiliate, false);
  assert.equal(withStoredAffiliate(naver, null).affiliate, undefined);
});
