import { findTemplate, templates } from "./templates";

export type ArticleStatus = "draft" | "review" | "approved";
export type Article = {
  id: string;
  title: string;
  keyword: string;
  templateId: string;
  platform: "wordpress" | "tistory" | "blogger" | "naver";
  body: string;
  sourceUrl: string;
  status: ArticleStatus;
  updatedAt: string;
};
export const STORAGE_KEY = "contentflow.articles.v1";
export const statusLabels: Record<ArticleStatus, string> = {
  draft: "작성 중",
  review: "검수 대기",
  approved: "승인 완료",
};

export function isArticle(value: unknown): value is Article {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    ["id", "title", "keyword", "body", "sourceUrl", "updatedAt"].every(
      (k) => typeof a[k] === "string",
    ) &&
    templates.some((t) => t.id === a.templateId) &&
    ["wordpress", "tistory", "blogger", "naver"].includes(String(a.platform)) &&
    ["draft", "review", "approved"].includes(String(a.status)) &&
    !Number.isNaN(Date.parse(String(a.updatedAt)))
  );
}
export function parseArticles(raw: string | null): Article[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isArticle))
    throw new Error("저장된 콘텐츠 형식을 읽을 수 없습니다.");
  return parsed;
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
    status: changed ? "draft" : article.status,
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
  if (article.status !== "approved")
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
