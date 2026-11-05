import { findTemplate, templates } from "./templates";
import {
  afterEdit,
  isLifecycleState,
  legacyStatuses,
  localToLifecycle,
  requiresApproval,
  type LegacyStatus,
  type LifecycleState,
} from "./lifecycle";

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
};
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
  return hasArticleFields(a) && isLifecycleState(a.status) && isRemote(a.remote);
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
export function saveRevision(article: Article, previous?: Article): Article {
  const changed =
    previous &&
    ["title", "body", "sourceUrl", "keyword", "templateId", "platform"].some(
      (key) => article[key as keyof Article] !== previous[key as keyof Article],
    );
  return {
    ...article,
    status: changed ? afterEdit(article.status) : article.status,
    updatedAt: new Date().toISOString(),
  };
}
export function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function exportHtml(article: Article): string {
  if (!isApprovedContent(article))
    throw new Error("승인된 콘텐츠만 HTML로 내보낼 수 있습니다.");
  const body = article.body
    .split("\n")
    .map((line) =>
      line.startsWith("## ")
        ? `<h2>${escapeHtml(line.slice(3))}</h2>`
        : line.startsWith("# ")
          ? `<h2>${escapeHtml(line.slice(2))}</h2>`
          : line.trim()
            ? `<p>${escapeHtml(line)}</p>`
            : "",
    )
    .join("\n");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escapeHtml(article.title)}</title><article><h1>${escapeHtml(article.title)}</h1>${body}<p>출처: ${escapeHtml(article.sourceUrl)}</p></article></html>`;
}
export function templateName(article: Article) {
  return findTemplate(article.templateId).name;
}
