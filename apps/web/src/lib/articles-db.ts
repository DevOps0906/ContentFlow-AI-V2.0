// Mapping between the app's Article and the `articles` table (migration 0002).
import { ARCHIVED_BLOG_MESSAGE } from "./blogs-db";
import { isArticle, isReviewStatus, reviewErrors, type Article, type ReviewStatus } from "./content";
import type { LifecycleState } from "./lifecycle";
import { afterEdit } from "./lifecycle";
import { DEFAULT_AD, DEFAULT_LAYOUT, RENDERER_VERSION, type AdProfile, type LayoutProfile } from "./render";
import { templateVersion } from "./templates";
import type { TitleEvaluationEntry } from "./titles";

export const ARTICLE_COLUMNS =
  "id,title,keyword,template_id,platform,body,source_url,state,updated_at,remote,keyword_id,published_url,layout_profile,ad_profile,renderer_version,brief_purpose,brief_audience,evidence_status,rights_status,title_evaluation,template_version,blog_id";

export type ArticleRow = {
  id: string;
  title: string;
  keyword: string;
  template_id: string;
  platform: Article["platform"];
  body: string;
  source_url: string;
  state: LifecycleState;
  updated_at: string;
  remote: Article["remote"] | null;
  keyword_id: string | null;
  published_url: string | null;
  layout_profile: LayoutProfile;
  ad_profile: AdProfile;
  renderer_version: string | null;
  brief_purpose: string;
  brief_audience: string;
  evidence_status: ReviewStatus;
  rights_status: ReviewStatus;
  title_evaluation: TitleEvaluationEntry[] | null;
  template_version: string | null;
  blog_id: string | null;
};

export function rowToArticle(r: ArticleRow): Article {
  const a: Article = {
    id: r.id,
    title: r.title,
    keyword: r.keyword,
    templateId: r.template_id,
    platform: r.platform,
    body: r.body,
    sourceUrl: r.source_url,
    status: r.state,
    updatedAt: r.updated_at,
    layoutProfile: r.layout_profile ?? DEFAULT_LAYOUT,
    adProfile: r.ad_profile ?? DEFAULT_AD,
  };
  if (r.remote) a.remote = r.remote;
  if (r.keyword_id) a.keywordId = r.keyword_id;
  if (r.published_url) a.publishedUrl = r.published_url;
  if (r.renderer_version) a.rendererVersion = r.renderer_version;
  if (r.brief_purpose) a.briefPurpose = r.brief_purpose;
  if (r.brief_audience) a.briefAudience = r.brief_audience;
  if (r.evidence_status !== "unreviewed") a.evidenceStatus = r.evidence_status;
  if (r.rights_status !== "unreviewed") a.rightsStatus = r.rights_status;
  if (r.title_evaluation) a.titleEvaluation = r.title_evaluation;
  if (r.template_version) a.templateVersion = r.template_version;
  if (r.blog_id) a.blogId = r.blog_id;
  return a;
}

/**
 * Editable columns. `remote` is deliberately absent: only the WordPress route sets it.
 * `keyword_id` is written only when the article carries one (the database checks that the
 * keyword belongs to the same workspace); it is never cleared by a save that omits it.
 * `blog_id` follows the same rule, except that an explicit `null` clears it (unclassified).
 * `published_url` is sent only for a published article; the trigger decides whether it may change.
 * Profiles are written only when present, so older clients can not reset them by omission.
 * `renderer_version` is deliberately absent: see `approvalFields`.
 * `evidence_status` and `rights_status` are deliberately absent: only the review route writes them.
 * `template_version` is deliberately absent: see `templateVersionFields`.
 */
export function articleToFields(a: Article) {
  return {
    ...(a.briefPurpose !== undefined ? { brief_purpose: a.briefPurpose } : {}),
    ...(a.briefAudience !== undefined ? { brief_audience: a.briefAudience } : {}),
    ...(a.titleEvaluation !== undefined ? { title_evaluation: a.titleEvaluation } : {}),
    ...(a.keywordId !== undefined && isUuid(a.keywordId) ? { keyword_id: a.keywordId } : {}),
    ...(a.blogId === null || (a.blogId !== undefined && isUuid(a.blogId)) ? { blog_id: a.blogId } : {}),
    ...(a.status === "published" && a.publishedUrl !== undefined ? { published_url: a.publishedUrl } : {}),
    ...(a.layoutProfile !== undefined ? { layout_profile: a.layoutProfile } : {}),
    ...(a.adProfile !== undefined ? { ad_profile: a.adProfile } : {}),
    title: a.title,
    keyword: a.keyword,
    template_id: a.templateId,
    platform: a.platform,
    body: a.body,
    source_url: a.sourceUrl,
    state: a.status,
  };
}

/**
 * Fields the server adds to an update that approves the stored article: the renderer this
 * deployment runs. A version sent by the client is never read.
 */
export function approvalFields(requested: LifecycleState, stored: LifecycleState | undefined) {
  return requested === "approved" && stored !== undefined && stored !== "approved"
    ? { renderer_version: RENDERER_VERSION }
    : {};
}

/** First reason the server refuses a transition into `approved` (missing blocks, empty body, ...). */
export function approvalRejection(article: Article, stored: LifecycleState | undefined): string | undefined {
  return article.status === "approved" && stored !== "approved" ? reviewErrors(article)[0] : undefined;
}

/**
 * Pins the version this deployment has for the template, on a new article or when the template
 * changes. Otherwise nothing is written, so older articles stay NULL. A client value is never read.
 */
export function templateVersionFields(templateId: string, stored?: { template_id: string } | null) {
  return stored && stored.template_id === templateId ? {} : { template_version: templateVersion(templateId) ?? null };
}

export type ReviewDecision = { evidenceStatus: ReviewStatus; rightsStatus: ReviewStatus };
export function parseReviewDecision(body: unknown): ReviewDecision {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isReviewStatus(b.evidenceStatus) || !isReviewStatus(b.rightsStatus))
    throw new Error("근거·권리 상태 값이 올바르지 않습니다.");
  return { evidenceStatus: b.evidenceStatus, rightsStatus: b.rightsStatus };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

export function parseIncomingArticle(body: unknown): Article {
  if (!isArticle(body)) throw new Error("콘텐츠 형식이 올바르지 않습니다.");
  return body;
}

/**
 * Local data has no approval snapshots, so anything reviewed or later is imported as
 * `drafting` and has to be reviewed and approved again. Invalid ids are replaced.
 */
export function toImportable(a: Article): Article {
  // Browser-local ids (remote draft, keyword, blog) mean nothing in the account.
  const { remote: _remote, keywordId: _keywordId, blogId: _blogId, publishedUrl: _publishedUrl, rendererVersion: _rendererVersion, ...rest } = a;
  void _remote;
  void _keywordId;
  void _blogId;
  void _publishedUrl;
  void _rendererVersion;
  return {
    ...rest,
    id: isUuid(a.id) ? a.id : crypto.randomUUID(),
    status: afterEdit(a.status),
  };
}

/** Maps a PostgREST/trigger error to a user-facing status and message. */
export function dbError(error: { code?: string; message?: string }): {
  status: number;
  message: string;
} {
  if (error.code === "42501")
    return { status: 403, message: "이 작업을 할 권한이 없습니다." };
  if (error.code === "P0001" && /archived/.test(error.message ?? ""))
    return { status: 409, message: ARCHIVED_BLOG_MESSAGE };
  if (error.code === "P0001")
    return {
      status: 409,
      message: `상태 규칙에 맞지 않아 저장하지 못했습니다. (${error.message ?? ""})`.trim(),
    };
  if (error.code === "23514")
    return { status: 422, message: "입력 값이 허용 범위를 벗어났습니다." };
  if (error.code === "23503")
    return { status: 422, message: "연결할 항목을 이 워크스페이스에서 찾을 수 없습니다." };
  return { status: 500, message: "저장소 처리 중 오류가 발생했습니다." };
}
