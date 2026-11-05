// Revenue report import and aggregation. Rules from the monetization plan:
//  - observed/estimated and finalized (settled) amounts are different things: never added together
//  - a re-import of the same report can not double count (same source+status+date+page is skipped)
//  - a site total and the page rows of the same day are never added together
//  - missing values stay missing (N/A); they are not turned into 0
//  - amounts in different currencies are never summed
//  - RPM only uses revenue and page views from the same report rows
import { parseCsv } from "./keywords";
import type { Article } from "./content";

export type RevenueStatus = "estimated" | "finalized";
export const statusLabel: Record<RevenueStatus, string> = {
  estimated: "관측 예상",
  finalized: "확정 정산",
};
export type RevenueRow = {
  source: string;
  status: RevenueStatus;
  currency: string;
  date: string; // YYYY-MM-DD
  /** "" means a site-level total row. */
  page: string;
  revenue: number | null;
  pageviews: number | null;
  impressions: number | null;
  clicks: number | null;
  importedAt: string;
};
export const REVENUE_STORAGE_KEY = "contentflow.revenue.v1";
export const MAX_REVENUE_ROWS = 20000;
export const MAX_REVENUE_CSV = 2_000_000;

const aliases: Record<string, string> = {
  date: "date", 날짜: "date", day: "date", 일자: "date",
  page: "page", url: "page", 페이지: "page", "page url": "page", path: "page",
  revenue: "revenue", earnings: "revenue", "estimated earnings": "revenue", 수익: "revenue", 예상수익: "revenue", "예상 수익": "revenue",
  pageviews: "pageviews", "page views": "pageviews", 조회수: "pageviews", 페이지뷰: "pageviews",
  impressions: "impressions", 노출: "impressions", 노출수: "impressions",
  clicks: "clicks", 클릭: "clicks", 클릭수: "clicks",
  currency: "currency", 통화: "currency",
};

export function normalizePage(page: string): string {
  const p = page.trim();
  if (!p) return "";
  try {
    const u = new URL(p);
    return (u.host + u.pathname).replace(/\/+$/, "").toLowerCase() + (u.pathname === "/" && u.search ? u.search : "");
  } catch {
    return p.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() || "/";
  }
}

function parseDate(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > now.getTime() + 2 * 86400000) return null; // reports do not cover the future
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** "" → null (missing). Throws on anything that is not a plain non-negative number. */
function parseAmount(raw: string | undefined, integer: boolean): number | null {
  const s = (raw ?? "").trim().replace(/,/g, "");
  if (s === "" || s === "-" ) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("숫자 형식이 올바르지 않습니다.");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error("숫자 형식이 올바르지 않습니다.");
  if (integer && !Number.isInteger(n)) throw new Error("정수여야 합니다.");
  return n;
}

export const rowKey = (r: Pick<RevenueRow, "source" | "status" | "currency" | "date" | "page">) =>
  [r.source.toLowerCase(), r.status, r.currency, r.date, normalizePage(r.page)].join("|");

export type RevenueImport = {
  rows: RevenueRow[];
  added: number;
  duplicates: number;
  invalid: { line: number; reason: string }[];
};
export type ImportOptions = { source: string; status: RevenueStatus; currency: string; now?: Date };

export function importRevenue(csv: string, existing: RevenueRow[], opts: ImportOptions): RevenueImport {
  if (csv.length > MAX_REVENUE_CSV) throw new Error("CSV 파일이 너무 큽니다. (최대 2MB)");
  const source = opts.source.trim();
  if (!source || source.length > 40) throw new Error("보고서 출처를 1~40자로 입력해주세요.");
  if (!["estimated", "finalized"].includes(opts.status)) throw new Error("예상/확정 구분을 선택해주세요.");
  const defCurrency = opts.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(defCurrency)) throw new Error("통화는 KRW, USD 같은 3글자 코드여야 합니다.");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("헤더와 데이터 행이 필요합니다.");
  const cols: Record<string, number> = {};
  rows[0].forEach((h, i) => {
    const k = aliases[h.normalize("NFKC").trim().toLowerCase()];
    if (k && !(k in cols)) cols[k] = i;
  });
  if (!("date" in cols)) throw new Error("날짜(date) 열이 필요합니다.");
  if (!("revenue" in cols) && !("pageviews" in cols) && !("impressions" in cols) && !("clicks" in cols))
    throw new Error("수익, 조회수, 노출, 클릭 중 하나 이상의 열이 필요합니다.");
  const now = opts.now ?? new Date();
  const seen = new Set(existing.map(rowKey));
  const result: RevenueImport = { rows: [...existing], added: 0, duplicates: 0, invalid: [] };
  const stamp = now.toISOString();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const bad = (reason: string) => void result.invalid.push({ line, reason });
    const date = parseDate(r[cols.date] ?? "", now);
    if (!date) return bad("날짜가 올바르지 않습니다(YYYY-MM-DD, 미래 날짜 불가).");
    let revenue: number | null, pageviews: number | null, impressions: number | null, clicks: number | null;
    try {
      revenue = "revenue" in cols ? parseAmount(r[cols.revenue], false) : null;
      pageviews = "pageviews" in cols ? parseAmount(r[cols.pageviews], true) : null;
      impressions = "impressions" in cols ? parseAmount(r[cols.impressions], true) : null;
      clicks = "clicks" in cols ? parseAmount(r[cols.clicks], true) : null;
    } catch (e) {
      return bad(e instanceof Error ? e.message : "값이 올바르지 않습니다.");
    }
    if (revenue === null && pageviews === null && impressions === null && clicks === null)
      return bad("값이 모두 비어 있습니다.");
    const currency = "currency" in cols && (r[cols.currency] ?? "").trim() ? r[cols.currency].trim().toUpperCase() : defCurrency;
    if (!/^[A-Z]{3}$/.test(currency)) return bad("통화 코드가 올바르지 않습니다.");
    const page = ("page" in cols ? (r[cols.page] ?? "") : "").trim();
    if (page.length > 500) return bad("페이지 주소가 너무 깁니다.");
    const row: RevenueRow = { source, status: opts.status, currency, date, page, revenue, pageviews, impressions, clicks, importedAt: stamp };
    const key = rowKey(row);
    if (seen.has(key)) return void result.duplicates++;
    if (result.rows.length >= MAX_REVENUE_ROWS) return bad(`최대 ${MAX_REVENUE_ROWS}행까지 저장할 수 있습니다.`);
    seen.add(key);
    result.rows.push(row);
    result.added++;
  });
  return result;
}

export type Summary = {
  source: string;
  status: RevenueStatus;
  currency: string;
  from: string;
  to: string;
  days: number;
  revenue: number | null;
  pageviews: number | null;
  clicks: number | null;
  impressions: number | null;
  /** revenue per 1,000 page views from rows that carry both; null → N/A */
  rpm: number | null;
  /** days where a site total existed, and days built from page rows */
  siteDays: number;
  pageDays: number;
};

const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

/**
 * One summary per source+status+currency. For each day a site-level total row wins; the page
 * rows of that day are used only when there is no site total, so nothing is counted twice.
 */
export function summarize(rows: RevenueRow[]): Summary[] {
  const groups = new Map<string, RevenueRow[]>();
  for (const r of rows) {
    const k = [r.source.toLowerCase(), r.status, r.currency].join("|");
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: Summary[] = [];
  for (const g of groups.values()) {
    const byDay = new Map<string, RevenueRow[]>();
    for (const r of g) (byDay.get(r.date) ?? byDay.set(r.date, []).get(r.date)!).push(r);
    let revenue: number | null = null, pageviews: number | null = null, clicks: number | null = null, impressions: number | null = null;
    let rpmRev = 0, rpmPv = 0, rpmRows = 0, siteDays = 0, pageDays = 0;
    for (const day of byDay.values()) {
      const site = day.filter((r) => r.page === "");
      const use = site.length ? site : day;
      site.length ? siteDays++ : pageDays++;
      for (const r of use) {
        revenue = add(revenue, r.revenue);
        pageviews = add(pageviews, r.pageviews);
        clicks = add(clicks, r.clicks);
        impressions = add(impressions, r.impressions);
        if (r.revenue !== null && r.pageviews !== null && r.pageviews > 0) {
          rpmRev += r.revenue;
          rpmPv += r.pageviews;
          rpmRows++;
        }
      }
    }
    const dates = [...byDay.keys()].sort();
    out.push({
      source: g[0].source,
      status: g[0].status,
      currency: g[0].currency,
      from: dates[0],
      to: dates[dates.length - 1],
      days: dates.length,
      revenue, pageviews, clicks, impressions,
      rpm: rpmRows > 0 && rpmPv > 0 ? (rpmRev / rpmPv) * 1000 : null,
      siteDays, pageDays,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.status.localeCompare(b.status) || a.currency.localeCompare(b.currency));
}

export type PageSummary = {
  page: string;
  currency: string;
  status: RevenueStatus;
  revenue: number | null;
  pageviews: number | null;
  article: Article | null;
};
/** Page-level revenue per page, linked to articles whose WordPress URL matches. */
export function pageSummaries(rows: RevenueRow[], articles: Article[], limit = 20): PageSummary[] {
  const byUrl = new Map<string, Article>();
  for (const a of articles) if (a.remote?.url) byUrl.set(normalizePage(a.remote.url), a);
  const map = new Map<string, PageSummary>();
  for (const r of rows) {
    if (r.page === "") continue;
    const key = [normalizePage(r.page), r.status, r.currency].join("|");
    const cur = map.get(key) ?? {
      page: r.page, currency: r.currency, status: r.status, revenue: null, pageviews: null,
      article: byUrl.get(normalizePage(r.page)) ?? null,
    };
    cur.revenue = add(cur.revenue, r.revenue);
    cur.pageviews = add(cur.pageviews, r.pageviews);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1)).slice(0, limit);
}

export function isRevenueRow(v: unknown): v is RevenueRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
  return (
    ["source", "currency", "date", "page", "importedAt"].every((k) => typeof r[k] === "string") &&
    (r.status === "estimated" || r.status === "finalized") &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) &&
    [r.revenue, r.pageviews, r.impressions, r.clicks].every(num)
  );
}
export function parseRevenue(raw: string | null): RevenueRow[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isRevenueRow)) throw new Error("저장된 수익 데이터 형식을 읽을 수 없습니다.");
  return parsed;
}
export function formatMoney(n: number | null, currency: string) {
  if (n === null) return "N/A";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  return `${n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}