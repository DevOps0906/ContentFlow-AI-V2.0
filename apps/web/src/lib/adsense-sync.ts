// AdSense collector (CF-07b A6, ANALYTICS_SYNC.md sections 2, 4, D6). Server-only, no database access.
// Rules kept here so they can be tested without Google:
//  - status is always "estimated" (the API never produces a finalized value),
//  - the currency comes from the report header (METRIC_CURRENCY column) and a report without one fails,
//  - the time zone is the account's own (accounts.get timeZone.id), requested as ACCOUNT_TIME_ZONE,
//  - DATE x PAGE_URL first; when Google refuses PAGE_URL the report is requested again at site x day level
//    (page = ''), never both in one range (a site total next to page rows would be counted twice).
// Tokens and response bodies are never logged.
import { normalizePage, UNATTRIBUTED_PAGE } from "./revenue";
import { addDays, syncRange as gscRange, utcDay } from "./gsc-sync";

export const ADSENSE_SYNC = {
  /** Same window rules as Search Console (90 days first run, 3 days refetch). */
  firstDays: 90,
  /** Workspace cap of revenue_rows; replace_synced_range checks the same number. */
  rowCap: 20_000,
  maxPageChars: 500,
  timeoutMs: 20_000,
  totalMs: 45_000,
} as const;

export const ADSENSE_METRICS = ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"] as const;
export const adsenseRange = gscRange;
export { addDays, utcDay };

export class AdsenseSyncError extends Error {
  constructor(public kind: "auth" | "quota" | "failed" | "cap" | "bad_response" | "currency" | "timezone", message: string) {
    super(message);
  }
}

/** Row JSON of replace_synced_range for provider adsense. */
export type AdsenseRow = {
  report_date: string;
  status: "estimated";
  currency: string;
  page: string;
  timezone: string;
  revenue: number;
  pageviews: number;
  impressions: number;
  clicks: number;
};
export type AdsenseReport = { rows: AdsenseRow[]; pageLevel: boolean; skipped: number; currency: string; timezone: string };

const bad = () => new AdsenseSyncError("bad_response", "AdSense 응답을 확인하지 못했습니다.");
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isQuota = (status: number, text: string) => status === 429 || (status === 403 && /rateLimitExceeded|quotaExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(text));

async function getJson(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(ADSENSE_SYNC.timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new AdsenseSyncError("failed", "AdSense에 연결하지 못했습니다.");
  }
  const text = (await res.text()).slice(0, 5_000_000);
  if (res.status === 401) throw new AdsenseSyncError("auth", "AdSense 권한이 만료되었습니다.");
  if (isQuota(res.status, text.slice(0, 2_000))) throw new AdsenseSyncError("quota", "AdSense 요청 한도에 도달했습니다.");
  return { status: res.status, text };
}

/** IANA zone id of the account (accounts.get timeZone.id). Missing or unknown -> the run fails, nothing is guessed. */
export async function fetchAccountTimeZone(apiBase: string, accessToken: string, account: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { status, text } = await getJson(`${apiBase}/v2/${account}`, accessToken, fetchImpl);
  if (status !== 200) throw new AdsenseSyncError("failed", "AdSense가 요청을 처리하지 못했습니다.");
  let id: unknown;
  try {
    id = (JSON.parse(text) as { timeZone?: { id?: unknown } | null }).timeZone?.id;
  } catch {
    throw bad();
  }
  if (typeof id !== "string" || !id || id.length > 64) throw new AdsenseSyncError("timezone", "AdSense 계정의 시간대를 확인하지 못했습니다.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: id });
  } catch {
    throw new AdsenseSyncError("timezone", "AdSense 계정의 시간대를 확인하지 못했습니다.");
  }
  return id;
}

function reportUrl(apiBase: string, account: string, range: { start: string; end: string }, pageLevel: boolean, limit: number): string {
  const q = new URLSearchParams();
  for (const m of ADSENSE_METRICS) q.append("metrics", m);
  q.append("dimensions", "DATE");
  if (pageLevel) q.append("dimensions", "PAGE_URL");
  q.set("dateRange", "CUSTOM");
  for (const [k, d] of [["startDate", range.start], ["endDate", range.end]] as const) {
    const [y, m, day] = d.split("-");
    q.set(`${k}.year`, String(Number(y)));
    q.set(`${k}.month`, String(Number(m)));
    q.set(`${k}.day`, String(Number(day)));
  }
  // currencyCode is left out on purpose: the account currency is read back from the header, never assumed.
  q.set("reportingTimeZone", "ACCOUNT_TIME_ZONE");
  q.set("limit", String(limit));
  return `${apiBase}/v2/${account}/reports:generate?${q.toString()}`;
}

type Header = { name?: unknown; type?: unknown; currencyCode?: unknown };
function num(v: unknown, integer: boolean): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw bad();
  return n;
}

/** Parses one reports.generate body. Currency is taken from the ESTIMATED_EARNINGS header; absent -> failure. */
export function parseAdsenseReport(text: string, pageLevel: boolean, range: { start: string; end: string }, timezone: string, cap: number): AdsenseReport {
  let body: { headers?: unknown; rows?: unknown; totalMatchedRows?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (!Array.isArray(body.headers)) throw bad();
  const headers = body.headers as Header[];
  const idx = (name: string) => headers.findIndex((h) => h && h.name === name);
  const iDate = idx("DATE");
  const iPage = idx("PAGE_URL");
  const iRev = idx("ESTIMATED_EARNINGS");
  const iPv = idx("PAGE_VIEWS");
  const iImp = idx("IMPRESSIONS");
  const iClk = idx("CLICKS");
  if (iDate < 0 || iRev < 0 || iPv < 0 || iImp < 0 || iClk < 0 || (pageLevel && iPage < 0)) throw bad();
  const revHeader = headers[iRev];
  const currency = revHeader.type === "METRIC_CURRENCY" && typeof revHeader.currencyCode === "string" ? revHeader.currencyCode : "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new AdsenseSyncError("currency", "AdSense 보고서에서 통화를 확인하지 못했습니다.");
  const rawRows = body.rows === undefined ? [] : body.rows;
  if (!Array.isArray(rawRows)) throw bad();
  // totalMatchedRows (int64 as string) larger than what came back = Google cut the report short.
  const total = body.totalMatchedRows === undefined ? null : Number(body.totalMatchedRows);
  if (total !== null && Number.isFinite(total) && total > rawRows.length) throw new AdsenseSyncError("cap", "AdSense 보고서가 잘렸습니다. 기간이나 페이지 수를 줄여주세요.");
  if (rawRows.length > cap) throw new AdsenseSyncError("cap", "가져올 데이터가 워크스페이스 행 상한을 넘습니다. 기간이나 페이지 수를 줄여주세요.");

  const merged = new Map<string, AdsenseRow>();
  const skipped = 0;
  for (const raw of rawRows) {
    const cells = (raw as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(cells) || cells.length < headers.length) throw bad();
    const val = (i: number) => (cells[i] as { value?: unknown } | null)?.value;
    const date = val(iDate);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < range.start || date > range.end) throw bad();
    let page = "";
    if (pageLevel) {
      const p = val(iPage);
      if (typeof p !== "string") throw bad();
      page = p.trim();
      // A URL that cannot be stored (empty or over the column limit) is summed into one bucket per day, so the
      // run stays complete; '' itself would read as a site total.
      if (!page || page.length > ADSENSE_SYNC.maxPageChars) page = UNATTRIBUTED_PAGE;
    }
    const row: AdsenseRow = {
      report_date: date,
      status: "estimated",
      currency,
      page,
      timezone,
      revenue: round4(num(val(iRev), false)),
      pageviews: num(val(iPv), true),
      impressions: num(val(iImp), true),
      clicks: num(val(iClk), true),
    };
    // Two URLs that normalize to one page (query string, case, trailing slash) are one stored measurement.
    const key = `${date}|${normalizePage(page)}`;
    const prev = merged.get(key);
    if (prev) {
      prev.revenue = round4(prev.revenue + row.revenue);
      prev.pageviews += row.pageviews;
      prev.impressions += row.impressions;
      prev.clicks += row.clicks;
    } else merged.set(key, row);
  }
  return { rows: [...merged.values()], pageLevel, skipped, currency, timezone };
}

/** Only INVALID_ARGUMENT that names the dimension / PAGE_URL means "this account cannot report by page". */
export function isPageUrlRefusal(text: string): boolean {
  try {
    const e = (JSON.parse(text) as { error?: { status?: unknown; message?: unknown } | null }).error;
    return e?.status === "INVALID_ARGUMENT" && typeof e.message === "string" && /PAGE_URL|dimension/i.test(e.message);
  } catch {
    return false;
  }
}

/**
 * One report per sync: DATE x PAGE_URL, and when Google answers 400 (INVALID_ARGUMENT naming the dimension), or when the
 * page report is over the row cap or cut short, once more at DATE only. All metrics of a row come from the same report, so
 * RPM = ESTIMATED_EARNINGS / PAGE_VIEWS of that report and nothing else.
 */
export async function fetchAdsenseReport(
  apiBase: string,
  accessToken: string,
  account: string,
  timezone: string,
  range: { start: string; end: string },
  fetchImpl: typeof fetch = fetch,
  cap: number = ADSENSE_SYNC.rowCap,
): Promise<AdsenseReport> {
  for (const pageLevel of [true, false]) {
    const { status, text } = await getJson(reportUrl(apiBase, account, range, pageLevel, cap + 1), accessToken, fetchImpl);
    if (status === 400 && pageLevel && isPageUrlRefusal(text)) continue;
    if (status !== 200) throw new AdsenseSyncError("failed", "AdSense가 요청을 처리하지 못했습니다.");
    try {
      return parseAdsenseReport(text, pageLevel, range, timezone, cap);
    } catch (e) {
      // Too many page rows (or a cut-short report): the site x day report is the answer, not a failed run.
      if (pageLevel && e instanceof AdsenseSyncError && e.kind === "cap") continue;
      throw e;
    }
  }
  throw new AdsenseSyncError("failed", "AdSense가 요청을 처리하지 못했습니다.");
}
