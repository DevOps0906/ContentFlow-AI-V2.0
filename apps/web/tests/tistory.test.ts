import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPublishedUrlRule, isArticle, isPublishedUrl, type Article } from "../src/lib/content";
import { assertDeliverable } from "../src/lib/delivery";
import { toImportable } from "../src/lib/articles-db";
import { RENDERER_VERSION } from "../src/lib/render";
import { crc32, tistoryPackage, tistoryTags, zipStore } from "../src/lib/tistory";

const article: Article = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  title: "포트 오류 해결",
  keyword: "포트, Next.js, 포트",
  templateId: "T02",
  platform: "tistory",
  body: "## 해결\n포트 사용을 확인합니다.\n<script>x()</script>",
  sourceUrl: "https://example.com/source",
  status: "export_ready",
  updatedAt: "2026-11-06T00:00:00Z",
  rendererVersion: RENDERER_VERSION,
};
const url ="https://blog.example/p";

/** Reads a ZIP through its central directory, the way an unzip tool does. */
function unzip(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = data.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const files = new Map<string, string>();
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    assert.equal(view.getUint16(at + 10, true), 0, "stored, not compressed");
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength));
    const local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const content = data.subarray(start, start + size);
    assert.equal(crc32(content), view.getUint32(at + 16, true), name);
    files.set(name, new TextDecoder().decode(content));
    at += 46 + nameLength;
  }
  assert.equal(at, end, "central directory ends at the end record");
  return files;
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zipStore keeps UTF-8 content intact and is reproducible", () => {
  const files = [
    { name: "a.txt", content: "한글 content" },
    { name: "empty.txt", content: "" },
  ];
  const zip = zipStore(files);
  assert.deepEqual([...unzip(zip)], [["a.txt", "한글 content"], ["empty.txt", ""]]);
  assert.deepEqual(zipStore(files), zip);
});

test("the package holds escaped HTML, tags, metadata and a guide, and no images", async () => {
  const pack = await tistoryPackage(article);
  assert.equal(pack.name, `contentflow-${article.id}-tistory.zip`);
  const files = unzip(pack.data);
  assert.deepEqual([...files.keys()], ["article.html", "tags.txt", "meta.json", "README.txt"]);
  assert.ok(files.get("article.html")?.includes("<h2>해결</h2>"));
  assert.ok(files.get("article.html")?.includes("&lt;script&gt;"));
  assert.ok(!files.get("article.html")?.includes("<script>"));
  assert.equal(files.get("tags.txt"), "포트, Next.js");
  const meta = JSON.parse(String(files.get("meta.json")));
  assert.equal(meta.title, article.title);
  assert.equal(meta.sourceUrl, article.sourceUrl);
  assert.ok(files.get("README.txt")?.includes("자동으로 게시되지 않습니다"));
  assert.ok(files.get("README.txt")?.includes("이미지는 패키지에 포함되지 않습니다"));
});

test("an article that may not be delivered gets no package", async () => {
  await assert.rejects(tistoryPackage({ ...article, status: "approval_pending" }), /승인된 콘텐츠/);
  await assert.rejects(tistoryPackage({ ...article, sourceUrl: "javascript:1" }), /근거 자료/);
  await assert.rejects(assertDeliverable({ ...article, status: "drafting" }));
});

test("tags come from commas and line breaks, without blanks or repeats", () => {
  assert.deepEqual(tistoryTags(" a, b，c\nd,,a "), ["a", "b", "c", "d"]);
  assert.deepEqual(tistoryTags("  "), []);
});

test("public URLs must be http(s) without spaces", () => {
  for (const ok of ["https://x.example/a?b=1", "http://x.example", "HTTPS://x.example"]) assert.ok(isPublishedUrl(ok), ok);
  for (const bad of ["javascript:alert(1)", "ftp://x", "https://", "https://a b", "x.example", "", null, `https://x/${"a".repeat(2000)}`])
    assert.ok(!isPublishedUrl(bad), String(bad));
  assert.ok(isArticle({ ...article, publishedUrl: url }));
  assert.ok(!isArticle({ ...article, publishedUrl: "javascript:alert(1)" }));
});

test("local mode: the URL is written only by the transition into published", () => {
  const pending = { ...article, status: "manual_pending" as const };
  assert.equal(applyPublishedUrlRule({ ...pending, status: "published", publishedUrl: url }, pending).publishedUrl, url);
  assert.throws(() => applyPublishedUrlRule({ ...pending, status: "published" }, pending), /공개 URL/);
  assert.throws(() => applyPublishedUrlRule({ ...pending, status: "published", publishedUrl: "ftp://x" }, pending), /공개 URL/);
  assert.throws(() => applyPublishedUrlRule({ ...pending, publishedUrl: url }, pending), /게시 완료를 확인할 때만/);
  const published = { ...article, status: "published" as const, publishedUrl: url };
  assert.throws(() => applyPublishedUrlRule({ ...published, publishedUrl: `${url}2` }, published), /게시 완료를 확인할 때만/);
  assert.throws(() => applyPublishedUrlRule({ ...published, publishedUrl: undefined }, published), /게시 완료를 확인할 때만/);
});

test("local mode: going back to editing clears the URL; later states keep it; older rows may have none", () => {
  const published = { ...article, status: "published" as const, publishedUrl: url };
  assert.equal(applyPublishedUrlRule({ ...published, status: "monitoring" }, published).publishedUrl, url);
  const due = { ...published, status: "update_due" as const };
  const cleared = applyPublishedUrlRule({ ...due, status: "drafting" }, due);
  assert.equal(cleared.status, "drafting");
  assert.ok(!("publishedUrl" in cleared));
  const older = { ...article, status: "published" as const };
  assert.equal(applyPublishedUrlRule({ ...older, status: "monitoring" }, older).publishedUrl, undefined);
});

test("importing local articles drops the public URL", () => {
  assert.ok(!("publishedUrl" in toImportable({ ...article, status: "published", publishedUrl: url })));
});
