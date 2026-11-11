// Blog accounts of a workspace (`blogs`, migrations 0001 and 0015) and the shared blog filter rule.
import { isUuid } from "./articles-db";

// Keep in sync with the blog_platform enum and the blogs_status_known check (a test compares them).
export const BLOG_PLATFORMS = ["naver", "tistory", "wordpress", "blogger"] as const;
export type BlogPlatform = (typeof BLOG_PLATFORMS)[number];
export const blogPlatformLabels: Record<BlogPlatform, string> = {
  naver: "네이버 블로그",
  tistory: "티스토리",
  wordpress: "WordPress",
  blogger: "Blogger",
};
export const BLOG_STATUSES = ["active", "archived"] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export type Blog = {
  id: string;
  platform: BlogPlatform;
  domain: string;
  /** Absent on rows made before migration 0015: `blogName` shows the domain instead. */
  displayName: string | null;
  status: BlogStatus;
  createdAt: string;
};
export const BLOG_COLUMNS = "id,platform,domain,display_name,status,created_at";
export type BlogDbRow = {
  id: string;
  platform: BlogPlatform;
  domain: string;
  display_name: string | null;
  status: string;
  created_at: string;
};
export const dbToBlog = (r: BlogDbRow): Blog => ({
  id: r.id,
  platform: r.platform,
  domain: r.domain,
  displayName: r.display_name,
  status: r.status === "archived" ? "archived" : "active",
  createdAt: r.created_at,
});

export const blogName = (b: Pick<Blog, "displayName" | "domain">) => b.displayName ?? b.domain;
export const blogOptionLabel = (b: Blog) => `${blogName(b)}${b.status === "archived" ? " (보관됨)" : ""}`;

/** Accounts that can be picked: the active ones, plus the current one if it has been archived. */
export const selectableBlogs = (blogs: Blog[], currentId?: string | null) =>
  blogs.filter((b) => b.status === "active" || b.id === currentId);

function parseDomain(value: unknown): string {
  const text = typeof value === "string" ? value.trim().replace(/^https?:\/\//i, "") : "";
  let url: URL | null = null;
  try {
    if (text && !/\s/.test(text)) url = new URL(`https://${text}`);
  } catch {}
  if (!url || url.username || url.password || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(url.hostname))
    throw new Error("블로그 주소를 예: myblog.tistory.com 형식으로 입력해주세요.");
  const domain = url.host + url.pathname.replace(/\/+$/, "");
  if (domain.length > 200) throw new Error("블로그 주소는 200자까지 입력할 수 있습니다.");
  return domain;
}
function parseDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60) throw new Error("표시 이름은 1~60자로 입력해주세요.");
  return name;
}
function parsePlatform(value: unknown): BlogPlatform {
  if (!BLOG_PLATFORMS.includes(value as BlogPlatform)) throw new Error("플랫폼을 선택해주세요.");
  return value as BlogPlatform;
}

export type BlogFields = { platform: BlogPlatform; domain: string; display_name: string };
export function parseBlog(input: unknown): BlogFields {
  const b = (input ?? {}) as Record<string, unknown>;
  return { platform: parsePlatform(b.platform), domain: parseDomain(b.domain), display_name: parseDisplayName(b.displayName) };
}

export type BlogUpdate = { id: string; fields: BlogFields | { status: BlogStatus } };
/** Either an edit of the account (platform, address, name) or a change of status, never both. */
export function parseBlogUpdate(input: unknown): BlogUpdate {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || !isUuid(b.id)) throw new Error("잘못된 블로그 ID입니다.");
  if (b.status === undefined) return { id: b.id, fields: parseBlog(b) };
  if (!BLOG_STATUSES.includes(b.status as BlogStatus)) throw new Error("블로그 상태 값이 올바르지 않습니다.");
  return { id: b.id, fields: { status: b.status as BlogStatus } };
}

/** The account in a link request: `null` clears the link (unclassified). */
export function parseBlogLink(input: unknown): string | null {
  const id = ((input ?? {}) as Record<string, unknown>).blogId;
  if (id === null) return null;
  if (typeof id !== "string" || !isUuid(id)) throw new Error("잘못된 블로그 ID입니다.");
  return id;
}

export const ALL_BLOGS = "all";
export const UNCLASSIFIED_BLOGS = "unclassified";
/** `ALL_BLOGS`, `UNCLASSIFIED_BLOGS` or the id of one account. */
export type BlogFilterValue = string;

export function matchesBlogFilter(blogId: string | null | undefined, filter: BlogFilterValue) {
  if (filter === ALL_BLOGS) return true;
  if (filter === UNCLASSIFIED_BLOGS) return !blogId;
  return blogId === filter;
}
