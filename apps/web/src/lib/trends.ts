// Blog keyword trends (`keyword_trends`, migration 0016). Rules from the plan:
//  - values only come from manual entry or CSV, always with their source and measurement date
//  - a missing value stays missing (N/A); it is not turned into 0, and a score needs all three inputs
//  - values of different tools are never added, converted or scaled together
import { isUuid } from "./articles-db";
import { ALL_BLOGS, matchesBlogFilter, type Blog, type BlogFilterValue } from "./blogs";
import { normalizePhrase, parseCsv } from "./keywords";
import { parseDate } from "./revenue";

export type KeywordTrendInput = {
  /** null: unclassified. */
  blogId: string | null;
  keyword: string;
  /** "" when the tool gave no category. */
  category: string;
  monthlySearches: number | null;
  growthPct: number | null;
  documentCount: number | null;
  source: string;
  measuredOn: string; // YYYY-MM-DD
};
export type KeywordTrend = KeywordTrendInput & { id: string };

export const MAX_TRENDS = 20000;
export const MAX_TREND_CSV = 2_000_000;
export const MAX_TRENDS_PER_REQUEST = 1000;
export const TREND_LIMITS = { keyword: 120, category: 40, source: 40, growthMin: -100, growthMax: 1_000_000 };
export const NO_CATEGORY_LABEL = "카테고리 없음";

// ---------- parsing ----------

const aliases: Record<string, keyof typeof csvFields> = {
  keyword: "keyword", 키워드: "keyword", query: "keyword", 검색어: "keyword",
  category: "category", 카테고리: "category", 분류: "category",
  "monthly searches": "monthlySearches", "monthly search volume": "monthlySearches", "search volume": "monthlySearches", volume: "monthlySearches",
  검색량: "monthlySearches", 월간검색량: "monthlySearches", "월간 검색량": "monthlySearches", 월검색량: "monthlySearches",
  growth: "growthPct", "growth rate": "growthPct", "growth %": "growthPct",
  증가율: "growthPct", 검색증가율: "growthPct", "검색 증가율": "growthPct", "증가율(%)": "growthPct",
  documents: "documentCount", "document count": "documentCount", docs: "documentCount",
  문서수: "documentCount", "문서 수": "documentCount", 경쟁문서수: "documentCount",
  source: "source", 출처: "source",
  date: "date", "measured on": "date", 측정일: "date", 날짜: "date", 일자: "date",
};
const csvFields = { keyword: 0, category: 0, monthlySearches: 0, growthPct: 0, documentCount: 0, source: 0, date: 0 };

/** "" / "-" / "N/A" → null (missing). "0" is a real zero. Throws on anything else that is not a number. */
function parseMetric(raw: string | undefined, kind: "count" | "growth"): number | null {
  const s = (raw ?? "").trim().replace(/,/g, "").replace(/%$/, "").trim();
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  if (!(kind === "growth" ? /^[+-]?\d+(\.\d+)?$/ : /^\d+$/).test(s)) throw new Error(kind === "growth" ? "증가율은 숫자여야 합니다." : "검색량·문서 수는 0 이상의 정수여야 합니다.");
  return checkMetric(Number(s), kind);
}
function checkMetric(n: number, kind: "count" | "growth"): number {
  if (kind === "count") {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("검색량·문서 수는 0 이상의 정수여야 합니다.");
    return n;
  }
  if (!Number.isFinite(n) || n < TREND_LIMITS.growthMin || n > TREND_LIMITS.growthMax)
    throw new Error(`증가율은 ${TREND_LIMITS.growthMin}~${TREND_LIMITS.growthMax.toLocaleString("en-US")}% 범위여야 합니다.`);
  return Math.round(n * 100) / 100; // growth_pct keeps two decimals
}
const hasValue = (t: Pick<KeywordTrendInput, "monthlySearches" | "growthPct" | "documentCount">) =>
  t.monthlySearches !== null || t.growthPct !== null || t.documentCount !== null;

function checkText(t: Pick<KeywordTrendInput, "keyword" | "category" | "source">) {
  if (t.keyword.length < 1 || t.keyword.length > TREND_LIMITS.keyword) throw new Error("키워드는 1~120자여야 합니다.");
  if (t.category.length > TREND_LIMITS.category) throw new Error("카테고리는 40자까지 입력할 수 있습니다.");
  if (t.source.length < 1 || t.source.length > TREND_LIMITS.source) throw new Error("출처를 1~40자로 입력해주세요.");
}

const SEP = "\u001f";
const k = normalizePhrase;
/** Same columns and normalization as the keyword_trends_measurement_key constraint. */
export const trendKey = (t: KeywordTrendInput) =>
  [t.blogId ?? "", k(t.keyword), k(t.category), k(t.source), t.measuredOn].join(SEP);
const sameValues = (a: KeywordTrendInput, b: KeywordTrendInput) =>
  a.monthlySearches === b.monthlySearches && a.growthPct === b.growthPct && a.documentCount === b.documentCount;

export type TrendImport = {
  /** Rows to store. Rows that are already stored are not here. */
  rows: KeywordTrendInput[];
  added: number;
  duplicates: number;
  /** Same measurement already stored with other values. Skipped: the stored values stay. */
  conflicts: number;
  invalid: { line: number; reason: string }[];
};
export type TrendImportOptions = { blogId: string | null; source: string; measuredOn: string; now?: Date };

export function importTrends(csv: string, existing: KeywordTrendInput[], opts: TrendImportOptions): TrendImport {
  if (csv.length > MAX_TREND_CSV) throw new Error("CSV 파일이 너무 큽니다. (최대 2MB)");
  const now = opts.now ?? new Date();
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("헤더와 데이터 행이 필요합니다.");
  const cols: Partial<Record<keyof typeof csvFields, number>> = {};
  rows[0].forEach((h, i) => {
    const name = aliases[h.normalize("NFKC").trim().toLowerCase()];
    if (name && cols[name] === undefined) cols[name] = i;
  });
  if (cols.keyword === undefined) throw new Error("키워드(keyword) 열이 필요합니다.");
  if (cols.monthlySearches === undefined && cols.growthPct === undefined && cols.documentCount === undefined)
    throw new Error("월간 검색량, 검색 증가율, 문서 수 중 하나 이상의 열이 필요합니다.");
  const cell = (r: string[], c: number | undefined) => (c === undefined ? "" : (r[c] ?? "").trim());
  const stored = new Map(existing.map((t) => [trendKey(t), t]));
  const result: TrendImport = { rows: [], added: 0, duplicates: 0, conflicts: 0, invalid: [] };
  const seen = new Set<string>();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const bad = (reason: string) => void result.invalid.push({ line, reason });
    let row: KeywordTrendInput;
    try {
      const measuredOn = parseDate(cell(r, cols.date) || opts.measuredOn, now);
      if (!measuredOn) return bad("측정일이 올바르지 않습니다(YYYY-MM-DD, 미래 날짜 불가).");
      row = {
        blogId: opts.blogId,
        keyword: cell(r, cols.keyword),
        category: cell(r, cols.category),
        monthlySearches: parseMetric(cell(r, cols.monthlySearches), "count"),
        growthPct: parseMetric(cell(r, cols.growthPct), "growth"),
        documentCount: parseMetric(cell(r, cols.documentCount), "count"),
        source: cell(r, cols.source) || opts.source.trim(),
        measuredOn,
      };
      checkText(row);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "값이 올바르지 않습니다.");
    }
    if (!hasValue(row)) return bad("값이 모두 비어 있습니다.");
    const key = trendKey(row);
    const old = stored.get(key);
    if (old) {
      if (sameValues(old, row)) result.duplicates++;
      else result.conflicts++;
      return;
    }
    if (seen.has(key)) return void result.duplicates++;
    if (existing.length + result.rows.length >= MAX_TRENDS) return bad(`최대 ${MAX_TRENDS}행까지 저장할 수 있습니다.`);
    seen.add(key);
    result.rows.push(row);
    result.added++;
  });
  return result;
}

export type TrendForm = {
  blogId: string | null;
  keyword: string;
  category: string;
  monthlySearches: string;
  growthPct: string;
  documentCount: string;
  source: string;
  measuredOn: string;
};
/** One row typed by hand. A blank number stays missing. */
export function trendFromForm(f: TrendForm, now = new Date()): KeywordTrendInput {
  const measuredOn = parseDate(f.measuredOn, now);
  if (!measuredOn) throw new Error("측정일이 올바르지 않습니다(YYYY-MM-DD, 미래 날짜 불가).");
  const row: KeywordTrendInput = {
    blogId: f.blogId,
    keyword: f.keyword.trim(),
    category: f.category.trim(),
    monthlySearches: parseMetric(f.monthlySearches, "count"),
    growthPct: parseMetric(f.growthPct, "growth"),
    documentCount: parseMetric(f.documentCount, "count"),
    source: f.source.trim(),
    measuredOn,
  };
  checkText(row);
  if (!hasValue(row)) throw new Error("월간 검색량, 검색 증가율, 문서 수 중 하나 이상을 입력해주세요.");
  return row;
}

function bodyMetric(v: unknown, kind: "count" | "growth"): number | null {
  if (v === null) return null;
  if (typeof v !== "number") throw new Error("값은 숫자나 null이어야 합니다.");
  return checkMetric(v, kind);
}
/** Validates rows sent by the browser. Only these fields reach the database. */
export function parseTrendBatch(input: unknown, now = new Date()): KeywordTrendInput[] {
  const list = (input as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list) || list.length === 0) throw new Error("저장할 트렌드 행이 없습니다.");
  if (list.length > MAX_TRENDS_PER_REQUEST) throw new Error(`한 번에 ${MAX_TRENDS_PER_REQUEST}행까지 저장할 수 있습니다.`);
  return list.map((v, i) => {
    const t = (v ?? {}) as Record<string, unknown>;
    try {
      if (t.blogId !== null && (typeof t.blogId !== "string" || !isUuid(t.blogId))) throw new Error("블로그 계정이 올바르지 않습니다.");
      if (typeof t.keyword !== "string" || typeof t.category !== "string" || typeof t.source !== "string")
        throw new Error("키워드·카테고리·출처가 올바르지 않습니다.");
      const measuredOn = typeof t.measuredOn === "string" ? parseDate(t.measuredOn, now) : null;
      if (!measuredOn) throw new Error("측정일이 올바르지 않습니다.");
      const row: KeywordTrendInput = {
        blogId: t.blogId,
        keyword: t.keyword.trim(),
        category: t.category.trim(),
        monthlySearches: bodyMetric(t.monthlySearches, "count"),
        growthPct: bodyMetric(t.growthPct, "growth"),
        documentCount: bodyMetric(t.documentCount, "count"),
        source: t.source.trim(),
        measuredOn,
      };
      checkText(row);
      if (!hasValue(row)) throw new Error("값이 모두 비어 있습니다.");
      return row;
    } catch (e) {
      throw new Error(`${i + 1}번째 행: ${e instanceof Error ? e.message : "형식이 올바르지 않습니다."}`);
    }
  });
}

// ---------- database mapping ----------

export const TREND_COLUMNS = "id,blog_id,keyword,category,monthly_searches,growth_pct,document_count,source,measured_on";
export const TREND_CONFLICT = "workspace_id,blog_id,keyword_key,category_key,source_key,measured_on";
export type TrendDbRow = {
  id: string;
  blog_id: string | null;
  keyword: string;
  category: string;
  monthly_searches: number | string | null;
  growth_pct: number | string | null;
  document_count: number | string | null;
  source: string;
  measured_on: string;
};
// numeric/bigint columns may come back as strings
const num = (v: number | string | null) => (v === null ? null : Number(v));
export const dbToTrend = (r: TrendDbRow): KeywordTrend => ({
  id: r.id,
  blogId: r.blog_id,
  keyword: r.keyword,
  category: r.category,
  monthlySearches: num(r.monthly_searches),
  growthPct: num(r.growth_pct),
  documentCount: num(r.document_count),
  source: r.source,
  measuredOn: r.measured_on,
});
export const trendsToDbRows = (rows: KeywordTrendInput[], workspaceId: string, userId: string) =>
  rows.map((t) => ({
    workspace_id: workspaceId,
    blog_id: t.blogId,
    keyword: t.keyword,
    category: t.category,
    monthly_searches: t.monthlySearches,
    growth_pct: t.growthPct,
    document_count: t.documentCount,
    source: t.source,
    measured_on: t.measuredOn,
    created_by: userId,
  }));

// ---------- scoring ----------

/** A hypothesis, not a validated model; the screen says so. */
export const SCORE_WEIGHTS = { growth: 0.4, demand: 0.3, competition: 0.3 };
/** The value of an input that has nothing to be compared with: one row, or every row equal. */
export const NO_SPREAD_SCORE = 50;

export type ScoredTrend = KeywordTrend & {
  /** Blog + category + source. Scores are only comparable inside one group. */
  group: string;
  /** null: at least one input is missing. */
  score: number | null;
  /** Position inside the group; equal scores share one. null with the score. */
  rank: number | null;
  /** The inputs that made the score N/A. */
  missing: string[];
};

const groupKey = (t: KeywordTrend) => [t.blogId ?? "", k(t.category), k(t.source)].join(SEP);
const round1 = (n: number) => Math.round(n * 10) / 10;
const byKeyword = (a: { keyword: string }, b: { keyword: string }) => a.keyword.localeCompare(b.keyword, "ko");
const missingInputs = (t: KeywordTrend) => [
  ...(t.growthPct === null ? ["검색 증가율"] : []),
  ...(t.monthlySearches === null ? ["월간 검색량"] : []),
  ...(t.documentCount === null ? ["문서 수"] : []),
];

/** The most recent measurement of each keyword within one blog, category and tool. */
export function latestTrends(rows: KeywordTrend[]): KeywordTrend[] {
  const latest = new Map<string, KeywordTrend>();
  for (const t of rows) {
    const key = groupKey(t) + SEP + k(t.keyword);
    const held = latest.get(key);
    if (!held || t.measuredOn > held.measuredOn) latest.set(key, t);
  }
  return [...latest.values()];
}

/** Min-max normalization to 0~100 within one group. No spread means no information: the neutral value. */
function scaler(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (v: number) => (max === min ? NO_SPREAD_SCORE : ((v - min) / (max - min)) * 100);
}

/**
 * Scores within each blog, category and tool. Only rows with all three inputs are scored and only
 * those set the scale, so a row with a gap can not squeeze the scores of the others.
 */
export function scoreTrends(rows: KeywordTrend[]): ScoredTrend[] {
  const groups = new Map<string, KeywordTrend[]>();
  for (const t of rows) groups.set(groupKey(t), [...(groups.get(groupKey(t)) ?? []), t]);
  const out: ScoredTrend[] = [];
  for (const group of [...groups.keys()].sort()) {
    const members = groups.get(group)!;
    const full = members.filter((t) => missingInputs(t).length === 0);
    const growth = scaler(full.map((t) => t.growthPct!));
    const demand = scaler(full.map((t) => t.monthlySearches!));
    const documents = scaler(full.map((t) => t.documentCount!));
    const scored = full
      .map((t) => ({
        ...t,
        group,
        missing: [],
        score: round1(
          SCORE_WEIGHTS.growth * growth(t.growthPct!) +
            SCORE_WEIGHTS.demand * demand(t.monthlySearches!) +
            SCORE_WEIGHTS.competition * (100 - documents(t.documentCount!)),
        ),
        rank: 0 as number | null,
      }))
      .sort((a, b) => b.score - a.score || byKeyword(a, b));
    scored.forEach((t, i) => (t.rank = i > 0 && scored[i - 1].score === t.score ? scored[i - 1].rank : i + 1));
    out.push(
      ...scored,
      ...members
        .filter((t) => missingInputs(t).length > 0)
        .map((t) => ({ ...t, group, score: null, rank: null, missing: missingInputs(t) }))
        .sort(byKeyword),
    );
  }
  return out;
}

// ---------- filters and summaries ----------

export const ALL_CATEGORIES = "all";
export const categoryValue = (category: string) => `c:${k(category)}`;
export const TREND_PERIODS = [
  { value: "all", label: "전체 기간" },
  { value: "30", label: "최근 30일" },
  { value: "90", label: "최근 90일" },
  { value: "180", label: "최근 180일" },
] as const;
export type TrendPeriod = (typeof TREND_PERIODS)[number]["value"];

/** First day of the period, today included. `today` is the local YYYY-MM-DD. */
export function periodStart(period: TrendPeriod, today: string): string | null {
  if (period === "all") return null;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Number(period) + 1);
  return d.toISOString().slice(0, 10);
}

export type TrendFilter = { blog: BlogFilterValue; category: string; period: TrendPeriod; today: string };
/** Scores over the chosen period only, then narrows to the chosen account and category. */
export function analyzeTrends(rows: KeywordTrend[], f: TrendFilter): ScoredTrend[] {
  const start = periodStart(f.period, f.today);
  return scoreTrends(latestTrends(start ? rows.filter((t) => t.measuredOn >= start) : rows)).filter(
    (t) => matchesBlogFilter(t.blogId, f.blog) && (f.category === ALL_CATEGORIES || f.category === categoryValue(t.category)),
  );
}

export const categoryLabel = (category: string) => category || NO_CATEGORY_LABEL;
/** The categories offered by the filter, for the chosen account. */
export function trendCategories(rows: KeywordTrend[], blog: BlogFilterValue = ALL_BLOGS) {
  const found = new Map<string, string>();
  for (const t of rows) if (matchesBlogFilter(t.blogId, blog) && !found.has(categoryValue(t.category))) found.set(categoryValue(t.category), categoryLabel(t.category));
  return [...found].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

export type TrendInsight = { label: string; value: string; note: string };
const NOT_COMPARABLE = "도구·기준이 달라 서로 비교하지 않습니다. 표에서 확인하세요.";

export function trendInsights(list: ScoredTrend[]): TrendInsight[] {
  const scored = list.filter((t) => t.score !== null);
  const best = (() => {
    if (scored.length === 0) return { value: "N/A", note: "세 입력값이 모두 있는 키워드가 없습니다." };
    if (new Set(scored.map((t) => t.group)).size > 1) return { value: "표 참고", note: NOT_COMPARABLE };
    const top = [...scored].sort((a, b) => b.score! - a.score! || byKeyword(a, b))[0];
    return { value: top.keyword, note: `기회 점수 ${formatScore(top.score)} · ${top.source} · ${top.measuredOn}` };
  })();
  /** A raw value is only ranked against values from the same tool. */
  const extreme = (pick: (t: ScoredTrend) => number | null, sign: 1 | -1, show: (v: number) => string) => {
    const known = list.filter((t) => pick(t) !== null);
    if (known.length === 0) return { value: "N/A", note: "이 값을 입력한 키워드가 없습니다." };
    if (new Set(known.map((t) => k(t.source))).size > 1) return { value: "표 참고", note: NOT_COMPARABLE };
    const top = [...known].sort((a, b) => sign * (pick(b)! - pick(a)!) || byKeyword(a, b))[0];
    return { value: top.keyword, note: `${show(pick(top)!)} · ${top.source} · ${top.measuredOn}` };
  };
  return [
    { label: "기회 점수 1위", ...best },
    { label: "검색 증가 1위", ...extreme((t) => t.growthPct, 1, formatGrowth) },
    { label: "문서 경쟁 최저", ...extreme((t) => t.documentCount, -1, (v) => `문서 ${formatCount(v)}개`) },
  ];
}

export type TrendBar = { group: string; blogId: string | null; category: string; source: string; average: number | null; scored: number; total: number };
/** Average score per group. A group with no complete row is N/A, not a zero-length bar. */
export function trendBars(list: ScoredTrend[]): TrendBar[] {
  const bars = new Map<string, TrendBar & { sum: number }>();
  for (const t of list) {
    const bar = bars.get(t.group) ?? { group: t.group, blogId: t.blogId, category: t.category, source: t.source, average: null, scored: 0, total: 0, sum: 0 };
    bar.total++;
    if (t.score !== null) {
      bar.scored++;
      bar.sum += t.score;
    }
    bars.set(t.group, bar);
  }
  return [...bars.values()]
    .map(({ sum, ...b }) => ({ ...b, average: b.scored ? round1(sum / b.scored) : null }))
    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || a.group.localeCompare(b.group));
}

/** The account a new article takes over: an archived account can not be chosen again. */
export const ideaBlogId = (blogId: string | null, blogs: Blog[]) =>
  blogs.find((b) => b.id === blogId && b.status === "active")?.id;

export const formatCount = (n: number | null) => (n === null ? "N/A" : n.toLocaleString("ko-KR"));
export const formatScore = (n: number | null) => (n === null ? "N/A" : n.toFixed(1));
export const formatGrowth = (n: number | null) => (n === null ? "N/A" : `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR")}%`);
