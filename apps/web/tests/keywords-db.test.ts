import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNewKeywords, rowToKeyword, MAX_PER_REQUEST } from "../src/lib/keywords-db";

test("new keywords are trimmed, defaulted and bounded", () => {
  assert.deepEqual(parseNewKeywords({ keywords: [{ phrase: "  포트 오류 " }] }), [
    { phrase: "포트 오류", intent: "", priority: 3, note: "" },
  ]);
  assert.equal(parseNewKeywords({ keywords: [{ phrase: "a", priority: 5, intent: " 정보 " }] })[0].intent, "정보");
});

test("invalid keyword requests are rejected with a message", () => {
  for (const bad of [
    null,
    {},
    { keywords: [] },
    { keywords: "x" },
    { keywords: [{ phrase: "" }] },
    { keywords: [{ phrase: "   " }] },
    { keywords: [{ phrase: "x".repeat(121) }] },
    { keywords: [{ phrase: "a", priority: 0 }] },
    { keywords: [{ phrase: "a", priority: 6 }] },
    { keywords: [{ phrase: "a", priority: 2.5 }] },
    { keywords: [{ phrase: "a", intent: "x".repeat(201) }] },
    { keywords: [{ phrase: "a", note: "x".repeat(501) }] },
    { keywords: [null] },
    { keywords: Array.from({ length: MAX_PER_REQUEST + 1 }, () => ({ phrase: "a" })) },
  ])
    assert.throws(() => parseNewKeywords(bad), JSON.stringify(bad)?.slice(0, 40));
});

test("rows map to the browser keyword shape", () => {
  assert.deepEqual(
    rowToKeyword({ id: "i", phrase: "p", intent: "n", priority: 2, note: "m", created_at: "2026-11-06T00:00:00Z", blog_id: null }),
    { id: "i", phrase: "p", intent: "n", priority: 2, note: "m", importedAt: "2026-11-06T00:00:00Z" },
  );
});