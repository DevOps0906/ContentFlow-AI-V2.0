import { findTemplate, templates, templateVersion } from "./templates";
import { isTitleEvaluation, type TitleEvaluationEntry } from "./titles";
import {
  afterEdit,
  isLifecycleState,
  legacyStatuses,
  localToLifecycle,
  requiresApproval,
  type LegacyStatus,
  type LifecycleState,
} from "./lifecycle";
import {
  AD_PROFILES,
  DEFAULT_AD,
  DEFAULT_LAYOUT,
  escapeHtml,
  LAYOUT_PROFILES,
  RENDERER_VERSION,
  renderFragment,
  type AdProfile,
  type LayoutProfile,
} from "./render";

export type Article = {
  id: string;
  title: string;
  keyword: string;
  templateId: string;
  platform: "wordpress" | "tistory" | "blogger" | "naver";
  body: string;
  sourceUrl: string;
  status: LifecycleState;
  updatedAt: string;
  /** Draft created in WordPress. Kept so a retry updates it instead of duplicating. */
  remote?: { postId: number; url: string; syncedAt: string };
  /** Keyword this article was created from (links by id; falls back to the phrase if absent). */
  keywordId?: string;
  /** Blog account (account mode). `null` clears the link; absent leaves it. Not part of the approved content. */
  blogId?: string | null;
  /** Public address confirmed by an operator on publication. Never taken from `remote.url`. */
  publishedUrl?: string;
  /** Absent in older browser data: read as the default profile. */
  layoutProfile?: LayoutProfile;
  adProfile?: AdProfile;
  /** Renderer the last approval was made with. Set on approval, never taken from a client. */
  rendererVersion?: string;
  /** Brief fields. Absent means empty; required only to leave the `briefing` state. */
  briefPurpose?: string;
  briefAudience?: string;
  /** A person's decision. Absent reads as unreviewed. AI review never writes these. */
  evidenceStatus?: ReviewStatus;
  rightsStatus?: ReviewStatus;
  /** Ratings of the five title candidates. Not part of the approved content. */
  titleEvaluation?: TitleEvaluationEntry[];
  /** Pinned when the template is chosen. Absent on older articles and unversioned templates. */
  templateVersion?: string;
};
// Keep in sync with the evidence_status and rights_status checks in migration 0013 (a test compares them).
export const REVIEW_STATUSES = ["unreviewed", "ok", "blocked"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const reviewStatusLabels: Record<ReviewStatus, string> = {
  unreviewed: "미검토",
  ok: "확인 완료",
  blocked: "문제 있음(보류)",
};
export const isReviewStatus = (v: unknown): v is ReviewStatus => REVIEW_STATUSES.includes(v as ReviewStatus);
export const STORAGE_KEY = "contentflow.articles.v2";
/** v1 stored the 3-step status. It is read for migration and never overwritten. */
export const LEGACY_STORAGE_KEY = "contentflow.articles.v1";

function hasArticleFields(a: Record<string, unknown>) {
  return (
    ["id", "title", "keyword", "body", "sourceUrl", "updatedAt"].every(
      (k) => typeof a[k] === "string",
    ) &&
    templates.some((t) => t.id === a.templateId) &&
    ["wordpress", "tistory", "blogger", "naver"].includes(String(a.platform)) &&
    !Number.isNaN(Date.parse(String(a.updatedAt)))
  );
}
export function isArticle(value: unknown): value is Article {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    hasArticleFields(a) &&
    isLifecycleState(a.status) &&
    isRemote(a.remote) &&
    (a.keywordId === undefined || (typeof a.keywordId === "string" && a.keywordId.length <= 64)) &&
    (a.blogId === undefined || a.blogId === null || (typeof a.blogId === "string" && a.blogId.length <= 64)) &&
    (a.publishedUrl === undefined || isPublishedUrl(a.publishedUrl)) &&
    (a.layoutProfile === undefined || LAYOUT_PROFILES.includes(a.layoutProfile as LayoutProfile)) &&
    (a.adProfile === undefined || AD_PROFILES.includes(a.adProfile as AdProfile)) &&
    (a.rendererVersion === undefined || (typeof a.rendererVersion === "string" && a.rendererVersion.length <= 32)) &&
    isBriefText(a.briefPurpose) &&
    isBriefText(a.briefAudience) &&
    (a.evidenceStatus === undefined || isReviewStatus(a.evidenceStatus)) &&
    (a.rightsStatus === undefined || isReviewStatus(a.rightsStatus)) &&
    (a.titleEvaluation === undefined || isTitleEvaluation(a.titleEvaluation)) &&
    (a.templateVersion === undefined || (typeof a.templateVersion === "string" && a.templateVersion.length <= 32))
  );
}
/** Keep the limit in sync with the brief columns in migration 0013. */
function isBriefText(value: unknown) {
  return value === undefined || (typeof value === "string" && value.length <= 1000);
}
/** Keep in sync with the articles_published_url check in migration 0009. */
export function isPublishedUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2000 &&
    /^https?:\/\/\S+$/i.test(value) &&
    URL.canParse(value)
  );
}
const afterPublish: readonly LifecycleState[] = ["published", "monitoring", "update_due"];
/**
 * Browser-storage copy of the trigger rule in migration 0009: the URL is written only by the
 * transition into `published`, and is cleared when the article goes back to editing.
 */
export function applyPublishedUrlRule(next: Article, previous?: Article): Article {
  if (next.status === "published" && previous?.status !== "published") {
    if (!isPublishedUrl(next.publishedUrl))
      throw new Error("게시된 글의 http/https 공개 URL을 입력해주세요.");
    return next;
  }
  if (next.publishedUrl !== previous?.publishedUrl)
    throw new Error("공개 URL은 게시 완료를 확인할 때만 입력할 수 있습니다.");
  if (afterPublish.includes(next.status)) return next;
  const { publishedUrl: _publishedUrl, ...rest } = next;
  void _publishedUrl;
  return rest;
}
/**
 * Browser-storage copy of the rule in migration 0010: only the approval records the renderer, and
 * whatever the saved copy claims is ignored otherwise.
 */
export function applyRendererRule(next: Article, previous?: Article): Article {
  const { rendererVersion: _claimed, ...rest } = next;
  void _claimed;
  if (next.status === "approved" && previous?.status !== "approved")
    return { ...rest, rendererVersion: RENDERER_VERSION };
  return previous?.rendererVersion === undefined ? rest : { ...rest, rendererVersion: previous.rendererVersion };
}
/** Same checks as article_brief_ok() in migration 0013. */
export function briefErrors(article: Article): string[] {
  const errors: string[] = [];
  if (!article.briefPurpose?.trim()) errors.push("브리프의 목적을 입력해주세요.");
  if (!article.briefAudience?.trim()) errors.push("브리프의 대상 독자를 입력해주세요.");
  if (!isPublishedUrl(article.sourceUrl)) errors.push("근거 자료의 http/https URL을 입력해주세요.");
  if (!article.platform) errors.push("발행 채널을 선택해주세요.");
  return errors;
}
const intoReview: readonly LifecycleState[] = ["qa_pending", "approval_pending"];
/**
 * Browser-storage copy of the trigger rules in migrations 0013 and 0014: checked when leaving the
 * brief and on every route into review. An edit of a later state counts as drafting.
 */
export function applyBriefRule(next: Article, previous?: Article): Article {
  const leavesBrief = previous?.status === "briefing" && next.status !== "briefing";
  const entersReview =
    intoReview.includes(next.status) &&
    (!previous || previous.status === "drafting" || contentChanged(next, previous));
  if (leavesBrief || entersReview) {
    const errors = briefErrors(next);
    if (errors.length) throw new Error(errors[0]);
  }
  return next;
}
const reviewOf = (a: Article) => [a.evidenceStatus ?? "unreviewed", a.rightsStatus ?? "unreviewed"];
/** Why a person's review does not allow approval yet. */
export function approvalBlockers(article: Article): string[] {
  const [evidence, rights] = reviewOf(article);
  const errors: string[] = [];
  if (evidence === "blocked") errors.push("근거에 문제가 있어 승인할 수 없습니다.");
  else if (evidence !== "ok") errors.push("근거 검토를 완료해주세요.");
  if (rights === "blocked") errors.push("권리에 문제가 있어 승인할 수 없습니다.");
  else if (rights !== "ok") errors.push("권리 검토를 완료해주세요.");
  return errors;
}
function withoutReview(article: Article): Article {
  const { evidenceStatus: _evidence, rightsStatus: _rights, ...rest } = article;
  void _evidence;
  void _rights;
  return rest;
}
/**
 * Browser-storage copy of the trigger rule in migration 0013: the review is locked after approval,
 * applies only to the content it was made on, and approval needs both decisions to be ok.
 */
export function applyReviewRule(next: Article, previous?: Article): Article {
  if (!previous) return withoutReview(next);
  const [evidence, rights] = reviewOf(next);
  const [oldEvidence, oldRights] = reviewOf(previous);
  if ((evidence !== oldEvidence || rights !== oldRights) && requiresApproval.includes(previous.status))
    throw new Error("승인 후에는 근거·권리 상태를 바꿀 수 없습니다.");
  const result = contentChanged(next, previous) ? withoutReview(next) : next;
  if (next.status === "approved" && previous.status !== "approved") {
    const errors = approvalBlockers(result);
    if (errors.length) throw new Error(errors[0]);
  }
  return result;
}
/** Browser-storage copy of the rule in migration 0013: the version follows the chosen template only. */
export function applyTemplateVersionRule(next: Article, previous?: Article): Article {
  const { templateVersion: _claimed, ...rest } = next;
  void _claimed;
  const version = previous && previous.templateId === next.templateId ? previous.templateVersion : templateVersion(next.templateId);
  return version === undefined ? rest : { ...rest, templateVersion: version };
}
function isRemote(value: unknown) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isInteger(r.postId) &&
    typeof r.url === "string" &&
    typeof r.syncedAt === "string"
  );
}
function readArray(raw: string): unknown[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error("저장된 콘텐츠 형식을 읽을 수 없습니다.");
  return parsed;
}
export function parseArticles(raw: string | null): Article[] {
  if (!raw) return [];
  const parsed = readArray(raw);
  if (!parsed.every(isArticle))
    throw new Error("저장된 콘텐츠 형식을 읽을 수 없습니다.");
  return parsed;
}
/** Reads v1 data (3-step status) and converts it to the lifecycle model. */
export function parseLegacyArticles(raw: string | null): Article[] {
  if (!raw) return [];
  return readArray(raw).map((value) => {
    const a = (value && typeof value === "object" ? value : {}) as Record<
      string,
      unknown
    >;
    if (
      !hasArticleFields(a) ||
      !legacyStatuses.includes(a.status as LegacyStatus)
    )
      throw new Error("이전 버전 콘텐츠 형식을 읽을 수 없습니다.");
    return {
      ...(a as unknown as Article),
      status: localToLifecycle(a.status as LegacyStatus),
    };
  });
}
/** v2 wins when present; otherwise v1 is migrated in memory (v1 stays untouched). */
export function loadArticles(
  current: string | null,
  legacy: string | null,
): Article[] {
  return current !== null ? parseArticles(current) : parseLegacyArticles(legacy);
}
/** Content approved and not changed since: HTML export is allowed. */
export function isApprovedContent(article: Article) {
  return requiresApproval.includes(article.status);
}
export function reviewErrors(article: Article): string[] {
  const errors: string[] = [];
  if (!article.title.trim()) errors.push("제목을 입력해주세요.");
  const content = article.body
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .join("")
    .trim();
  if (!content) errors.push("템플릿의 빈 항목에 실제 본문을 작성해주세요.");
  // AI drafts mark what they could not verify; these must be resolved by a person.
  if (/\[(출처 )?확인 필요|\[직접 경험 작성/.test(article.body))
    errors.push("AI 초안의 [확인 필요] 표시를 모두 확인하고 지워주세요.");
  try {
    const url = new URL(article.sourceUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
  } catch {
    errors.push("근거 자료의 http/https URL을 입력해주세요.");
  }
  return errors;
}
/** Anything that is part of the approved output, including how it is displayed. */
export function contentChanged(a: Article, b: Article) {
  return (
    ["title", "body", "sourceUrl", "keyword", "templateId", "platform"].some(
      (key) => a[key as keyof Article] !== b[key as keyof Article],
    ) ||
    (a.layoutProfile ?? DEFAULT_LAYOUT) !== (b.layoutProfile ?? DEFAULT_LAYOUT) ||
    (a.adProfile ?? DEFAULT_AD) !== (b.adProfile ?? DEFAULT_AD) ||
    (a.briefPurpose ?? "") !== (b.briefPurpose ?? "") ||
    (a.briefAudience ?? "") !== (b.briefAudience ?? "")
  );
}
export function saveRevision(article: Article, previous?: Article): Article {
  const changed = previous && contentChanged(article, previous);
  return {
    ...article,
    status: changed ? afterEdit(article.status) : article.status,
    updatedAt: new Date().toISOString(),
  };
}
export function exportHtml(article: Article): string {
  if (!isApprovedContent(article))
    throw new Error("승인된 콘텐츠만 HTML로 내보낼 수 있습니다.");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escapeHtml(article.title)}</title><article><h1>${escapeHtml(article.title)}</h1>${renderFragment(article)}</article></html>`;
}
export function templateName(article: Article) {
  return findTemplate(article.templateId).name;
}
