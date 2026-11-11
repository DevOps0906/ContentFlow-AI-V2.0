import { test } from "node:test";
import assert from "node:assert/strict";
import { appOrigin, parseCredentials, parseEmail, parseNewPassword, safeNext } from "../src/lib/auth";
import {
  articleToFields,
  dbError,
  isUuid,
  parseIncomingArticle,
  rowToArticle,
  toImportable,
  type ArticleRow,
} from "../src/lib/articles-db";
import { sessionCookieOptions, supabaseEnv } from "../src/lib/supabase";
import type { Article } from "../src/lib/content";

const article: Article = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  title: "제목",
  keyword: "키워드",
  templateId: "T02",
  platform: "wordpress",
  body: "## 해결\n본문",
  sourceUrl: "https://example.com/doc",
  status: "approved",
  updatedAt: "2026-11-06T00:00:00Z",
  remote: { postId: 7, url: "https://x/?p=7", syncedAt: "2026-11-06T00:00:00Z" },
  layoutProfile: "L01",
  adProfile: "A00",
};

test("credentials: signup enforces the password policy, login only bounds input", () => {
  assert.deepEqual(parseCredentials({ email: " A@B.co ", password: "12345678" }, { strict: true }), {
    email: "a@b.co",
    password: "12345678",
  });
  assert.throws(() => parseCredentials({ email: "a@b.co", password: "short" }, { strict: true }));
  assert.throws(() => parseCredentials({ email: "a@b.co", password: "x".repeat(73) }, { strict: true }));
  assert.doesNotThrow(() => parseCredentials({ email: "a@b.co", password: "short" }, { strict: false }));
  assert.throws(() => parseCredentials({ email: "not-an-email", password: "12345678" }, { strict: false }));
  assert.throws(() => parseCredentials({ email: "a@b.co" }, { strict: false }));
  assert.throws(() => parseCredentials(null, { strict: false }));
});

test("post-login redirect only accepts same-site relative paths", () => {
  assert.equal(safeNext("/content?q=1"), "/content?q=1");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:1", "", null, undefined])
    assert.equal(safeNext(bad as string | null), "/");
});

test("session cookies are httpOnly, lax and Secure only when configured", () => {
  const off = sessionCookieOptions({} as NodeJS.ProcessEnv);
  assert.equal(off.httpOnly, true);
  assert.equal(off.sameSite, "lax");
  assert.equal(off.secure, false);
  assert.equal(sessionCookieOptions({ COOKIE_SECURE: "true" } as unknown as NodeJS.ProcessEnv).secure, true);
});

test("supabase is only configured when both URL and key are present", () => {
  assert.equal(supabaseEnv({} as NodeJS.ProcessEnv), null);
  assert.equal(supabaseEnv({ SUPABASE_URL: "http://x" } as unknown as NodeJS.ProcessEnv), null);
  assert.deepEqual(
    supabaseEnv({ SUPABASE_URL: " http://x ", SUPABASE_PUBLISHABLE_KEY: "k" } as unknown as NodeJS.ProcessEnv),
    { url: "http://x", key: "k" },
  );
});

test("row ↔ article mapping keeps remote info but never writes it from the browser", () => {
  const row: ArticleRow = {
    id: article.id,
    title: article.title,
    keyword: article.keyword,
    template_id: article.templateId,
    platform: article.platform,
    body: article.body,
    source_url: article.sourceUrl,
    state: article.status,
    updated_at: article.updatedAt,
    remote: article.remote ?? null,
    keyword_id: null,
    published_url: null,
    layout_profile: "L01",
    ad_profile: "A00",
    renderer_version: null,
    brief_purpose: "",
    brief_audience: "",
    evidence_status: "unreviewed",
    rights_status: "unreviewed",
    title_evaluation: null,
    template_version: null,
    blog_id: null,
  };
  assert.deepEqual(rowToArticle(row), article);
  assert.equal(rowToArticle({ ...row, published_url: "https://blog.example/p" }).publishedUrl, "https://blog.example/p");
  assert.equal(articleToFields({ ...article, status: "published", publishedUrl: "https://blog.example/p" }).published_url, "https://blog.example/p");
  assert.ok(!("published_url" in articleToFields({ ...article, status: "drafting", publishedUrl: "https://blog.example/p" })));
  assert.deepEqual(rowToArticle({ ...row, remote: null }).remote, undefined);
  assert.equal(rowToArticle({ ...row, keyword_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).keywordId, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
  assert.equal(articleToFields({ ...article, keywordId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).keyword_id, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
  assert.ok(!("keyword_id" in articleToFields(article)), "a save without a link never clears it");
  assert.ok(!("keyword_id" in articleToFields({ ...article, keywordId: "not-a-uuid" })));
  const fields = articleToFields(article);
  assert.ok(!("remote" in fields));
  assert.ok(!("id" in fields) && !("workspace_id" in fields) && !("owner_id" in fields));
  assert.equal(fields.state, "approved");
});

test("incoming articles are validated and ids must be uuids", () => {
  assert.throws(() => parseIncomingArticle({ ...article, status: "hacked" }));
  assert.throws(() => parseIncomingArticle(null));
  assert.equal(parseIncomingArticle(article).id, article.id);
  assert.ok(isUuid(article.id));
  assert.ok(!isUuid("demo-1") && !isUuid("../etc/passwd") && !isUuid(""));
});

test("import resets reviewed/approved/published content and drops remote info", () => {
  const imported = toImportable(article);
  assert.equal(imported.status, "drafting");
  assert.equal(imported.remote, undefined);
  assert.equal(toImportable({ ...article, keywordId: "browser-local-id" }).keywordId, undefined);
  assert.equal(toImportable({ ...article, status: "idea" }).status, "idea");
  assert.equal(toImportable({ ...article, status: "approval_pending" }).status, "drafting");
  const fresh = toImportable({ ...article, id: "demo-1" });
  assert.ok(isUuid(fresh.id));
});

test("database errors map to safe user messages", () => {
  assert.equal(dbError({ code: "42501" }).status, 403);
  assert.equal(dbError({ code: "P0001", message: "state change not allowed" }).status, 409);
  assert.equal(dbError({ code: "23514" }).status, 422);
  const other = dbError({ code: "XX000", message: "relation secret_table does not exist" });
  assert.equal(other.status, 500);
  assert.ok(!other.message.includes("secret_table"));
});
test("password reset input is validated and e-mail links use a trusted origin", () => {
  assert.equal(parseEmail({ email: " A@B.co " }), "a@b.co");
  for (const bad of [null, {}, { email: 1 }, { email: "nope" }, { email: `${"a".repeat(250)}@b.co` }]) assert.throws(() => parseEmail(bad));
  assert.equal(parseNewPassword({ password: "12345678" }), "12345678");
  for (const bad of [null, {}, { password: "short" }, { password: "x".repeat(73) }, { password: 12345678 }]) assert.throws(() => parseNewPassword(bad));
  const req = (origin: string | null) => new Request("http://internal:3000/api/auth/reset", { method: "POST", headers: origin ? { origin } : {} });
  assert.equal(appOrigin(req("https://app.example.com"), {} as NodeJS.ProcessEnv), "https://app.example.com");
  assert.equal(appOrigin(req("https://evil.example"), { APP_URL: "https://app.example.com/" } as unknown as NodeJS.ProcessEnv), "https://app.example.com");
  assert.equal(appOrigin(req(null), {} as NodeJS.ProcessEnv), "http://internal:3000");
});
