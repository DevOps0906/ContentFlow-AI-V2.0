import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyReviewRule,
  disclosureErrors,
  disclosureWindow,
  hasAffiliateLink,
  hasDisclosure,
  hasNaverShortLink,
  type Article,
} from "../src/lib/content";
import { approvalRejection } from "../src/lib/articles-db";
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
    assert.equal(disclosureErrors(a).length, f.link && !f.disclosed ? 1 : 0, `${f.name} (errors)`);
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
