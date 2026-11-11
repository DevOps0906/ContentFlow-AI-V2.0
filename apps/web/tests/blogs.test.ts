import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_BLOGS,
  BLOG_PLATFORMS,
  BLOG_STATUSES,
  blogName,
  blogOptionLabel,
  dbToBlog,
  matchesBlogFilter,
  parseBlog,
  parseBlogLink,
  parseBlogUpdate,
  selectableBlogs,
  UNCLASSIFIED_BLOGS,
  type Blog,
} from "../src/lib/blogs";
import { ARTICLE_COLUMNS, articleToFields, dbError, rowToArticle, toImportable, type ArticleRow } from "../src/lib/articles-db";
import { isArticle, saveRevision, contentChanged, type Article } from "../src/lib/content";
import { KEYWORD_COLUMNS, rowToKeyword } from "../src/lib/keywords-db";
import { ideaFromKeyword, isKeyword } from "../src/lib/keywords";
import { filterRevenueByBlog, summarize, unallocatedRevenue, type RevenueRow } from "../src/lib/revenue";
import { canManageBlogs, roles } from "../src/lib/team";
import { BlogFilter } from "../src/components/blog-filter";
import { BlogAccounts } from "../src/components/blog-accounts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

test("platforms and statuses match the database", () => {
  const enumSql = read("../../../supabase/migrations/0001_core_tenancy.sql").match(/blog_platform as enum \(([^)]*)\)/)![1];
  assert.deepEqual(quoted(enumSql), [...BLOG_PLATFORMS].sort());
  const statusSql = read("../../../supabase/migrations/0015_blog_accounts.sql").match(/status in \(([^)]*)\)/)![1];
  assert.deepEqual(quoted(statusSql), [...BLOG_STATUSES].sort());
});

test("only owner and admin manage blog accounts", () => {
  assert.deepEqual(roles.filter((r) => canManageBlogs(r)), ["owner", "admin"]);
  assert.equal(canManageBlogs(null), false);
});

test("a blog needs a platform, an address and a display name", () => {
  assert.deepEqual(parseBlog({ platform: "tistory", domain: " https://MyBlog.tistory.com/ ", displayName: " 내 블로그 " }), {
    platform: "tistory",
    domain: "myblog.tistory.com",
    display_name: "내 블로그",
  });
  assert.equal(parseBlog({ platform: "naver", domain: "blog.naver.com/myid", displayName: "a" }).domain, "blog.naver.com/myid");
  const ok = { platform: "naver", domain: "a.example", displayName: "a" };
  for (const bad of [
    null,
    { ...ok, platform: "medium" },
    { ...ok, domain: "" },
    { ...ok, domain: "no-dot" },
    { ...ok, domain: "a b.example" },
    { ...ok, domain: "user:pw@a.example" },
    { ...ok, domain: `a.example/${"x".repeat(200)}` },
    { ...ok, displayName: "   " },
    { ...ok, displayName: "x".repeat(61) },
  ])
    assert.throws(() => parseBlog(bad), JSON.stringify(bad)?.slice(0, 40));
});

test("an update is an edit or a status change, and never moves the workspace", () => {
  assert.deepEqual(parseBlogUpdate({ id: ID, status: "archived", displayName: "ignored" }), { id: ID, fields: { status: "archived" } });
  const edit = parseBlogUpdate({ id: ID, platform: "blogger", domain: "a.example", displayName: "a", workspace_id: ID2 });
  assert.deepEqual(edit.fields, { platform: "blogger", domain: "a.example", display_name: "a" });
  assert.throws(() => parseBlogUpdate({ id: "x", status: "active" }));
  assert.throws(() => parseBlogUpdate({ id: ID, status: "deleted" }));
  assert.throws(() => parseBlogUpdate({ id: ID }));
});

test("a link request names an account or clears the link", () => {
  assert.equal(parseBlogLink({ blogId: ID }), ID);
  assert.equal(parseBlogLink({ blogId: null }), null);
  for (const bad of [null, {}, { blogId: "x" }, { blogId: 1 }, { blogId: "" }]) assert.throws(() => parseBlogLink(bad));
});

const blog = (id: string, over: Partial<Blog> = {}): Blog => ({
  id, platform: "naver", domain: "a.example", displayName: "A", status: "active", createdAt: "2026-11-01T00:00:00Z", ...over,
});

test("older rows show the domain and unknown statuses read as active", () => {
  const b = dbToBlog({ id: ID, platform: "naver", domain: "a.example", display_name: null, status: "paused", created_at: "t" });
  assert.equal(b.status, "active");
  assert.equal(blogName(b), "a.example");
  assert.equal(blogOptionLabel(blog(ID, { status: "archived" })), "A (보관됨)");
});

test("archived accounts can not be picked unless already linked", () => {
  const list = [blog("a"), blog("b", { status: "archived" })];
  assert.deepEqual(selectableBlogs(list).map((b) => b.id), ["a"]);
  assert.deepEqual(selectableBlogs(list, "b").map((b) => b.id), ["a", "b"]);
});

test("the filter separates all, one account and unclassified", () => {
  assert.equal(matchesBlogFilter(null, ALL_BLOGS), true);
  assert.equal(matchesBlogFilter("a", ALL_BLOGS), true);
  assert.equal(matchesBlogFilter(null, UNCLASSIFIED_BLOGS), true);
  assert.equal(matchesBlogFilter(undefined, UNCLASSIFIED_BLOGS), true);
  assert.equal(matchesBlogFilter("a", UNCLASSIFIED_BLOGS), false);
  assert.equal(matchesBlogFilter("a", "a"), true);
  assert.equal(matchesBlogFilter("b", "a"), false);
  assert.equal(matchesBlogFilter(null, "a"), false);
});

const row = (page: string, revenue = 10): RevenueRow => ({
  source: "AdSense", status: "estimated", currency: "KRW", date: "2026-11-01", page, revenue, pageviews: 100,
  impressions: null, clicks: null, importedAt: "2026-11-02T00:00:00Z", timezone: "Asia/Seoul", periodStart: "2026-11-01", periodEnd: "2026-11-01",
});
const article = (id: string, over: Partial<Article>): Article => ({
  id, title: "t", keyword: "k", templateId: "T01", platform: "wordpress", body: "b", sourceUrl: "", status: "published",
  updatedAt: "2026-11-01T00:00:00Z", ...over,
});
const articles = [
  article("a1", { publishedUrl: "https://a.example/one/", blogId: "blog-a" }),
  article("a2", { publishedUrl: "https://b.example/two", blogId: "blog-b" }),
  article("a3", { publishedUrl: "https://a.example/no-blog" }),
  article("a4", { remote: { postId: 1, url: "https://a.example/draft", syncedAt: "t" }, blogId: "blog-a" }),
  article("a5", { publishedUrl: "https://a.example/shared", blogId: "blog-a" }),
  article("a6", { publishedUrl: "https://a.example/shared", blogId: "blog-b" }),
];
const reports = [
  row("https://a.example/one"),
  row("https://b.example/two?utm=x"),
  row("https://a.example/no-blog"),
  row("https://a.example/draft"),
  row("https://a.example/shared"),
  row("https://a.example/unknown"),
];
const pagesOf = (filter: string) => filterRevenueByBlog(reports, articles, filter).map((r) => r.page);

test("revenue rows follow the blog of the article with that public URL", () => {
  assert.deepEqual(pagesOf("blog-a"), ["https://a.example/one", "https://a.example/draft"]); // draft link is the fallback
  assert.deepEqual(pagesOf("blog-b"), ["https://b.example/two?utm=x"]);
  assert.equal(filterRevenueByBlog(reports, articles, ALL_BLOGS), reports);
});

test("rows that can not be attributed are unclassified", () => {
  assert.deepEqual(pagesOf(UNCLASSIFIED_BLOGS), [
    "https://a.example/no-blog", // the article has no account
    "https://a.example/shared", // two accounts claim the URL
    "https://a.example/unknown", // no article
  ]);
});

test("site totals belong to no account filter and are shown apart as the unallocated total", () => {
  const site = [row(""), row("https://a.example/one")];
  assert.deepEqual(filterRevenueByBlog(site, articles, "blog-a").map((r) => r.page), ["https://a.example/one"]);
  assert.deepEqual(filterRevenueByBlog(site, articles, UNCLASSIFIED_BLOGS).map((r) => r.page), []);
  assert.equal(summarize(filterRevenueByBlog(site, articles, "blog-a"))[0].revenue, 10);
  assert.deepEqual(unallocatedRevenue(site).map((r) => r.page), [""]);
  assert.equal(summarize(unallocatedRevenue(site))[0].revenue, 10);
  // no overlap: every page row is in exactly one of the account filters, the site row in none
  const filters = ["blog-a", "blog-b", UNCLASSIFIED_BLOGS];
  const placed = filters.flatMap((f) => filterRevenueByBlog(site, articles, f));
  assert.equal(placed.length, 1);
});

test("a published URL wins over a remote URL, which only fills what no published article claims", () => {
  const list = [
    article("p", { publishedUrl: "https://x.example/p", blogId: "blog-a" }),
    article("r1", { remote: { postId: 1, url: "https://x.example/p", syncedAt: "t" }, blogId: "blog-b" }),
    article("r2", { remote: { postId: 2, url: "https://x.example/r", syncedAt: "t" }, blogId: "blog-b" }),
  ];
  const rows = [row("https://x.example/p"), row("https://x.example/r")];
  assert.deepEqual(filterRevenueByBlog(rows, list, "blog-a").map((r) => r.page), ["https://x.example/p"]);
  assert.deepEqual(filterRevenueByBlog(rows, list, "blog-b").map((r) => r.page), ["https://x.example/r"]);
});

test("a filter with no rows gives no summary rather than a zero", () => {
  assert.deepEqual(summarize(filterRevenueByBlog(reports, articles, "blog-empty")), []);
});

const base: Article = article(ID, { status: "drafting" });

test("the article keeps, sets or clears its account in the mapping", () => {
  assert.ok(ARTICLE_COLUMNS.split(",").includes("blog_id"));
  assert.ok(!("blog_id" in articleToFields(base)));
  assert.equal(articleToFields({ ...base, blogId: ID2 }).blog_id, ID2);
  assert.equal(articleToFields({ ...base, blogId: null }).blog_id, null);
  assert.ok(!("blog_id" in articleToFields({ ...base, blogId: "local-id" })));
  assert.equal(rowToArticle({ blog_id: ID2 } as ArticleRow).blogId, ID2);
  assert.equal(rowToArticle({ blog_id: null } as ArticleRow).blogId, undefined);
});

test("browser data can not carry an account into the workspace", () => {
  assert.equal(toImportable({ ...base, blogId: ID2 }).blogId, undefined);
  assert.equal(isArticle({ ...base, blogId: null }), true);
  assert.equal(isArticle({ ...base, blogId: 7 }), false);
});

test("changing the account is not an edit, so the approval stays", () => {
  const approved = article(ID, { status: "approved" });
  const moved = { ...approved, blogId: ID2 };
  assert.equal(contentChanged(moved, approved), false);
  assert.equal(saveRevision(moved, approved).status, "approved");
});

test("a keyword carries its account into the mapping and a new article", () => {
  assert.ok(KEYWORD_COLUMNS.split(",").includes("blog_id"));
  const stored = { id: ID, phrase: "a", intent: "", priority: 3, note: "", created_at: "2026-11-01T00:00:00Z" };
  assert.equal(rowToKeyword({ ...stored, blog_id: ID2 }).blogId, ID2);
  assert.ok(!("blogId" in rowToKeyword({ ...stored, blog_id: null })));
  assert.equal(isKeyword(rowToKeyword({ ...stored, blog_id: ID2 })), true);
  assert.equal(ideaFromKeyword("키워드", { blogId: ID2 }).blogId, ID2);
  assert.ok(!("blogId" in ideaFromKeyword("키워드")));
});

test("a link that fails the foreign key is reported as input, not a server fault", () => {
  assert.equal(dbError({ code: "23503" }).status, 422);
});

test("the filter offers all and unclassified, and explains local mode", () => {
  const html = renderToStaticMarkup(createElement(BlogFilter, { account: true, value: ALL_BLOGS, onChange: () => {} }));
  assert.match(html, /<label for="blog-filter">블로그 계정<\/label>/);
  assert.match(html, /<option value="all"[^>]*>전체<\/option>/);
  assert.match(html, /<option value="unclassified">미분류<\/option>/);
  const local = renderToStaticMarkup(createElement(BlogFilter, { account: false, value: ALL_BLOGS, onChange: () => {} }));
  assert.match(local, /계정 모드에서 사용 가능/);
  assert.doesNotMatch(local, /<select/);
});

test("account management explains local mode and claims no connection", () => {
  assert.match(renderToStaticMarkup(createElement(BlogAccounts, { account: false })), /계정 모드에서 사용 가능/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(BlogAccounts, { account: true })), /연결됨/);
});
