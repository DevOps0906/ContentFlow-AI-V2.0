import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ARTICLE_COLUMNS, articleToFields, parseIncomingArticle, parseReviewDecision, rowToArticle, templateVersionFields, type ArticleRow } from "../src/lib/articles-db";
import {
  applyBriefRule,
  applyReviewRule,
  applyTemplateVersionRule,
  approvalBlockers,
  briefErrors,
  contentChanged,
  isArticle,
  REVIEW_STATUSES,
  type Article,
} from "../src/lib/content";
import { findTemplate, templateVersion } from "../src/lib/templates";
import { isTitleEvaluation, newTitleEvaluation } from "../src/lib/titles";

const sql = readFileSync(new URL("../../../supabase/migrations/0013_brief_review_title_template.sql", import.meta.url), "utf8");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const article: Article = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  title: "제목",
  keyword: "키워드",
  templateId: "T01",
  platform: "wordpress",
  body: ["핵심 답변", "대상과 적용 조건", "단계별 안내", "주의 사항", "FAQ", "출처"].map((b) => `## ${b}\n내용`).join("\n"),
  sourceUrl: "https://example.com/a",
  status: "drafting",
  updatedAt: "2026-11-11T00:00:00.000Z",
};
const brief: Article = { ...article, status: "briefing", briefPurpose: "목적", briefAudience: "대상" };

test("the review statuses match the database checks", () => {
  for (const column of ["evidence_status", "rights_status"]) {
    const list = sql.match(new RegExp(`check \\(${column} in \\(([^)]*)\\)`))?.[1];
    assert.deepEqual(list?.split(",").map((s) => s.trim().replace(/'/g, "")), [...REVIEW_STATUSES]);
  }
});

test("the brief needs purpose, audience and an http(s) source", () => {
  assert.deepEqual(briefErrors(brief), []);
  assert.equal(briefErrors({ ...brief, briefPurpose: "  " }).length, 1);
  assert.equal(briefErrors({ ...brief, briefAudience: undefined }).length, 1);
  assert.equal(briefErrors({ ...brief, sourceUrl: "ftp://x.example" }).length, 1);
  assert.equal(briefErrors({ ...article, status: "briefing" }).length, 2);
});

test("the brief is enforced only when leaving the briefing state", () => {
  const empty = { ...article, status: "briefing" as const, sourceUrl: "" };
  assert.equal(applyBriefRule({ ...empty, title: "수정" }, empty).title, "수정");
  assert.throws(() => applyBriefRule({ ...empty, status: "drafting" }, empty), /목적/);
  assert.equal(applyBriefRule({ ...brief, status: "drafting" }, brief).status, "drafting");
  const older = { ...article, sourceUrl: "" };
  assert.equal(applyBriefRule({ ...older, title: "수정" }, older).title, "수정");
  assert.throws(() => applyBriefRule({ ...older, status: "qa_pending" }, older), /목적/);
});

test("every route into review needs the brief", () => {
  const noBrief = { ...article };
  for (const status of ["qa_pending", "approval_pending"] as const) {
    assert.throws(() => applyBriefRule({ ...noBrief, status }, noBrief), /목적/, status);
    assert.equal(applyBriefRule({ ...brief, status }, { ...brief, status: "drafting" }).status, status);
  }
  // An edit of a later state counts as drafting; a decision on unchanged content does not.
  const approved: Article = { ...noBrief, status: "approved" };
  assert.throws(() => applyBriefRule({ ...approved, body: "## 답변\n고친 내용", status: "approval_pending" }, approved), /목적/);
  const waiting: Article = { ...noBrief, status: "approval_pending" };
  assert.equal(applyBriefRule({ ...waiting, status: "approved" }, waiting).status, "approved");
  assert.equal(applyBriefRule({ ...waiting }, waiting).status, "approval_pending");
  // A failed QA is recorded, and a save that does not enter review is not blocked.
  assert.equal(applyBriefRule({ ...noBrief, status: "needs_revision" }, noBrief).status, "needs_revision");
  assert.throws(() => applyBriefRule({ ...noBrief, status: "approval_pending" }), /목적/, "a new article has no previous copy");
});

test("the review gate in the database matches the app rule", () => {
  const gate = read("../../../supabase/migrations/0014_brief_before_review_keyword_guard.sql");
  assert.match(gate, /base = 'drafting' and new\.state in \('qa_pending', 'approval_pending'\) and not article_brief_ok\(new\)/);
  assert.match(gate, /new\.keyword_id is distinct from old\.keyword_id/);
});

test("approval needs both decisions to be ok", () => {
  const waiting: Article = { ...article, status: "approval_pending" };
  const approve = (evidenceStatus: Article["evidenceStatus"], rightsStatus: Article["rightsStatus"]) => {
    const previous = { ...waiting, evidenceStatus, rightsStatus };
    return applyReviewRule({ ...previous, status: "approved" }, previous);
  };
  assert.throws(() => approve(undefined, undefined), /근거 검토/);
  assert.throws(() => approve("ok", "unreviewed"), /권리 검토/);
  assert.throws(() => approve("blocked", "ok"), /근거에 문제/);
  assert.throws(() => approve("ok", "blocked"), /권리에 문제/);
  assert.equal(approve("ok", "ok").status, "approved");
  assert.equal(approvalBlockers({ ...waiting, evidenceStatus: "blocked", rightsStatus: "blocked" }).length, 2);
});

test("an edit resets the review and a new article starts unreviewed", () => {
  const reviewed: Article = { ...article, evidenceStatus: "ok", rightsStatus: "blocked" };
  const edited = applyReviewRule({ ...reviewed, body: "## 답변\n고친 내용" }, reviewed);
  assert.equal(edited.evidenceStatus, undefined);
  assert.equal(edited.rightsStatus, undefined);
  const same = applyReviewRule({ ...reviewed }, reviewed);
  assert.equal(same.evidenceStatus, "ok");
  const claimed = applyReviewRule({ ...article, evidenceStatus: "ok", rightsStatus: "ok" });
  assert.equal(claimed.evidenceStatus, undefined);
  assert.ok(contentChanged({ ...article, briefPurpose: "새 목적" }, article));
  assert.ok(!contentChanged({ ...article, briefPurpose: "" }, article));
});

test("the review is locked after approval", () => {
  const approved: Article = { ...article, status: "approved", evidenceStatus: "ok", rightsStatus: "ok" };
  assert.throws(() => applyReviewRule({ ...approved, evidenceStatus: "blocked" }, approved), /승인 후/);
  assert.throws(() => applyReviewRule({ ...approved, rightsStatus: "unreviewed" }, approved), /승인 후/);
  assert.equal(applyReviewRule({ ...approved, status: "export_ready" }, approved).evidenceStatus, "ok");
});

test("a save can not write the review, and only the review route does", () => {
  const claimed = parseIncomingArticle({ ...article, evidenceStatus: "ok", rightsStatus: "ok" });
  const fields = articleToFields(claimed);
  assert.ok(!("evidence_status" in fields));
  assert.ok(!("rights_status" in fields));
  assert.throws(() => parseReviewDecision({ evidenceStatus: "ok" }), /상태 값/);
  assert.throws(() => parseReviewDecision({ evidenceStatus: "ok", rightsStatus: "fine" }), /상태 값/);
  assert.deepEqual(parseReviewDecision({ evidenceStatus: "ok", rightsStatus: "blocked", extra: 1 }), {
    evidenceStatus: "ok",
    rightsStatus: "blocked",
  });
});

test("AI routes never write the review or the state", () => {
  const dir = "../src/app/api/ai/";
  for (const file of ["generate/route.ts", "review/route.ts"]) {
    const source = read(`${dir}${file}`);
    assert.doesNotMatch(source, /evidence_status|rights_status|evidenceStatus|rightsStatus/, file);
    assert.doesNotMatch(source, /\.update\(/, file);
  }
});

test("article fields round trip through the row", () => {
  assert.ok(ARTICLE_COLUMNS.includes("evidence_status"));
  const evaluation = newTitleEvaluation("포트 오류");
  const row = {
    ...articleToFields({ ...article, briefPurpose: "목적", briefAudience: "대상", titleEvaluation: evaluation }),
    id: article.id,
    updated_at: article.updatedAt,
    remote: null,
    keyword_id: null,
    published_url: null,
    layout_profile: "L01",
    ad_profile: "A00",
    renderer_version: null,
    evidence_status: "ok",
    rights_status: "unreviewed",
    template_version: "T01@1",
  } as ArticleRow;
  const mapped = rowToArticle(row);
  assert.equal(mapped.briefPurpose, "목적");
  assert.equal(mapped.briefAudience, "대상");
  assert.equal(mapped.evidenceStatus, "ok");
  assert.equal(mapped.rightsStatus, undefined);
  assert.equal(mapped.templateVersion, "T01@1");
  assert.deepEqual(mapped.titleEvaluation, evaluation);
  assert.ok(isArticle(mapped));
});

test("a save without the new fields leaves them alone", () => {
  const fields = articleToFields(article);
  for (const key of ["brief_purpose", "brief_audience", "title_evaluation", "template_version"]) assert.ok(!(key in fields), key);
  assert.ok(isArticle(article));
  assert.ok(!isArticle({ ...article, briefPurpose: "가".repeat(1001) }));
  assert.ok(!isArticle({ ...article, evidenceStatus: "fine" }));
  assert.ok(!isArticle({ ...article, titleEvaluation: [] }));
});

test("title ratings keep five candidates and known ratings", () => {
  const evaluation = newTitleEvaluation("포트 오류");
  assert.equal(evaluation.length, 5);
  assert.ok(evaluation.every((e) => e.intent === null && e.clarity === null && e.exaggeration === null));
  assert.ok(isTitleEvaluation(evaluation));
  assert.ok(isTitleEvaluation(evaluation.map((e) => ({ ...e, intent: "good", clarity: "fair", exaggeration: "poor" }))));
  assert.ok(!isTitleEvaluation(evaluation.slice(1)));
  assert.ok(!isTitleEvaluation(evaluation.map((e) => ({ ...e, intent: "great" }))));
  assert.ok(!isTitleEvaluation(evaluation.map((e) => ({ ...e, title: "" }))));
  assert.throws(() => newTitleEvaluation("  "));
});

test("pinned template versions fix their blocks and evidence", () => {
  // Changing what a pinned template contains needs a new version: bump it here and in templates.ts.
  const pinned = {
    "T01@1": {
      id: "T01",
      blocks: ["핵심 답변", "대상과 적용 조건", "단계별 안내", "주의 사항", "FAQ", "출처"],
      evidence: "핵심 정보의 공식 출처와 확인일",
    },
    "T02@1": {
      id: "T02",
      blocks: ["증상과 오류 메시지", "사용 환경과 버전", "원인과 우선 점검", "단계별 해결", "성공 확인", "출처"],
      evidence: "재현 환경, 실행 결과, 공식 문서",
    },
    "T04@1": {
      id: "T04",
      blocks: ["비교 대상과 기준", "가격과 기능 비교", "장점과 단점", "대상별 선택 안내", "한계와 조건", "출처"],
      evidence: "대상별 가격·버전·조건의 출처와 확인일",
    },
  };
  for (const [version, want] of Object.entries(pinned)) {
    const template = findTemplate(want.id);
    assert.equal(templateVersion(want.id), version);
    assert.deepEqual(template.blocks, want.blocks, version);
    assert.equal(template.evidence, want.evidence, version);
  }
  assert.equal(templateVersion("T03"), undefined);
});

test("the version is pinned when the template is chosen", () => {
  assert.equal(applyTemplateVersionRule(article).templateVersion, "T01@1");
  assert.equal(applyTemplateVersionRule({ ...article, templateVersion: "forged" }).templateVersion, "T01@1");
  const pinned = { ...article, templateVersion: "T01@0" };
  assert.equal(applyTemplateVersionRule({ ...pinned, templateVersion: "T01@9" }, pinned).templateVersion, "T01@0");
  assert.equal(applyTemplateVersionRule({ ...pinned, templateId: "T02" }, pinned).templateVersion, "T02@1");
  assert.ok(!("templateVersion" in applyTemplateVersionRule({ ...pinned, templateId: "T03" }, pinned)));
  assert.ok(!("templateVersion" in applyTemplateVersionRule({ ...article, title: "수정" }, article)), "older articles stay unversioned");
});

test("the server stamps the version only on a new article or a template change", () => {
  assert.deepEqual(templateVersionFields("T02"), { template_version: "T02@1" });
  assert.deepEqual(templateVersionFields("T05"), { template_version: null });
  assert.deepEqual(templateVersionFields("T02", { template_id: "T02" }), {});
  assert.deepEqual(templateVersionFields("T04", { template_id: "T02" }), { template_version: "T04@1" });
  assert.ok(!("template_version" in articleToFields({ ...article, templateVersion: "forged" })));
});
