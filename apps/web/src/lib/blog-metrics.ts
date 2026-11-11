// Per-tool performance records of blog accounts (`blog_metric_snapshots`, migration 0017). Rules:
//  - values only come from manual entry or a Search Console CSV, always with tool and measurement date
//  - nothing is fetched from the tools and no tool is shown as connected: they are shortcuts only
//  - values of different tools (or accounts) are never added, converted or ranked together
//  - a blog index is what a third-party tool displayed; it is not official and is never computed here
import { isUuid } from "./articles-db";
import { matchesBlogFilter, type Blog, type BlogFilterValue, type BlogPlatform } from "./blogs";
import { normalizePhrase, parseCsv } from "./keywords";
import { parseDate } from "./revenue";

// Keep in sync with the tool check in 0017 (a test compares them).
export const METRIC_TOOLS = ["bseupi", "blackkiwi", "blogai", "gsc", "ubersuggest", "clarity", "other"] as const;
export type MetricTool = (typeof METRIC_TOOLS)[number];
/** `url: null`: named only, no shortcut. */
export const TOOL_INFO: Record<MetricTool, { label: string; purpose: string; url: string | null }> = {
  bseupi: { label: "블스피", purpose: "블로그지수·누락 확인", url: null },
  blackkiwi: { label: "블랙키위", purpose: "키워드 조회", url: "https://blackkiwi.net/" },
  blogai: { label: "블로그AI", purpose: "금칙어·본문 진단", url: null },
  gsc: { label: "Google Search Console", purpose: "검색 유입 (CSV 가져오기)", url: "https://search.google.com/search-console" },
  ubersuggest: { label: "Ubersuggest", purpose: "키워드·SEO", url: "https://neilpatel.com/ubersuggest/" },
  clarity: { label: "Microsoft Clarity", purpose: "이탈 구간", url: "https://clarity.microsoft.com/" },
  other: { label: "기타 도구", purpose: "메모에 도구 이름을 적어 주세요", url: null },
};
export const TOOL_GROUPS: { id: string; label: string; platforms: BlogPlatform[]; tools: MetricTool[] }[] = [
  { id: "naver", label: "네이버 블로그", platforms: ["naver"], tools: ["bseupi", "blackkiwi", "blogai"] },
  { id: "web", label: "구글·워드프레스·티스토리", platforms: ["tistory", "wordpress", "blogger"], tools: ["gsc", "ubersuggest", "clarity"] },
];
/** The bundles for the filter: one account shows its platform's bundle, otherwise every bundle. */
export function toolGroupsFor(filter: BlogFilterValue, blogs: Blog[]) {
  const blog = blogs.find((b) => b.id === filter);
  return blog ? TOOL_GROUPS.filter((g) => g.platforms.includes(blog.platform)) : TOOL_GROUPS;
}

export const METRIC_SCOPES = ["site", "query", "page"] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];
export type MetricInput = {
  /** null: unclassified. */
  blogId: string | null;
  tool: MetricTool;
  metric: string;
  scope: MetricScope;
  /** "" for site; the search query or page address otherwise. */
  dimension: string;
  /** Exactly one of value and valueLabel is set. */
  value: number | null;
  valueLabel: string | null;
  unit: string;
  measuredOn: string; // YYYY-MM-DD
  evidenceUrl: string | null;
  memo: string;
};
export type MetricSnapshot = MetricInput & { id: string };

export const MAX_METRICS = 30000;
export const MAX_METRIC_CSV = 2_000_000;
export const MAX_METRICS_PER_REQUEST = 500;
export const METRIC_LIMITS = { metric: 40, dimension: 2000, valueLabel: 40, unit: 20, memo: 500, url: 2000, valueAbs: 1_000_000_000_000 };
export const INDEX_METRIC = "블로그지수";
export const isIndexMetric = (metric: string) => normalizePhrase(metric).replace(/\s/g, "") === INDEX_METRIC;

// ---------- validation ----------

function checkInput(r: MetricInput): MetricInput {
  if (r.blogId !== null && !isUuid(r.blogId)) throw new Error("블로그 계정이 올바르지 않습니다.");
  if (!METRIC_TOOLS.includes(r.tool)) throw new Error("도구를 선택해주세요.");
  if (r.metric.length < 1 || r.metric.length > METRIC_LIMITS.metric) throw new Error("지표 이름을 1~40자로 입력해주세요.");
  if (!METRIC_SCOPES.includes(r.scope)) throw new Error("지표 범위가 올바르지 않습니다.");
  if ((r.scope === "site") !== (r.dimension === "")) throw new Error(r.scope === "site" ? "사이트 지표에는 검색어·페이지를 넣지 않습니다." : "검색어 또는 페이지가 필요합니다.");
  if (r.dimension.length > METRIC_LIMITS.dimension) throw new Error("검색어·페이지는 2000자까지 저장할 수 있습니다.");
  if ((r.value === null) === (r.valueLabel === null)) throw new Error("값은 숫자나 표시 문구 중 하나만 입력해주세요.");
  if (r.value !== null && (!Number.isFinite(r.value) || Math.abs(r.value) > METRIC_LIMITS.valueAbs)) throw new Error("값이 허용 범위를 벗어났습니다.");
  if (r.valueLabel !== null && (r.valueLabel.length < 1 || r.valueLabel.length > METRIC_LIMITS.valueLabel)) throw new Error("표시 문구는 1~40자로 입력해주세요.");
  if (r.unit.length > METRIC_LIMITS.unit) throw new Error("단위는 20자까지 입력할 수 있습니다.");
  if (r.memo.length > METRIC_LIMITS.memo) throw new Error("메모는 500자까지 입력할 수 있습니다.");
  if (r.evidenceUrl !== null && (!/^https?:\/\/\S+$/i.test(r.evidenceUrl) || r.evidenceUrl.length > METRIC_LIMITS.url))
    throw new Error("근거 URL은 http(s)://로 시작하는 2000자 이하 주소여야 합니다.");
  return r;
}
const round4 = (n: number) => Math.round(n * 10000) / 10000; // value keeps four decimals

/** "1,234" / "-3.5" / "12%" → number; anything else is a label as the tool showed it (e.g. a grade). */
export function parseValue(raw: string): { value: number | null; valueLabel: string | null; percent: boolean } {
  const s = raw.trim();
  if (!s) throw new Error("값을 입력해주세요.");
  const n = s.replace(/,/g, "").replace(/%$/, "").trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(n)) return { value: round4(Number(n)), valueLabel: null, percent: s.endsWith("%") };
  return { value: null, valueLabel: s, percent: false };
}
const optionalUrl = (s: string) => (s.trim() ? s.trim() : null);

export type MetricForm = { blogId: string | null; tool: MetricTool; metric: string; value: string; unit: string; measuredOn: string; evidenceUrl: string; memo: string };
/** One site-level value typed by hand. */
export function metricFromForm(f: MetricForm, now = new Date()): MetricInput {
  const measuredOn = parseDate(f.measuredOn, now);
  if (!measuredOn) throw new Error("측정일이 올바르지 않습니다(YYYY-MM-DD, 미래 날짜 불가).");
  const v = parseValue(f.value);
  return checkInput({
    blogId: f.blogId,
    tool: f.tool,
    metric: f.metric.trim(),
    scope: "site",
    dimension: "",
    value: v.value,
    valueLabel: v.valueLabel,
    unit: f.unit.trim() || (v.percent ? "%" : ""),
    measuredOn,
    evidenceUrl: optionalUrl(f.evidenceUrl),
    memo: f.memo.trim(),
  });
}

/** Validates rows sent by the browser. Only these fields reach the database. */
export function parseMetricBatch(input: unknown, now = new Date()): MetricInput[] {
  const list = (input as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list) || list.length === 0) throw new Error("저장할 값이 없습니다.");
  if (list.length > MAX_METRICS_PER_REQUEST) throw new Error(`한 번에 ${MAX_METRICS_PER_REQUEST}개까지 저장할 수 있습니다.`);
  return list.map((v, i) => {
    const t = (v ?? {}) as Record<string, unknown>;
    try {
      const str = (x: unknown) => {
        if (typeof x !== "string") throw new Error("형식이 올바르지 않습니다.");
        return x.trim();
      };
      if (t.blogId !== null && typeof t.blogId !== "string") throw new Error("블로그 계정이 올바르지 않습니다.");
      if (t.value !== null && typeof t.value !== "number") throw new Error("값은 숫자나 null이어야 합니다.");
      if (t.valueLabel !== null && typeof t.valueLabel !== "string") throw new Error("표시 문구가 올바르지 않습니다.");
      if (t.evidenceUrl !== null && typeof t.evidenceUrl !== "string") throw new Error("근거 URL이 올바르지 않습니다.");
      const measuredOn = typeof t.measuredOn === "string" ? parseDate(t.measuredOn, now) : null;
      if (!measuredOn) throw new Error("측정일이 올바르지 않습니다.");
      return checkInput({
        blogId: t.blogId,
        tool: t.tool as MetricTool,
        metric: str(t.metric),
        scope: t.scope as MetricScope,
        dimension: str(t.dimension),
        value: t.value === null ? null : round4(t.value),
        valueLabel: t.valueLabel === null ? null : t.valueLabel.trim(),
        unit: str(t.unit),
        measuredOn,
        evidenceUrl: t.evidenceUrl === null ? null : optionalUrl(t.evidenceUrl),
        memo: str(t.memo),
      });
    } catch (e) {
      throw new Error(`${i + 1}번째 값: ${e instanceof Error ? e.message : "형식이 올바르지 않습니다."}`);
    }
  });
}

const SEP = "\u001f";
/** Same columns and normalization as the blog_metric_snapshots_measurement_key constraint. */
export const metricKey = (r: MetricInput) =>
  [r.blogId ?? "", r.tool, normalizePhrase(r.metric), r.scope, r.scope === "query" ? normalizePhrase(r.dimension) : r.dimension.trim(), r.measuredOn].join(SEP);
const sameValue = (a: MetricInput, b: MetricInput) => a.value === b.value && a.valueLabel === b.valueLabel;

// ---------- Search Console CSV ----------

/** The names stored for each Search Console column, whatever the language of the export. */
export const GSC_METRICS = {
  clicks: { metric: "클릭수", unit: "회", kind: "count" },
  impressions: { metric: "노출수", unit: "회", kind: "count" },
  ctr: { metric: "CTR", unit: "%", kind: "percent" },
  position: { metric: "평균 게재순위", unit: "위", kind: "position" },
} as const;
type GscMetric = keyof typeof GSC_METRICS;
const gscAliases: Record<string, GscMetric | "query" | "page"> = {
  "top queries": "query", queries: "query", query: "query", "인기 검색어": "query", 검색어: "query", 쿼리: "query", "인기 쿼리": "query",
  "top pages": "page", pages: "page", page: "page", "인기 페이지": "page", 페이지: "page",
  clicks: "clicks", 클릭수: "clicks", "클릭 수": "clicks", 클릭: "clicks",
  impressions: "impressions", 노출수: "impressions", "노출 수": "impressions", 노출: "impressions",
  ctr: "ctr", 클릭률: "ctr",
  position: "position", "average position": "position", 게재순위: "position", "평균 게재순위": "position", 순위: "position",
};

function gscNumber(raw: string, kind: "count" | "percent" | "position"): number | null {
  const s = raw.trim().replace(/,/g, "").replace(/%$/, "").trim();
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  if (!(kind === "count" ? /^\d+$/ : /^\d+(\.\d+)?$/).test(s)) throw new Error(kind === "count" ? "클릭수·노출수는 0 이상의 정수여야 합니다." : "CTR·게재순위는 0 이상의 숫자여야 합니다.");
  const n = Number(s);
  if (kind === "count" && !Number.isSafeInteger(n)) throw new Error("값이 너무 큽니다.");
  if (kind === "percent" && n > 100) throw new Error("CTR은 0~100% 범위여야 합니다.");
  return round4(n);
}

export type MetricImport = {
  scope: "query" | "page";
  /** Values to store. Values that are already stored are not here. */
  rows: MetricInput[];
  added: number;
  duplicates: number;
  /** Same measurement already stored with another value. Skipped: the stored value stays. */
  conflicts: number;
  invalid: { line: number; reason: string }[];
};
export type GscImportOptions = { blogId: string | null; measuredOn: string; evidenceUrl: string | null; now?: Date };

/** A Search Console "queries" or "pages" export, with English or Korean headers. Counts are in values. */
export function importGsc(csv: string, existing: MetricInput[], opts: GscImportOptions): MetricImport {
  if (csv.length > MAX_METRIC_CSV) throw new Error("CSV 파일이 너무 큽니다. (최대 2MB)");
  const now = opts.now ?? new Date();
  const measuredOn = parseDate(opts.measuredOn, now);
  if (!measuredOn) throw new Error("측정일이 올바르지 않습니다(YYYY-MM-DD, 미래 날짜 불가).");
  const evidenceUrl = opts.evidenceUrl?.trim() || null;
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("헤더와 데이터 행이 필요합니다.");
  const cols: Partial<Record<GscMetric | "query" | "page", number>> = {};
  rows[0].forEach((h, i) => {
    const name = gscAliases[h.normalize("NFKC").trim().toLowerCase()];
    if (name && cols[name] === undefined) cols[name] = i;
  });
  const scope = cols.query !== undefined ? "query" : cols.page !== undefined ? "page" : null;
  if (!scope) throw new Error("검색어(Top queries) 또는 페이지(Top pages) 열이 필요합니다.");
  const metrics = (Object.keys(GSC_METRICS) as GscMetric[]).filter((m) => cols[m] !== undefined);
  if (metrics.length === 0) throw new Error("클릭수·노출수·CTR·게재순위 중 하나 이상의 열이 필요합니다.");
  const stored = new Map(existing.map((r) => [metricKey(r), r]));
  const seen = new Set<string>();
  const result: MetricImport = { scope, rows: [], added: 0, duplicates: 0, conflicts: 0, invalid: [] };
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const bad = (reason: string) => void result.invalid.push({ line, reason });
    const dimension = (r[cols[scope]!] ?? "").trim();
    if (!dimension) return bad(scope === "query" ? "검색어가 비어 있습니다." : "페이지 주소가 비어 있습니다.");
    let values: MetricInput[];
    try {
      values = metrics.flatMap((m) => {
        const value = gscNumber(r[cols[m]!] ?? "", GSC_METRICS[m].kind);
        if (value === null) return [];
        const { metric, unit } = GSC_METRICS[m];
        return [checkInput({ blogId: opts.blogId, tool: "gsc", metric, scope, dimension, value, valueLabel: null, unit, measuredOn, evidenceUrl, memo: "" })];
      });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "값이 올바르지 않습니다.");
    }
    if (values.length === 0) return bad("값이 모두 비어 있습니다.");
    for (const v of values) {
      const key = metricKey(v);
      const old = stored.get(key);
      if (old) {
        if (sameValue(old, v)) result.duplicates++;
        else result.conflicts++;
      } else if (seen.has(key)) result.duplicates++;
      else if (existing.length + result.rows.length >= MAX_METRICS) return bad(`최대 ${MAX_METRICS.toLocaleString("en-US")}개까지 저장할 수 있습니다.`);
      else {
        seen.add(key);
        result.rows.push(v);
        result.added++;
      }
    }
  });
  return result;
}

// ---------- database mapping ----------

export const METRIC_COLUMNS = "id,blog_id,tool,metric,scope,dimension,value,value_label,unit,measured_on,evidence_url,memo";
export const METRIC_CONFLICT = "workspace_id,blog_id,tool,metric_key,scope,dimension_key,measured_on";
export type MetricDbRow = {
  id: string;
  blog_id: string | null;
  tool: MetricTool;
  metric: string;
  scope: MetricScope;
  dimension: string;
  value: number | string | null;
  value_label: string | null;
  unit: string;
  measured_on: string;
  evidence_url: string | null;
  memo: string;
};
export const dbToMetric = (r: MetricDbRow): MetricSnapshot => ({
  id: r.id,
  blogId: r.blog_id,
  tool: r.tool,
  metric: r.metric,
  scope: r.scope,
  dimension: r.dimension,
  // numeric columns may come back as strings
  value: r.value === null ? null : Number(r.value),
  valueLabel: r.value_label,
  unit: r.unit,
  measuredOn: r.measured_on,
  evidenceUrl: r.evidence_url,
  memo: r.memo,
});
export const metricsToDbRows = (rows: MetricInput[], workspaceId: string, userId: string) =>
  rows.map((r) => ({
    workspace_id: workspaceId,
    blog_id: r.blogId,
    tool: r.tool,
    metric: r.metric,
    scope: r.scope,
    dimension: r.dimension,
    value: r.value,
    value_label: r.valueLabel,
    unit: r.unit,
    measured_on: r.measuredOn,
    evidence_url: r.evidenceUrl,
    memo: r.memo,
    created_by: userId,
  }));

// ---------- views ----------

export function formatMetricValue(r: Pick<MetricInput, "value" | "valueLabel" | "unit">): string {
  if (r.valueLabel !== null) return r.valueLabel;
  if (r.value === null) return "N/A";
  const n = r.value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  return r.unit === "%" ? `${n}%` : r.unit ? `${n} ${r.unit}` : n;
}

export const filterMetrics = (rows: MetricSnapshot[], filter: BlogFilterValue) => rows.filter((r) => matchesBlogFilter(r.blogId, filter));
const byDateDesc = (a: MetricSnapshot, b: MetricSnapshot) => b.measuredOn.localeCompare(a.measuredOn) || a.id.localeCompare(b.id);

export type ToolSummary = {
  tool: MetricTool;
  count: number;
  /** One line per site-level metric. "표 참고" when accounts differ: their values are not combined. */
  items: { metric: string; value: string; note: string }[];
  queries: number;
  pages: number;
  latest: string | null;
};
/** What one tool recorded for the filtered rows. Never a total across tools or accounts. */
export function toolSummary(rows: MetricSnapshot[], tool: MetricTool): ToolSummary {
  const own = rows.filter((r) => r.tool === tool).sort(byDateDesc);
  const site = new Map<string, MetricSnapshot[]>();
  for (const r of own.filter((r) => r.scope === "site")) {
    const key = normalizePhrase(r.metric);
    site.set(key, [...(site.get(key) ?? []), r]);
  }
  const items = [...site.values()].map((list) => {
    if (new Set(list.map((r) => r.blogId ?? "")).size > 1) return { metric: list[0].metric, value: "표 참고", note: "계정마다 따로 기록합니다." };
    return { metric: list[0].metric, value: formatMetricValue(list[0]), note: list[0].measuredOn };
  });
  const latestDimensions = (scope: MetricScope) => {
    const list = own.filter((r) => r.scope === scope);
    return list.length ? new Set(list.filter((r) => r.measuredOn === list[0].measuredOn).map((r) => normalizePhrase(r.dimension))).size : 0;
  };
  return { tool, count: own.length, items, queries: latestDimensions("query"), pages: latestDimensions("page"), latest: own[0]?.measuredOn ?? null };
}

export type IndexPoint = { id: string; measuredOn: string; value: string; change: string };
export type IndexSeries = { key: string; blogId: string | null; tool: MetricTool; points: IndexPoint[] };
/**
 * Blog index values per account and tool, oldest first. Only the tool's own values are shown;
 * the change column compares a tool's value with its previous value and nothing else.
 */
export function indexSeries(rows: MetricSnapshot[]): IndexSeries[] {
  const groups = new Map<string, MetricSnapshot[]>();
  for (const r of rows.filter((r) => r.scope === "site" && isIndexMetric(r.metric))) {
    const key = `${r.blogId ?? ""}${SEP}${r.tool}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.measuredOn.localeCompare(b.measuredOn) || a.id.localeCompare(b.id));
    const points = sorted.map((r, i) => {
      const prev = sorted[i - 1];
      let change = "첫 기록";
      if (prev) {
        if (prev.value !== null && r.value !== null) {
          const d = round4(r.value - prev.value);
          change = d === 0 ? "같음" : `${d > 0 ? "+" : ""}${d.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}`;
        } else change = sameValue(prev, r) ? "같음" : "바뀜";
      }
      return { id: r.id, measuredOn: r.measuredOn, value: formatMetricValue(r), change };
    });
    return { key, blogId: list[0].blogId, tool: list[0].tool, points };
  });
}
