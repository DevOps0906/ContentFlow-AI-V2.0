import { test } from "node:test";
import assert from "node:assert/strict";
import { importKeywords, normalizePhrase, parseCsv, parseKeywords } from "../src/lib/keywords";
import { generateTitles, titleWarnings } from "../src/lib/titles";

const NOW = "2026-11-06T00:00:00.000Z";

test("parseCsv handles quotes, commas, newlines in quotes, BOM and CRLF", () => {
  assert.deepEqual(parseCsv('\uFEFFa,"b,c"\r\n"x ""y""","line1\nline2"\r\n'), [
    ["a", "b,c"],
    ['x "y"', "line1\nline2"],
  ]);
  assert.throws(() => parseCsv('a,"unclosed'));
});

test("import with header maps Korean/English columns and defaults priority", () => {
  const r = importKeywords("키워드,우선순위,메모\n포트 오류,5,급함\n설치 방법,,\n", [], NOW);
  assert.equal(r.added, 2);
  assert.equal(r.keywords[0].priority, 5);
  assert.equal(r.keywords[0].note, "급함");
  assert.equal(r.keywords[1].priority, 3);
});

test("import without header uses first column", () => {
  const r = importKeywords("alpha\nbeta\n", [], NOW);
  assert.deepEqual(r.keywords.map((k) => k.phrase), ["alpha", "beta"]);
});

test("duplicates are skipped by case/space/width, never overwriting existing rows", () => {
  const first = importKeywords("keyword,note\nHello  World,original\n", [], NOW);
  const second = importKeywords(
    "keyword,note\nhello world,changed\nＨＥＬＬＯ ＷＯＲＬＤ,x\nnew one,y\nnew  ONE,z\n",
    first.keywords,
    NOW,
  );
  assert.equal(second.added, 1);
  assert.equal(second.duplicates, 3);
  assert.equal(second.keywords.find((k) => k.phrase === "Hello  World")!.note, "original");
  assert.equal(normalizePhrase("  A   b "), "a b");
});

test("invalid rows are reported with line numbers and do not abort the import", () => {
  const r = importKeywords("keyword,priority\nok,2\n,3\nbad,9\nfine,1\n", [], NOW);
  assert.equal(r.added, 2);
  assert.deepEqual(r.invalid.map((i) => i.line), [3, 4]);
});

test("empty and oversized files are rejected", () => {
  assert.throws(() => importKeywords("\n\n", [], NOW));
  assert.throws(() => importKeywords("a".repeat(1_000_001), [], NOW));
});

test("corrupt keyword storage is rejected, valid storage round-trips", () => {
  const r = importKeywords("x\n", [], NOW);
  assert.deepEqual(parseKeywords(JSON.stringify(r.keywords)), r.keywords);
  assert.deepEqual(parseKeywords(null), []);
  assert.throws(() => parseKeywords('[{"phrase":1}]'));
});

test("title lab returns 5 distinct deterministic candidates and flags overlong titles", () => {
  const a = generateTitles("  포트   오류 ");
  assert.equal(a.length, 5);
  assert.equal(new Set(a.map((t) => t.title)).size, 5);
  assert.deepEqual(a, generateTitles("포트 오류"));
  assert.ok(a.every((t) => t.title.includes("포트 오류")));
  assert.equal(titleWarnings("가".repeat(61)).length, 1);
  assert.equal(titleWarnings("가".repeat(60)).length, 0);
  assert.equal(titleWarnings("무조건 성공하는 법").length, 1);
  assert.throws(() => generateTitles("  "));
  assert.throws(() => generateTitles("가".repeat(41)));
});
test("an idea from a keyword starts at idea with no source and no approval", async () => {
  const { ideaFromKeyword } = await import("../src/lib/keywords");
  const { isArticle, reviewErrors } = await import("../src/lib/content");
  const a = ideaFromKeyword("  Next.js 포트 오류 ", { title: "제목 후보", templateId: "T02" });
  assert.equal(a.status, "idea");
  assert.equal(a.keyword, "Next.js 포트 오류");
  assert.equal(a.title, "제목 후보");
  assert.equal(a.sourceUrl, "");
  assert.ok(isArticle(a));
  // Nothing about it is reviewable yet: research, briefing and drafting still have to happen.
  assert.ok(reviewErrors(a).length > 0);
  assert.equal(ideaFromKeyword("x", { templateId: "nope" }).templateId, "T01");
  assert.ok(isArticle(ideaFromKeyword("x", { templateId: "nope" })));
  assert.throws(() => ideaFromKeyword("   "));
  assert.throws(() => ideaFromKeyword("x".repeat(121)));
  assert.equal(ideaFromKeyword("x", { title: "t".repeat(500) }).title.length, 200);
});

test("keyword ↔ article link ignores case, spacing and width, newest first", async () => {
  const { ideaFromKeyword, linkedArticles } = await import("../src/lib/keywords");
  const old = ideaFromKeyword("Next.js  포트 오류", { now: "2026-11-01T00:00:00Z" });
  const recent = ideaFromKeyword("next.js 포트 오류", { now: "2026-11-05T00:00:00Z" });
  const other = ideaFromKeyword("다른 키워드");
  const got = linkedArticles({ id: "k1", phrase: "ＮＥＸＴ.js 포트 오류" }, [old, other, recent]);
  assert.deepEqual(got.map((x) => x.id), [recent.id, old.id]);
  assert.deepEqual(linkedArticles({ id: "k2", phrase: "없는 키워드" }, [old, recent, other]), []);
});
test("links by keyword id when present, phrase only for articles without an id", async () => {
  const { ideaFromKeyword, linkedArticles } = await import("../src/lib/keywords");
  const kw = { id: "k-1", phrase: "포트 오류" };
  const byId = ideaFromKeyword("포트 오류", { keywordId: "k-1" });
  const renamed = ideaFromKeyword("다른 문구로 바뀜", { keywordId: "k-1" });
  const otherId = ideaFromKeyword("포트 오류", { keywordId: "k-2" });
  const legacy = ideaFromKeyword("포트  오류");
  const got = linkedArticles(kw, [byId, renamed, otherId, legacy]).map((a) => a.id).sort();
  assert.deepEqual(got, [byId.id, renamed.id, legacy.id].sort());
  assert.equal(byId.keywordId, "k-1");
  assert.equal(ideaFromKeyword("x").keywordId, undefined);
});
