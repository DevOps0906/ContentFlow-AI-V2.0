// Naver homefeed checks (CF-25, H1~H6). Rule-based warnings only: no AI/network, never blocks publishing.
// Rules: docs/04-content/NAVER_HOMEFEED_RULES.md (1·2·3·4·5·8장).

import { titleWarnings } from "./titles";

export const HOMEFEED_STORAGE_KEY = "contentflow.naverHomefeed.v1";

export const PURPOSES = ["discover", "solve", "convert"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const FORMULAS = ["F1", "F2"] as const;
export type Formula = (typeof FORMULAS)[number];
export const THUMBNAIL_TYPES = ["photo", "screenshot"] as const;
export type ThumbnailType = (typeof THUMBNAIL_TYPES)[number];

export const purposeInfo: Record<Purpose, { label: string; formula: Formula; surface: string; focus: string }> = {
  discover: { label: "발견글", formula: "F2", surface: "홈판·추천", focus: "경험·결과·호기심" },
  solve: { label: "문제해결글", formula: "F1", surface: "검색", focus: "질문에 대한 구체적 답" },
  convert: { label: "전환글", formula: "F1", surface: "검색 + 상품", focus: "절차·비용·CTA (CTA는 마지막에 한 번)" },
};
export const formulaInfo: Record<Formula, string> = {
  F1: "검색형: 메인 + 세부1 + 세부2 + 정보 유형(방법·순서·비교·후기)",
  F2: "후킹형: 메인 + 세부1 + 후킹(숫자·반전·결과) + 세부2",
};
export const thumbnailTypeLabels: Record<ThumbnailType, string> = { photo: "사진", screenshot: "스크린샷" };
/** Target purpose ratio 5:3:2 (rules 1장, [제안]). */
export const PURPOSE_TARGET: Record<Purpose, number> = { discover: 0.5, solve: 0.3, convert: 0.2 };

/** Naver API terms notices (NAVER_HOMEFEED.md §11.2). Shown as React text; shared by the screen and the server. */
export const NAVER_TERMS_URL = "https://developers.naver.com/products/terms/";
export const NAVER_NOTICE = {
  blogs:
    "네이버 검색결과 · 출처: 네이버 검색 API. 네이버 API 이용약관에 따라 화면 표시용으로만 제공하며, AI 입력·학습·평가에 쓰지 않습니다. 순위·내용을 바꾸지 않고, 저장하지 않으며(최대 10분 임시 보관) 제목을 누르면 원문으로 이동합니다.",
  keywords: "출처: 네이버 검색광고 API(키워드 도구). 광고 계정 소유자의 키로만 조회하며, 이 워크스페이스 소유자 전용 기능입니다.",
  notOwner:
    "네이버 블로그 검색·키워드 도구는 API 키 소유자 전용 기능이라 이 워크스페이스에서는 쓸 수 없습니다. 네이버 API 이용약관에 따라 키 소유자의 워크스페이스(NAVER_OWNER_WORKSPACE_ID)에서만 조회합니다.",
  notConfigured: "연결 안 됨: 네이버 API 이용약관에 따라 키 소유자가 서버에 키를 설정한 경우에만 조회합니다.",
  summary: [
    "블로그 검색결과와 그 파생(키워드 빈도 등)은 AI 입력·학습·평가에 쓰지 않습니다. AI 제목은 내 키워드 세트와 검색광고 연관 키워드만 씁니다.",
    "블로그 검색결과는 \"네이버 검색결과\"로 표기하고 API 순서 그대로, 원문 링크와 함께 보여줍니다.",
    "결과는 최대 10분 메모리에만 임시 보관하고 DB·로그에 저장하지 않습니다.",
    "블로그 검색·키워드 도구는 키 소유자 전용(로컬 모드 또는 지정 워크스페이스)이며 제3자에게 재제공하지 않습니다.",
    "검색광고 키워드 도구가 호출 한도(429)를 알리면 5분간 호출을 멈춥니다.",
  ],
} as const;

/** Rules 4장 — checked by a person. */
export const THUMBNAIL_CHECKS = [
  "이미지만 봐도 주제를 알 수 있다",
  "주제와 무관한 사진이 아니다",
  "결과물 화면 + 짧은 문구(숫자 권장) 형식이다",
  "모바일 피드 크기로 줄여도 글자가 읽힌다",
  "제목과 다른 정보를 준다",
  "직접 만든 이미지다",
  "고정 템플릿(1~2종)을 따른다",
  "사진형·스크린샷형을 번갈아 기록한다",
] as const;

export type HomefeedRecord = {
  publishedOn: string;
  homeViews: number | null;
  searchViews: number | null;
  otherViews: number | null;
  comments: number | null;
  neighbors: number | null;
  clipLinked: boolean;
  clipViews: number | null;
  memo: string;
};

export type HomefeedPost = {
  id: string;
  purpose: Purpose;
  formula: Formula;
  mainKeyword: string;
  detailKeywords: string;
  subKeywords: string;
  title: string;
  thumbnailText: string;
  thumbnailType: ThumbnailType | "";
  thumbnailChecks: boolean[];
  /** Manual title items: readable sentence, body keeps the promise. */
  titleReadable: boolean;
  titlePromise: boolean;
  body: string;
  /** Article the title/body were copied from (read only; never written back). */
  articleId?: string;
  record: HomefeedRecord;
  updatedAt: string;
};

export function newPost(id: string, now: string): HomefeedPost {
  return {
    id,
    purpose: "discover",
    formula: "F2",
    mainKeyword: "",
    detailKeywords: "",
    subKeywords: "",
    title: "",
    thumbnailText: "",
    thumbnailType: "",
    thumbnailChecks: THUMBNAIL_CHECKS.map(() => false),
    titleReadable: false,
    titlePromise: false,
    body: "",
    record: {
      publishedOn: "",
      homeViews: null,
      searchViews: null,
      otherViews: null,
      comments: null,
      neighbors: null,
      clipLinked: false,
      clipViews: null,
      memo: "",
    },
    updatedAt: now,
  };
}

/** Comma/newline separated keyword input → trimmed, non-empty items (duplicates kept so they can be flagged). */
export function splitKeywords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((k) => k.normalize("NFKC").trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function countOf(text: string, keyword: string): number {
  const k = norm(keyword);
  if (!k) return 0;
  return norm(text).split(k).length - 1;
}

// ---------- H3 키워드 세트 ----------
export function keywordSetWarnings(main: string, details: string, subs: string): string[] {
  const w: string[] = [];
  const m = splitKeywords(main);
  const d = splitKeywords(details);
  const s = splitKeywords(subs);
  if (m.length === 0) w.push("메인 키워드를 1개 입력하세요.");
  if (m.length > 1) w.push("메인 키워드는 1개만 정합니다.");
  if (d.length < 3) w.push(`세부 키워드가 ${d.length}개입니다. 3개 이상을 권장합니다.`);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of [...m, ...d, ...s]) {
    const key = norm(k);
    if (seen.has(key)) dup.add(k);
    seen.add(key);
  }
  if (dup.size) w.push(`중복 키워드: ${[...dup].join(", ")}`);
  return w;
}

// ---------- H2 제목 점검 (규칙 3.5 9항목) ----------
export type CheckStatus = "pass" | "warn" | "manual";
export type CheckItem = { id: string; label: string; status: CheckStatus; detail?: string };

export const FRONT_LIMIT = 27;
const GUARANTEE = /(노출|수익|상위|홈판|조회수)\s*\S{0,4}\s*보장|보장\s*\S{0,4}\s*(노출|수익)/;
/** Counts code points so emoji and composed characters count as one. */
export const charLength = (s: string) => Array.from(s).length;
/** A standalone number (3, 20분, 5가지) counts as a hook; digits inside a word or keyword (n8n) do not. */
const HOOK_NUMBER = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)?(?![A-Za-z])/;
const HOOK = /했더니|해보니|해 보니|써보니|써 보니|결과|후기|의외|생긴 일|달라진|알고 보니|반전|실제로|직접/;

export function hasHook(title: string, keywords: string[]): boolean {
  let rest = norm(title);
  for (const k of keywords.map(norm).filter(Boolean)) rest = rest.split(k).join(" ");
  return HOOK.test(rest) || HOOK_NUMBER.test(rest);
}

/**
 * Applies an edit; a changed title clears the "readable" check, and a changed title or body clears
 * the "body keeps the promise" check, so a manual confirmation never outlives the text it was about.
 */
export function applyEdit(post: HomefeedPost, patch: Partial<HomefeedPost>, now: string): HomefeedPost {
  const next = { ...post, ...patch, updatedAt: now };
  const titleChanged = patch.title !== undefined && patch.title !== post.title;
  const bodyChanged = patch.body !== undefined && patch.body !== post.body;
  if (titleChanged) next.titleReadable = false;
  if (titleChanged || bodyChanged) next.titlePromise = false;
  return next;
}

/**
 * Snapshot of the inputs a reference/AI result was made from (§11). A result whose snapshot no longer
 * matches the post is stale and is not shown; a late answer for an old snapshot is dropped.
 */
export type ResultInput = Pick<HomefeedPost, "id" | "mainKeyword" | "detailKeywords" | "purpose" | "formula" | "thumbnailText">;
export function resultInputKey(p: ResultInput): string {
  return JSON.stringify([p.id, p.mainKeyword, p.detailKeywords, p.purpose, p.formula, p.thumbnailText]);
}

/** Reference (R1) results follow the main keyword only, so adding a related keyword keeps the table. */
export function researchInputKey(p: Pick<HomefeedPost, "id" | "mainKeyword">): string {
  return JSON.stringify([p.id, p.mainKeyword]);
}

export type TitleInput = Pick<
  HomefeedPost,
  "title" | "mainKeyword" | "detailKeywords" | "subKeywords" | "thumbnailText" | "purpose" | "formula" | "titleReadable" | "titlePromise"
>;

const compact = (s: string) => norm(s).replace(/[\s\p{P}\p{S}]/gu, "");

export function checkTitle(p: TitleInput): CheckItem[] {
  const title = p.title;
  const main = splitKeywords(p.mainKeyword)[0] ?? "";
  const details = splitKeywords(p.detailKeywords);
  const all = [main, ...details, ...splitKeywords(p.subKeywords)].filter(Boolean);
  const mainCount = main ? countOf(title, main) : 0;
  const usedDetails = details.filter((d) => countOf(title, d) > 0);
  const front = Array.from(title).slice(0, FRONT_LIMIT).join("");
  const repeated = [...new Set(all.filter((k) => countOf(title, k) > 1))];
  const hooked = hasHook(title, all);
  const thumb = compact(p.thumbnailText);
  const t = compact(title);
  const expected = purposeInfo[p.purpose].formula;
  const ok = (cond: boolean, detail?: string): Pick<CheckItem, "status" | "detail"> =>
    cond ? { status: "pass" } : { status: "warn", detail };

  return [
    {
      id: "main-once",
      label: "메인 키워드가 정확히 1개 들어 있다",
      ...(main ? ok(mainCount === 1, `메인 키워드가 ${mainCount}회 들어 있습니다.`) : { status: "warn", detail: "메인 키워드를 먼저 정하세요." }),
    },
    {
      id: "detail",
      label: "세부 키워드가 1개 이상 들어 있다",
      ...ok(usedDetails.length > 0, details.length ? "제목에 세부 키워드가 없습니다." : "세부 키워드를 먼저 정하세요."),
    },
    {
      id: "front",
      label: `핵심 키워드가 앞쪽(약 ${FRONT_LIMIT}자 안)에 있다`,
      ...ok(
        !!main && countOf(front, main) > 0 && details.some((d) => countOf(front, d) > 0),
        `메인 키워드와 세부 키워드 1개를 앞 ${FRONT_LIMIT}자 안에 두세요.`,
      ),
    },
    { id: "no-repeat", label: "같은 키워드를 두 번 쓰지 않았다", ...ok(repeated.length === 0, `반복: ${repeated.join(", ")}`) },
    {
      id: "hook",
      label: "후킹 요소가 있다 (발견글은 필수)",
      ...(hooked || p.purpose !== "discover"
        ? { status: "pass" as const, detail: hooked ? undefined : "검색용 글은 선택입니다." }
        : { status: "warn" as const, detail: "숫자·반전·결과·경험 중 하나를 넣으세요." }),
    },
    { id: "readable", label: "키워드 나열이 아니라 읽히는 문장이다", status: p.titleReadable ? "pass" : "manual" },
    { id: "promise", label: "본문이 제목의 약속을 지킨다", status: p.titlePromise ? "pass" : "manual" },
    {
      id: "thumbnail",
      label: "썸네일 문구와 같은 말이 아니다",
      ...(thumb
        ? ok(!!t && !t.includes(thumb) && !thumb.includes(t), "썸네일 문구가 제목과 겹칩니다. 다른 정보를 주세요.")
        : { status: "warn", detail: "썸네일 문구가 비어 있어 비교할 수 없습니다." }),
    },
    {
      id: "formula",
      label: "글 목적과 공식(F1/F2)이 맞다",
      ...ok(p.formula === expected, `${purposeInfo[p.purpose].label}은 ${expected} 공식을 씁니다.`),
    },
  ];
}

/** Exaggeration warnings reuse the Title Lab rule; homefeed adds "보장" phrases (rules 9장). */
export function titleExtraWarnings(title: string): string[] {
  const w = titleWarnings(title);
  if (GUARANTEE.test(title) && !w.some((x) => x.includes("보장"))) w.push("노출·수익 보장 표현은 쓰지 마세요.");
  return w;
}

// ---------- H5 본문 점검 ----------
const EXPERIENCE = /직접|해보|해 보|써보|써 보|제가|저는|내가|경험|막혔|막힌/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)|<img\b|\[(이미지|사진|캡처|스크린샷|화면)[^\]]*\]/;

export function checkBody(p: Pick<HomefeedPost, "body" | "mainKeyword" | "detailKeywords">): CheckItem[] {
  const body = p.body.trim();
  const main = splitKeywords(p.mainKeyword)[0] ?? "";
  const details = splitKeywords(p.detailKeywords);
  const empty = { status: "warn" as const, detail: "본문이 비어 있습니다." };
  const ok = (cond: boolean, detail: string): Pick<CheckItem, "status" | "detail"> =>
    !body ? empty : cond ? { status: "pass" } : { status: "warn", detail };
  const intro = body.split(/(?<=[.!?。])\s+|\n+/).filter((s) => s.trim()).slice(0, 5).join(" ");
  const missing = details.filter((d) => countOf(body, d) === 0);
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return [
    {
      id: "intro-main",
      label: "도입부(3~5문장)에 메인 키워드가 있다",
      ...(main ? ok(countOf(intro, main) > 0, "도입부에 메인 키워드와 핵심 답을 먼저 보여주세요.") : { status: "warn", detail: "메인 키워드를 먼저 정하세요." }),
    },
    { id: "experience", label: "직접 경험 문단이 있다", ...ok(EXPERIENCE.test(body), "해본 순서·막힌 점·결과를 직접 쓰세요.") },
    { id: "image", label: "실제 화면·이미지가 있다", ...ok(IMAGE.test(body), "이미지 표시(![설명](주소), <img>, [이미지])가 없습니다.") },
    {
      id: "details",
      label: "세부 키워드를 본문에 썼다",
      ...(details.length ? ok(missing.length === 0, `본문에 없는 세부 키워드: ${missing.join(", ")}`) : { status: "warn", detail: "세부 키워드를 먼저 정하세요." }),
    },
    { id: "question", label: "글 끝에 독자 질문이 있다", ...ok(/[?？]/.test(last), "마지막 문단에 독자 질문 1개를 넣으세요.") },
    { id: "guarantee", label: "노출·수익 보장 표현이 없다", ...ok(!GUARANTEE.test(body), "‘노출 보장’, ‘수익 보장’ 같은 표현을 지우세요.") },
  ];
}

// ---------- H6 성과 집계 ----------
const surfaceViews = (r: HomefeedRecord) => [r.homeViews, r.searchViews, r.otherViews];
/** Total only when home, search and other views are all entered; a partial record is N/A. */
export function totalViews(r: HomefeedRecord): number | null {
  const v = surfaceViews(r);
  return v.every((n): n is number => n !== null) ? v.reduce((a, b) => a + b, 0) : null;
}
/** Some but not all surfaces entered. */
export function isPartialViews(r: HomefeedRecord): boolean {
  const v = surfaceViews(r);
  return v.some((n) => n !== null) && v.some((n) => n === null);
}
const avg = (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

export type GroupStat = { posts: number; measured: number; avgViews: number | null; avgHomeViews: number | null };
function group(posts: HomefeedPost[]): GroupStat {
  const complete = posts.filter((p) => totalViews(p.record) !== null);
  const totals = complete.map((p) => totalViews(p.record) as number);
  const homes = complete.map((p) => p.record.homeViews as number);
  return { posts: posts.length, measured: totals.length, avgViews: avg(totals), avgHomeViews: avg(homes) };
}

export type HomefeedSummary = {
  byThumbnail: Record<ThumbnailType, GroupStat>;
  byFormula: Record<Formula, GroupStat>;
  /** Share of each purpose; `null` when there are no posts (N/A). */
  purposeShare: Record<Purpose, number | null>;
  purposeCount: Record<Purpose, number>;
};

export function summarize(posts: HomefeedPost[]): HomefeedSummary {
  const purposeCount = Object.fromEntries(PURPOSES.map((p) => [p, posts.filter((x) => x.purpose === p).length])) as Record<Purpose, number>;
  return {
    byThumbnail: Object.fromEntries(THUMBNAIL_TYPES.map((t) => [t, group(posts.filter((p) => p.thumbnailType === t))])) as Record<ThumbnailType, GroupStat>,
    byFormula: Object.fromEntries(FORMULAS.map((f) => [f, group(posts.filter((p) => p.formula === f))])) as Record<Formula, GroupStat>,
    purposeShare: Object.fromEntries(PURPOSES.map((p) => [p, posts.length ? purposeCount[p] / posts.length : null])) as Record<Purpose, number | null>,
    purposeCount,
  };
}

/** Missing values read as N/A, never 0. */
export function formatStat(n: number | null, digits = 0): string {
  return n === null ? "N/A" : n.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
export function formatShare(n: number | null): string {
  return n === null ? "N/A" : `${Math.round(n * 100)}%`;
}

/** "" → null; negative or non-integer input is rejected as null. */
export function parseCount(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return Number(t);
}

// ---------- 저장 데이터 파싱 ----------
const isStr = (v: unknown, max = 20000): v is string => typeof v === "string" && v.length <= max;
const isCount = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

function isRecord(v: unknown): v is HomefeedRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    isStr(r.publishedOn, 10) &&
    ["homeViews", "searchViews", "otherViews", "comments", "neighbors", "clipViews"].every((k) => isCount(r[k])) &&
    typeof r.clipLinked === "boolean" &&
    isStr(r.memo, 2000)
  );
}

export function isHomefeedPost(v: unknown): v is HomefeedPost {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    isStr(p.id, 64) &&
    p.id.length > 0 &&
    PURPOSES.includes(p.purpose as Purpose) &&
    FORMULAS.includes(p.formula as Formula) &&
    isStr(p.mainKeyword, 200) &&
    isStr(p.detailKeywords, 1000) &&
    isStr(p.subKeywords, 1000) &&
    isStr(p.title, 300) &&
    isStr(p.thumbnailText, 200) &&
    (p.thumbnailType === "" || THUMBNAIL_TYPES.includes(p.thumbnailType as ThumbnailType)) &&
    Array.isArray(p.thumbnailChecks) &&
    p.thumbnailChecks.length === THUMBNAIL_CHECKS.length &&
    p.thumbnailChecks.every((c) => typeof c === "boolean") &&
    typeof p.titleReadable === "boolean" &&
    typeof p.titlePromise === "boolean" &&
    isStr(p.body, 200000) &&
    (p.articleId === undefined || isStr(p.articleId, 64)) &&
    isRecord(p.record) &&
    isStr(p.updatedAt, 40)
  );
}

/** Throws on malformed data so the caller can refuse to overwrite it. */
export function parseHomefeed(raw: string | null): HomefeedPost[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isHomefeedPost)) throw new Error("저장된 홈판 점검 데이터 형식을 읽을 수 없습니다.");
  return parsed;
}
