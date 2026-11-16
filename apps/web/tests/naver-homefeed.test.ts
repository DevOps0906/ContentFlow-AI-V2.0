import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRONT_LIMIT,
  HOMEFEED_STORAGE_KEY,
  applyEdit,
  charLength,
  hasHook,
  isPartialViews,
  checkBody,
  checkTitle,
  formatShare,
  formatStat,
  keywordSetWarnings,
  newPost,
  parseCount,
  parseHomefeed,
  splitKeywords,
  summarize,
  titleExtraWarnings,
  totalViews,
  type CheckItem,
  type HomefeedPost,
} from "../src/lib/naver-homefeed";

const NOW = "2026-11-16T00:00:00.000Z";
const post = (patch: Partial<HomefeedPost> = {}): HomefeedPost => ({ ...newPost("p1", NOW), ...patch });
const status = (items: CheckItem[]) => Object.fromEntries(items.map((c) => [c.id, c.status]));

test("storage key is versioned", () => {
  assert.equal(HOMEFEED_STORAGE_KEY, "contentflow.naverHomefeed.v1");
});

test("splitKeywords trims, normalizes spaces and drops empties", () => {
  assert.deepEqual(splitKeywords(" 앱 출시 ,  구글플레이\n,, 비용 "), ["앱 출시", "구글플레이", "비용"]);
});

test("keyword set warns on missing main, fewer than 3 details and duplicates", () => {
  assert.deepEqual(keywordSetWarnings("바이브코딩", "앱 출시, 구글플레이, 비용", "개발자 계정"), []);
  const w = keywordSetWarnings("", "앱 출시, 앱 출시", "");
  assert.ok(w.some((x) => x.includes("메인 키워드를 1개")));
  assert.ok(w.some((x) => x.includes("세부 키워드가 2개")));
  assert.ok(w.some((x) => x.includes("중복 키워드: 앱 출시")));
  assert.ok(keywordSetWarnings("a, b", "x, y, z", "").some((x) => x.includes("1개만")));
  assert.ok(keywordSetWarnings("AI", "ai, x, y", "").some((x) => x.includes("중복")), "case-insensitive");
});

const good = {
  mainKeyword: "AI 자동화",
  detailKeywords: "n8n, 블로그 초안",
  subKeywords: "",
  purpose: "discover" as const,
  formula: "F2" as const,
  title: "AI 자동화 n8n으로 블로그 초안 만들었더니 생긴 일",
  thumbnailText: "3시간 → 20분",
  titleReadable: true,
  titlePromise: true,
};

test("title check passes all 9 items for a well-formed discover title", () => {
  const items = checkTitle(post(good));
  assert.equal(items.length, 9);
  assert.ok(items.every((c) => c.status === "pass"), JSON.stringify(items));
});

test("title check: missing detail, late keywords, repeats, hook, thumbnail, formula, manual", () => {
  const s = status(
    checkTitle(
      post({
        ...good,
        title: "차근차근 알아보는 정리 방법과 순서를 담은 아주 긴 글 AI 자동화 AI 자동화",
        thumbnailText: "AI 자동화",
        formula: "F1",
        titleReadable: false,
        titlePromise: false,
      }),
    ),
  );
  assert.deepEqual(s, {
    "main-once": "warn",
    detail: "warn",
    front: "warn",
    "no-repeat": "warn",
    hook: "warn",
    readable: "manual",
    promise: "manual",
    thumbnail: "warn",
    formula: "warn",
  });
});

test("hook is optional for search purposes and thumbnail text is required for comparison", () => {
  const s = status(
    checkTitle(post({ ...good, purpose: "solve", formula: "F1", title: "AI 자동화 n8n 블로그 초안 등록 방법 정리", thumbnailText: "" })),
  );
  assert.equal(s.hook, "pass");
  assert.equal(s.thumbnail, "warn");
  assert.equal(s.formula, "pass");
});

test("title exaggeration reuses titleWarnings and adds guarantee phrases", () => {
  assert.ok(titleExtraWarnings("무조건 되는 방법").some((w) => w.includes("과장")));
  assert.ok(titleExtraWarnings("홈판 노출 보장 비법").some((w) => w.includes("보장")));
  assert.deepEqual(titleExtraWarnings("AI 자동화 n8n 사용기"), []);
});

test("body check covers intro, experience, image, details, question and guarantee", () => {
  const body = [
    "AI 자동화로 블로그 초안을 20분 만에 만들었습니다.",
    "제가 직접 n8n으로 해본 순서를 정리합니다.",
    "![워크플로 화면](/img/flow.png)",
    "여러분은 어떤 자동화를 쓰고 계신가요?",
  ].join("\n");
  const ok = status(checkBody({ body, mainKeyword: good.mainKeyword, detailKeywords: good.detailKeywords }));
  assert.ok(Object.values(ok).every((v) => v === "pass"), JSON.stringify(ok));

  const bad = checkBody({ body: "소개합니다.\n\n홈판 노출 보장 방법입니다.", mainKeyword: "AI 자동화", detailKeywords: "n8n" });
  assert.deepEqual(status(bad), {
    "intro-main": "warn",
    experience: "warn",
    image: "warn",
    details: "warn",
    question: "warn",
    guarantee: "warn",
  });
  assert.ok(bad.find((c) => c.id === "details")?.detail?.includes("n8n"));

  const empty = checkBody({ body: "  ", mainKeyword: "x", detailKeywords: "y" });
  assert.ok(empty.every((c) => c.status === "warn" && c.detail === "본문이 비어 있습니다."));
});

test("intro check only looks at the first 5 sentences", () => {
  const body = "하나. 둘. 셋. 넷. 다섯. 여섯에 AI 자동화가 나옵니다.";
  const s = status(checkBody({ body, mainKeyword: "AI 자동화", detailKeywords: "" }));
  assert.equal(s["intro-main"], "warn");
});

test("summary uses N/A when there is no data and averages only complete records", () => {
  const empty = summarize([]);
  assert.equal(formatStat(empty.byThumbnail.photo.avgViews), "N/A");
  assert.equal(formatShare(empty.purposeShare.discover), "N/A");

  const rec = (home: number | null, search: number | null, other: number | null) => ({
    ...newPost("x", NOW).record,
    homeViews: home,
    searchViews: search,
    otherViews: other,
  });
  const posts = [
    post({ id: "a", thumbnailType: "photo", formula: "F2", record: rec(100, 20, 0) }),
    post({ id: "b", thumbnailType: "photo", formula: "F2", record: rec(null, null, null) }),
    post({ id: "c", thumbnailType: "screenshot", purpose: "solve", formula: "F1", record: rec(null, 30, 5) }),
    post({ id: "d", purpose: "convert", formula: "F1", record: rec(10, 20, 30) }),
  ];
  const s = summarize(posts);
  assert.deepEqual(s.byThumbnail.photo, { posts: 2, measured: 1, avgViews: 120, avgHomeViews: 100 });
  assert.deepEqual(s.byThumbnail.screenshot, { posts: 1, measured: 0, avgViews: null, avgHomeViews: null }, "partial record is N/A");
  assert.equal(s.byFormula.F1.posts, 2);
  assert.equal(s.byFormula.F1.measured, 1);
  assert.equal(s.byFormula.F1.avgViews, 60);
  assert.deepEqual(s.purposeCount, { discover: 2, solve: 1, convert: 1 });
  assert.equal(formatShare(s.purposeShare.discover), "50%");
});

test("totalViews needs all three surfaces; partial records are flagged", () => {
  const r = (home: number | null, search: number | null, other: number | null) => ({
    ...newPost("x", NOW).record,
    homeViews: home,
    searchViews: search,
    otherViews: other,
  });
  assert.equal(totalViews(r(null, null, null)), null);
  assert.equal(totalViews(r(5, null, null)), null);
  assert.equal(totalViews(r(0, 0, 0)), 0, "zero is a real value, not N/A");
  assert.equal(totalViews(r(1, 2, 3)), 6);
  assert.equal(isPartialViews(r(5, null, null)), true);
  assert.equal(isPartialViews(r(null, null, null)), false);
  assert.equal(isPartialViews(r(1, 2, 3)), false);
});

test("hook numbers ignore digits inside keywords and words (n8n) but accept standalone numbers", () => {
  assert.equal(hasHook("AI 자동화 n8n 블로그 초안 정리", ["AI 자동화", "n8n", "블로그 초안"]), false);
  assert.equal(hasHook("n8n 블로그 초안 정리", []), false, "digit between letters is not a number");
  assert.equal(hasHook("n8n 블로그 초안 3가지 정리", ["n8n"]), true);
  assert.equal(hasHook("n8n으로 3시간을 20분으로", ["n8n"]), true);
  assert.equal(hasHook("GPT5 블로그 정리", []), false);
  assert.equal(hasHook("비용 1.5배 줄인 방법", []), true);
  const s = status(
    checkTitle(post({ ...good, title: "AI 자동화 n8n 블로그 초안 정리 방법" })),
  );
  assert.equal(s.hook, "warn", "discover title with only a keyword digit has no hook");
});

test("editing the title or body clears the related manual checks", () => {
  const base = post({ ...good });
  const t = applyEdit(base, { title: base.title + "!" }, NOW);
  assert.equal(t.titleReadable, false);
  assert.equal(t.titlePromise, false);
  const b = applyEdit(base, { body: "새 본문" }, NOW);
  assert.equal(b.titleReadable, true, "body edit keeps the readable check");
  assert.equal(b.titlePromise, false);
  const same = applyEdit(base, { title: base.title, thumbnailText: "다른 문구" }, NOW);
  assert.equal(same.titleReadable, true);
  assert.equal(same.titlePromise, true);
  const check = applyEdit(post(), { titleReadable: true }, NOW);
  assert.equal(check.titleReadable, true, "checking the box itself is kept");
});

test("character counts use code points (emoji counts as one)", () => {
  assert.equal(charLength("🚀앱"), 2);
  assert.equal("🚀앱".length, 3);
  // 15 emoji + "AI 자동화 n8n"(11) = 26 code points, but 41 UTF-16 units.
  const title = "🚀".repeat(15) + "AI 자동화 n8n 생긴 일";
  assert.ok(title.slice(0, FRONT_LIMIT).length === FRONT_LIMIT && !title.slice(0, FRONT_LIMIT).includes("n8n"));
  const s = status(checkTitle(post({ ...good, title })));
  assert.equal(s.front, "pass", "code-point slice keeps keywords within 27 characters");
});

test("parseCount accepts only non-negative integers", () => {
  assert.equal(parseCount(""), null);
  assert.equal(parseCount(" 42 "), 42);
  assert.equal(parseCount("0"), 0);
  assert.equal(parseCount("-1"), null);
  assert.equal(parseCount("1.5"), null);
  assert.equal(parseCount("abc"), null);
});

test("parseHomefeed round-trips valid data and rejects malformed data", () => {
  assert.deepEqual(parseHomefeed(null), []);
  const data = [post(good)];
  assert.deepEqual(parseHomefeed(JSON.stringify(data)), data);
  assert.throws(() => parseHomefeed("{"));
  assert.throws(() => parseHomefeed(JSON.stringify({})));
  assert.throws(() => parseHomefeed(JSON.stringify([{ ...post(), purpose: "spam" }])));
  assert.throws(() => parseHomefeed(JSON.stringify([{ ...post(), thumbnailChecks: [true] }])));
  assert.throws(() => parseHomefeed(JSON.stringify([{ ...post(), record: { ...post().record, homeViews: -3 } }])));
  assert.throws(() => parseHomefeed(JSON.stringify([{ ...post(), id: "" }])));
});
