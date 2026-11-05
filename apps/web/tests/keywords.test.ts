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
