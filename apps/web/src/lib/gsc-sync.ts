// Search Console collector (CF-07b A4, ANALYTICS_SYNC.md sections 2 and 4). Server-only, no database access:
// range math, searchAnalytics.query paging, de-duplication and the cap pre-check live here so they can be tested
// without Google. Dimensions are date x page only (query is out of scope). Tokens and bodies are never logged.

export const GSC_SYNC = {
  /** First run looks back this many days (inside Search Console's 16-month retention). */
  firstDays: 90,
  /** Days before the last successful range end that are fetched again: recent days settle late. */
  refetchDays: 3,
  /** searchAnalytics.query maximum page size. */
  rowLimit: 25_000,
  /** Workspace cap of blog_metric_snapshots (0017 trigger); replace_synced_range checks the same number. */
  metricRowCap: 30_000,
  /** Metric rows written per (date, page): clicks, impressions, ctr, position. */
  metricsPerPair: 4,
  /** metric.dimension length limit of blog_metric_snapshots. */
  maxPageChars: 2000,
  timeoutMs: 20_000,
  /** Whole fetch loop budget; the route allows 60 s, the rest is token refresh and the database write. */
  totalMs: 45_000,
} as const;

// Same names/units as the CSV import (GSC_METRICS in blog-metrics.ts), so API and CSV rows read alike.
const NAMES = {
  clicks: { metric: "클릭수", unit: "회" },
  impressions: { metric: "노출수", unit: "회" },
  ctr: { metric: "CTR", unit: "%" },
  position: { metric: "평균 게재순위", unit: "위" },
} as const;

export type GscPair = { date: string; page: string; clicks: number; impressions: number; ctr: number; position: number };
export type SyncRow = { metric: string; scope: "page"; dimension: string; value: number; unit: string; measured_on: string };

export class GscSyncError extends Error {
  constructor(public kind: "auth" | "quota" | "failed" | "cap" | "bad_response", message: string) {
    super(message);
  }
}

const DAY = 86_400_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
}

/**
 * Range to request. End = yesterday (UTC; Search Console dates are Pacific, a few hours off, which the 3-day
 * refetch absorbs). First run: 90 days. Later: last successful end minus the refetch window, never before the
 * 90-day floor and never after the end.
 */
export function syncRange(lastSuccessEnd: string | null, now: Date = new Date()): { start: string; end: string } {
  const end = addDays(utcDay(now), -1);
  const floor = addDays(end, -(GSC_SYNC.firstDays - 1));
  if (!lastSuccessEnd) return { start: floor, end };
  let start = addDays(lastSuccessEnd, -GSC_SYNC.refetchDays);
  if (start < floor) start = floor;
  if (start > end) start = end;
  return { start, end };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new GscSyncError("bad_response", "Search Console 응답을 확인하지 못했습니다.");
  return v;
}

/** Folds a second (date, page) record into the first: counts add, ctr is recomputed, position is impression-weighted. */
function merge(a: GscPair, b: GscPair): GscPair {
  const impressions = a.impressions + b.impressions;
  const clicks = a.clicks + b.clicks;
  return {
    date: a.date,
    page: a.page,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? (a.position * a.impressions + b.position * b.impressions) / impressions : a.position,
  };
}

/** Quota reasons Google sends with 403 (instead of 429). */
function isQuota(status: number, text: string) {
  return status === 429 || (status === 403 && /rateLimitExceeded|quotaExceeded|userRateLimitExceeded/.test(text));
}

/**
 * Pages through searchAnalytics.query (rowLimit/startRow). Duplicate (date, page) records are merged as they
 * arrive, and the fetch stops with `cap` as soon as the metric rows to write would pass the workspace cap, so a
 * run that cannot fit is refused before anything is written. dataState "all": the range ends yesterday, and
 * "final" would leave out the newest ~2 days; the refetch window replaces those fresh values on the next run.
 */
export async function fetchGscPairs(
  apiBase: string,
  accessToken: string,
  siteUrl: string,
  range: { start: string; end: string },
  fetchImpl: typeof fetch = fetch,
  cap: number = GSC_SYNC.metricRowCap,
  clock: () => number = Date.now,
): Promise<GscPair[]> {
  const t0 = clock();
  const url = `${apiBase}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const pairs = new Map<string, GscPair>();
  for (let startRow = 0; ; startRow += GSC_SYNC.rowLimit) {
    if (clock() - t0 > GSC_SYNC.totalMs) throw new GscSyncError("failed", "PROVIDER_TIMEOUT: Search Console 응답이 너무 오래 걸립니다.");
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: ["date", "page"], rowLimit: GSC_SYNC.rowLimit, startRow, dataState: "all", type: "web" }),
        signal: AbortSignal.timeout(GSC_SYNC.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new GscSyncError("failed", "Search Console에 연결하지 못했습니다.");
    }
    const text = (await res.text()).slice(0, 5_000_000);
    if (res.status === 401) throw new GscSyncError("auth", "Search Console 권한이 만료되었습니다.");
    if (isQuota(res.status, text.slice(0, 2_000))) throw new GscSyncError("quota", "Search Console 요청 한도에 도달했습니다.");
    if (res.status !== 200) throw new GscSyncError("failed", "Search Console이 요청을 처리하지 못했습니다.");
    let body: { rows?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new GscSyncError("bad_response", "Search Console 응답을 확인하지 못했습니다.");
    }
    const rows = body.rows === undefined ? [] : body.rows;
    if (!Array.isArray(rows)) throw new GscSyncError("bad_response", "Search Console 응답을 확인하지 못했습니다.");
    for (const raw of rows) {
      const r = raw as { keys?: unknown; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown } | null;
      const keys = r?.keys;
      if (!r || !Array.isArray(keys) || typeof keys[0] !== "string" || typeof keys[1] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(keys[0]))
        throw new GscSyncError("bad_response", "Search Console 응답을 확인하지 못했습니다.");
      const pair: GscPair = { date: keys[0], page: keys[1].trim(), clicks: num(r.clicks), impressions: num(r.impressions), ctr: num(r.ctr), position: num(r.position) };
      const key = `${pair.date}|${pair.page}`;
      const prev = pairs.get(key);
      pairs.set(key, prev ? merge(prev, pair) : pair);
      if (pairs.size * GSC_SYNC.metricsPerPair > cap) throw new GscSyncError("cap", "가져올 데이터가 워크스페이스 행 상한을 넘습니다. 기간이나 페이지 수를 줄여주세요.");
    }
    if (rows.length < GSC_SYNC.rowLimit) break;
  }
  return [...pairs.values()];
}

/** blog_metric_snapshots rows for replace_synced_range. Pages that cannot be stored are skipped and counted (-> partial). */
export function toSyncRows(pairs: GscPair[]): { rows: SyncRow[]; skipped: number } {
  const rows: SyncRow[] = [];
  let skipped = 0;
  for (const p of pairs) {
    if (!p.page || p.page.length > GSC_SYNC.maxPageChars) {
      skipped++;
      continue;
    }
    const base = { scope: "page" as const, dimension: p.page, measured_on: p.date };
    rows.push({ ...base, ...NAMES.clicks, value: round4(p.clicks) });
    rows.push({ ...base, ...NAMES.impressions, value: round4(p.impressions) });
    rows.push({ ...base, ...NAMES.ctr, value: round4(p.ctr * 100) });
    rows.push({ ...base, ...NAMES.position, value: round4(p.position) });
  }
  return { rows, skipped };
}
