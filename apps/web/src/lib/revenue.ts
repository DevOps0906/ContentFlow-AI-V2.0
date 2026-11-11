// Revenue report import and aggregation. Rules from the monetization plan:
//  - observed/estimated and finalized (settled) amounts are different things: never added together
//  - a re-import of the same report can not double count (same source+status+date+page+zone is skipped)
//  - a report whose period partly overlaps a stored one is refused as a whole
//  - a site total and the page rows of the same day are never added together
//  - missing values stay missing (N/A); they are not turned into 0
//  - amounts in different currencies are never summed
//  - RPM only uses revenue and page views from the same report rows
import { parseCsv } from "./keywords";
import type { Article } from "./content";
import { ALL_BLOGS, matchesBlogFilter, type BlogFilterValue } from "./blogs";

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
  /** IANA name the report was exported in. null: imported before this was recorded. */
  timezone: string | null;
  /** First and last day the whole import covered (YYYY-MM-DD). null as for `timezone`. */
  periodStart: string | null;
  periodEnd: string | null;
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

export function parseDate(raw: string, now: Date): string | null {
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

export const rowKey = (r: Pick<RevenueRow, "source" | "status" | "currency" | "date" | "page" | "timezone">) =>
  [r.source.toLowerCase(), r.status, r.currency, r.date, normalizePage(r.page), ...(r.timezone ? [r.timezone] : [])].join("|");

/** Canonical IANA name, or null when the runtime does not know the zone. */
export function normalizeTimezone(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(v)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

type ReportRow = Pick<RevenueRow, "source" | "status" | "currency" | "page">;
const reportKey = (r: ReportRow) =>
  [r.source.trim().toLowerCase(), r.status, r.currency, r.page === "" ? "site" : "page"].join("|");

/**
 * The stored row that makes this import a partial overlap, or null. The same report with exactly
 * the same period is not an overlap (its rows are skipped); a different period touching the same
 * days is. Stored rows with no time zone can not be told apart, so any shared date counts.
 */
export function findOverlap(
  existing: RevenueRow[],
  incoming: ReportRow[],
  report: { timezone: string; periodStart: string; periodEnd: string },
): RevenueRow | null {
  const { timezone, periodStart, periodEnd } = report;
  const keys = new Set(incoming.map(reportKey));
  for (const e of existing) {
    if (!keys.has(reportKey(e))) continue;
    if (e.timezone === null || e.periodStart === null || e.periodEnd === null) {
      if (e.date >= periodStart && e.date <= periodEnd) return e;
      continue;
    }
    if (e.timezone !== timezone) continue;
    if (e.periodStart === periodStart && e.periodEnd === periodEnd) continue;
    if (e.periodStart <= periodEnd && periodStart <= e.periodEnd) return e;
  }
  return null;
}

// revenue is numeric(18,4) in the database, so finer digits are not a difference.
const sameValue = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && Math.round(a * 1e4) === Math.round(b * 1e4));
const sameValues = (a: RevenueRow, b: RevenueRow) =>
  sameValue(a.revenue, b.revenue) && a.pageviews === b.pageviews && a.impressions === b.impressions && a.clicks === b.clicks;

export type RevenueImport = {
  rows: RevenueRow[];
  added: number;
  duplicates: number;
  /** Rows of the same report and period whose stored values differ. Skipped: stored values stay. */
  conflicts: number;
  invalid: { line: number; reason: string }[];
};
export type ImportOptions = { source: string; status: RevenueStatus; currency: string; timezone: string; now?: Date };

export function importRevenue(csv: string, existing: RevenueRow[], opts: ImportOptions): RevenueImport {
  if (csv.length > MAX_REVENUE_CSV) throw new Error("CSV 파일이 너무 큽니다. (최대 2MB)");
  const source = opts.source.trim();
  if (!source || source.length > 40) throw new Error("보고서 출처를 1~40자로 입력해주세요.");
  if (!["estimated", "finalized"].includes(opts.status)) throw new Error("예상/확정 구분을 선택해주세요.");
  const defCurrency = opts.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(defCurrency)) throw new Error("통화는 KRW, USD 같은 3글자 코드여야 합니다.");
  const timezone = normalizeTimezone(opts.timezone);
  if (!timezone) throw new Error("시간대는 Asia/Seoul, UTC 같은 IANA 이름이어야 합니다.");
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
  const stored = new Map(existing.map((r) => [rowKey(r), r]));
  const seen = new Set(stored.keys());
  const result: RevenueImport = { rows: [...existing], added: 0, duplicates: 0, conflicts: 0, invalid: [] };
  const stamp = now.toISOString();
  const parsed: (RevenueRow & { line: number })[] = [];
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
    parsed.push({
      source, status: opts.status, currency, date, page, revenue, pageviews, impressions, clicks, importedAt: stamp,
      timezone, periodStart: null, periodEnd: null, line,
    });
  });
  if (parsed.length === 0) return result;
  // The period is what the file actually covers, decided before anything is stored.
  const dates = parsed.map((r) => r.date).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];
  const clash = findOverlap(existing, parsed, { timezone, periodStart, periodEnd });
  if (clash) {
    throw new Error(
      clash.timezone === null
        ? `시간대·기간 기록이 없는 기존 데이터(${clash.date})와 날짜가 겹쳐 가져오지 않았습니다. 기존 데이터를 삭제한 뒤 다시 가져와 주세요.`
        : `기존 보고서 기간(${clash.periodStart} ~ ${clash.periodEnd})과 일부만 겹쳐 가져오지 않았습니다(이번 파일 ${periodStart} ~ ${periodEnd}). 겹치지 않는 기간이나 기존과 똑같은 기간으로 다시 내보내 주세요.`,
    );
  }
  for (const { line, ...r } of parsed) {
    const row: RevenueRow = { ...r, periodStart, periodEnd };
    const key = rowKey(row);
    const old = stored.get(key);
    if (old) {
      if (sameValues(old, row)) result.duplicates++;
      else result.conflicts++;
      continue;
    }
    if (seen.has(key)) {
      result.duplicates++;
      continue;
    }
    if (result.rows.length >= MAX_REVENUE_ROWS) {
      result.invalid.push({ line, reason: `최대 ${MAX_REVENUE_ROWS}행까지 저장할 수 있습니다.` });
      continue;
    }
    seen.add(key);
    result.rows.push(row);
    result.added++;
  }
  return result;
}

export type Summary = {
  source: string;
  status: RevenueStatus;
  currency: string;
  timezone: string | null;
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
 * One summary per source+status+currency+time zone. For each day a site-level total row wins; the page
 * rows of that day are used only when there is no site total, so nothing is counted twice.
 */
export function summarize(rows: RevenueRow[]): Summary[] {
  const groups = new Map<string, RevenueRow[]>();
  for (const r of rows) {
    const k = [r.source.toLowerCase(), r.status, r.currency, r.timezone ?? ""].join("|");
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
      timezone: g[0].timezone,
      from: dates[0],
      to: dates[dates.length - 1],
      days: dates.length,
      revenue, pageviews, clicks, impressions,
      rpm: rpmRows > 0 && rpmPv > 0 ? (rpmRev / rpmPv) * 1000 : null,
      siteDays, pageDays,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.status.localeCompare(b.status) || a.currency.localeCompare(b.currency) || (a.timezone ?? "").localeCompare(b.timezone ?? ""));
}

export type PageSummary = {
  page: string;
  source: string;
  currency: string;
  status: RevenueStatus;
  timezone: string | null;
  revenue: number | null;
  pageviews: number | null;
  article: Article | null;
};
/** Page-level revenue per page and source. The confirmed public URL wins over a remote draft link. */
export function pageSummaries(rows: RevenueRow[], articles: Article[], limit = 20): PageSummary[] {
  const byUrl = new Map<string, Article>();
  for (const a of articles) if (a.remote?.url) byUrl.set(normalizePage(a.remote.url), a);
  for (const a of articles) if (a.publishedUrl) byUrl.set(normalizePage(a.publishedUrl), a);
  const map = new Map<string, PageSummary>();
  for (const r of rows) {
    if (r.page === "") continue;
    const key = [normalizePage(r.page), r.source.toLowerCase(), r.status, r.currency, r.timezone ?? ""].join("|");
    const cur = map.get(key) ?? {
      page: r.page, source: r.source, currency: r.currency, status: r.status, timezone: r.timezone, revenue: null, pageviews: null,
      article: byUrl.get(normalizePage(r.page)) ?? null,
    };
    cur.revenue = add(cur.revenue, r.revenue);
    cur.pageviews = add(cur.pageviews, r.pageviews);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1)).slice(0, limit);
}

/**
 * Which blog each article URL belongs to, with the same rule as `pageSummaries`: a confirmed
 * `publishedUrl` wins and `remote.url` only fills URLs no published article claims. Articles on
 * different blogs that share a URL can not be told apart, so it is unknown (null).
 */
function articleUrlBlogs(articles: Article[]) {
  const byUrl = new Map<string, string | null>();
  const claim = (url: string, blog: string | null) => {
    const key = normalizePage(url);
    byUrl.set(key, byUrl.has(key) && byUrl.get(key) !== blog ? null : blog);
  };
  const published = new Set<string>();
  for (const a of articles) {
    if (!a.publishedUrl) continue;
    published.add(normalizePage(a.publishedUrl));
    claim(a.publishedUrl, a.blogId ?? null);
  }
  const remote = new Map<string, string | null>();
  for (const a of articles) {
    if (!a.remote?.url || published.has(normalizePage(a.remote.url))) continue;
    const key = normalizePage(a.remote.url);
    const blog = a.blogId ?? null;
    remote.set(key, remote.has(key) && remote.get(key) !== blog ? null : blog);
  }
  for (const [key, blog] of remote) byUrl.set(key, blog);
  return byUrl;
}
/**
 * Page rows of one blog filter. A page row whose URL is not linked to an article with an account is
 * unclassified. Site totals (no page) belong to no account in any filter but "all": they are shown
 * apart by `unallocatedRevenue`, so the filters never overlap.
 */
export function filterRevenueByBlog(rows: RevenueRow[], articles: Article[], filter: BlogFilterValue): RevenueRow[] {
  if (filter === ALL_BLOGS) return rows;
  const byUrl = articleUrlBlogs(articles);
  return rows.filter((r) => r.page !== "" && matchesBlogFilter(byUrl.get(normalizePage(r.page)), filter));
}
/** The site-level total rows: revenue no account can claim. */
export const unallocatedRevenue = (rows: RevenueRow[]) => rows.filter((r) => r.page === "");

/**
 * Splits a list into chunks of at most `size`. With `groupKey`, consecutive items with the same key
 * (the values of one CSV row) never end up in two chunks; a chunk may be a little shorter then.
 */
export function chunkList<T>(list: T[], size: number, groupKey?: (item: T) => string): T[][] {
  const chunks: T[][] = [];
  let i = 0;
  while (i < list.length) {
    let end = Math.min(i + size, list.length);
    if (groupKey && end < list.length) {
      let cut = end;
      while (cut > i && groupKey(list[cut - 1]) === groupKey(list[cut])) cut--;
      if (cut > i) end = cut;
    }
    chunks.push(list.slice(i, end));
    i = end;
  }
  return chunks;
}

export type RevenueSendResult = { added: number; duplicates: number; failure: string | null; reloaded: boolean };
/**
 * Sends rows in chunks and refreshes afterwards even when a chunk fails: the chunks before it stay
 * stored, so the caller reports them instead of showing only the error.
 */
export async function sendRevenueChunks<T>(
  list: T[],
  send: (rows: T[]) => Promise<{ added?: unknown; duplicates?: unknown }>,
  reload: () => Promise<unknown>,
  size = 1000,
  groupKey?: (item: T) => string,
): Promise<RevenueSendResult> {
  let added = 0;
  let duplicates = 0;
  let failure: string | null = null;
  try {
    for (const chunk of chunkList(list, size, groupKey)) {
      const r = await send(chunk);
      added += Number(r.added ?? 0);
      duplicates += Number(r.duplicates ?? 0);
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : "가져오기에 실패했습니다.";
  }
  let reloaded = true;
  try {
    await reload();
  } catch {
    reloaded = false;
  }
  return { added, duplicates, failure, reloaded };
}
/** What the operator must be told about a send; empty when it went through and the list is fresh. */
export function revenueSendNotice(r: RevenueSendResult): string {
  const parts: string[] = [];
  if (r.failure) {
    parts.push(`${r.failure} 저장이 확인된 행은 ${r.added}행입니다(이미 있어서 건너뜀 ${r.duplicates}행).`);
    if (r.added + r.duplicates > 0) parts.push("같은 파일을 다시 가져오면 저장된 행은 건너뜁니다.");
  }
  if (!r.reloaded) parts.push("목록을 새로 불러오지 못했어요. 페이지를 새로고침해 주세요.");
  return parts.join(" ");
}

export function isRevenueRow(v: unknown): v is RevenueRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
  const opt = (x: unknown) => x === undefined || x === null || typeof x === "string";
  return (
    ["source", "currency", "date", "page", "importedAt"].every((k) => typeof r[k] === "string") &&
    (r.status === "estimated" || r.status === "finalized") &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) &&
    [r.timezone, r.periodStart, r.periodEnd].every(opt) &&
    [r.revenue, r.pageviews, r.impressions, r.clicks].every(num)
  );
}
export function parseRevenue(raw: string | null): RevenueRow[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isRevenueRow)) throw new Error("저장된 수익 데이터 형식을 읽을 수 없습니다.");
  // Rows saved before the time zone and period were recorded read as unknown, never guessed.
  return parsed.map((r) => ({ ...r, timezone: r.timezone ?? null, periodStart: r.periodStart ?? null, periodEnd: r.periodEnd ?? null }));
}
/** `maxDigits` keeps more precision where a small amount must not round to 0. */
export function formatMoney(n: number | null, currency: string, maxDigits?: number) {
  if (n === null) return "N/A";
  const digits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  return `${n.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, maxDigits ?? digits) })} ${currency}`;
}