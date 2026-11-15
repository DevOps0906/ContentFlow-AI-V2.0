// Google Analytics 4 collector (CF-07b A7, ANALYTICS_SYNC.md sections 2 and 4). Server-only, no database access:
// runReport paging, date parsing, de-duplication and the cap pre-check live here so they can be tested without
// Google. Dimensions are date x pagePath. Rows go to blog_metric_snapshots as tool "ga4-api" and are never mixed
// with GSC, CSV or AdSense numbers: GA4 page views are not the RPM denominator (that is the AdSense report's).
// Tokens and bodies are never logged.
import type { SyncRow } from "./gsc-sync";
import { GA4_PROPERTY_RE } from "./google-oauth";

export const GA4_SYNC = {
  /** runReport maximum page size. */
  rowLimit: 100_000,
  /** Workspace cap of blog_metric_snapshots (0017 trigger); replace_synced_range checks the same number. */
  metricRowCap: 30_000,
  /** Metric rows written per (date, page): page views, sessions, active users. */
  metricsPerPair: 3,
  /** metric.dimension length limit of blog_metric_snapshots. */
  maxPageChars: 2000,
  timeoutMs: 20_000,
  /** Whole fetch loop budget; the route allows 60 s, the rest is token refresh and the database write. */
  totalMs: 45_000,
} as const;

/** GA4 API metric names, in the order requested. */
const API_METRICS = ["screenPageViews", "sessions", "activeUsers"] as const;
const NAMES = {
  views: { metric: "조회수", unit: "회" },
  sessions: { metric: "세션", unit: "회" },
  users: { metric: "활성 사용자", unit: "명" },
} as const;

export type Ga4Pair = { date: string; page: string; views: number; sessions: number; users: number };

export class Ga4SyncError extends Error {
  constructor(public kind: "auth" | "quota" | "forbidden" | "failed" | "cap" | "bad_response", message: string) {
    super(message);
  }
}
const BAD = () => new Ga4SyncError("bad_response", "Google Analytics 응답을 확인하지 못했습니다.");

/** "20261113" -> "2026-11-13"; null for anything that is not a real calendar day. */
export function parseGa4Date(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{8}$/.test(v)) return null;
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : iso;
}

function count(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw BAD();
  return n;
}

/**
 * Folds a second (date, page) record into the first. Views and sessions add. Active users are not additive
 * (the same person can appear in both records), so the larger value is kept: a lower bound, never an inflated sum.
 */
function merge(a: Ga4Pair, b: Ga4Pair): Ga4Pair {
  return { date: a.date, page: a.page, views: a.views + b.views, sessions: a.sessions + b.sessions, users: Math.max(a.users, b.users) };
}

/** Quota reasons: GA4 sends 429 RESOURCE_EXHAUSTED, some gateways 403 with a rate-limit reason. */
function isQuota(status: number, text: string) {
  return status === 429 || (status === 403 && /rateLimitExceeded|quotaExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(text));
}
/** 403 because the token lacks the analytics scope: a new consent fixes it. Other 403s mean no access to the property. */
function isScopeProblem(text: string) {
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i.test(text);
}

/**
 * Pages through runReport (limit/offset, rowCount). Duplicate (date, page) records merge as they arrive. The
 * first answer's rowCount is an upper bound of the pairs: when it already passes the workspace cap the fetch
 * stops with `cap` before the rest is requested, and so does any run whose merged pairs pass it.
 */
export async function fetchGa4Pairs(
  dataBase: string,
  accessToken: string,
  property: string,
  range: { start: string; end: string },
  fetchImpl: typeof fetch = fetch,
  cap: number = GA4_SYNC.metricRowCap,
  clock: () => number = Date.now,
): Promise<Ga4Pair[]> {
  if (!GA4_PROPERTY_RE.test(property)) throw new Ga4SyncError("failed", "저장된 GA4 속성 값이 올바르지 않습니다.");
  const t0 = clock();
  const url = `${dataBase}/v1beta/${property}:runReport`;
  const tooMany = () => new Ga4SyncError("cap", "가져올 데이터가 워크스페이스 행 상한을 넘습니다. 기간이나 페이지 수를 줄여주세요.");
  const pairs = new Map<string, Ga4Pair>();
  let offset = 0;
  for (;;) {
    if (clock() - t0 > GA4_SYNC.totalMs) throw new Ga4SyncError("failed", "PROVIDER_TIMEOUT: Google Analytics 응답이 너무 오래 걸립니다.");
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: range.start, endDate: range.end }],
          dimensions: [{ name: "date" }, { name: "pagePath" }],
          metrics: API_METRICS.map((name) => ({ name })),
          limit: GA4_SYNC.rowLimit,
          offset,
        }),
        signal: AbortSignal.timeout(GA4_SYNC.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Ga4SyncError("failed", "Google Analytics에 연결하지 못했습니다.");
    }
    const text = (await res.text()).slice(0, 20_000_000);
    const head = text.slice(0, 2_000);
    if (res.status === 401) throw new Ga4SyncError("auth", "Google Analytics 권한이 만료되었습니다.");
    if (res.status === 403 && isScopeProblem(head)) throw new Ga4SyncError("auth", "Google Analytics 읽기 권한이 없습니다. 다시 연결해주세요.");
    if (isQuota(res.status, head)) throw new Ga4SyncError("quota", "Google Analytics 요청 한도에 도달했습니다.");
    if (res.status === 403) throw new Ga4SyncError("forbidden", "이 Google 계정에 해당 속성을 읽을 권한이 없습니다.");
    if (res.status !== 200) throw new Ga4SyncError("failed", "Google Analytics가 요청을 처리하지 못했습니다.");
    let body: { rows?: unknown; rowCount?: unknown; metricHeaders?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw BAD();
    }
    const rows = body.rows === undefined ? [] : body.rows;
    if (!Array.isArray(rows)) throw BAD();
    const rowCount = typeof body.rowCount === "number" && Number.isInteger(body.rowCount) && body.rowCount >= 0 ? body.rowCount : null;
    if (body.rowCount !== undefined && rowCount === null) throw BAD();
    if (rowCount !== null && rowCount * GA4_SYNC.metricsPerPair > cap) throw tooMany();
    // Column order follows the request; when Google names the columns they must match.
    if (body.metricHeaders !== undefined) {
      const names = Array.isArray(body.metricHeaders) ? body.metricHeaders.map((h) => (h as { name?: unknown } | null)?.name) : null;
      if (!names || names.length !== API_METRICS.length || names.some((n, i) => n !== API_METRICS[i])) throw BAD();
    }
    for (const raw of rows) {
      const r = raw as { dimensionValues?: unknown; metricValues?: unknown } | null;
      const dims = r?.dimensionValues;
      const mets = r?.metricValues;
      if (!Array.isArray(dims) || dims.length !== 2 || !Array.isArray(mets) || mets.length !== API_METRICS.length) throw BAD();
      const date = parseGa4Date((dims[0] as { value?: unknown } | null)?.value);
      const pagePath = (dims[1] as { value?: unknown } | null)?.value;
      if (!date || typeof pagePath !== "string") throw BAD();
      if (date < range.start || date > range.end) throw BAD();
      const page = pagePath.trim();
      // GA4's bucket for hits without a page is not a page.
      if (page === "(not set)") continue;
      const v = mets.map((m) => count((m as { value?: unknown } | null)?.value));
      const pair: Ga4Pair = { date, page, views: v[0], sessions: v[1], users: v[2] };
      const key = `${date}|${page}`;
      const prev = pairs.get(key);
      pairs.set(key, prev ? merge(prev, pair) : pair);
      if (pairs.size * GA4_SYNC.metricsPerPair > cap) throw tooMany();
    }
    offset += rows.length;
    // Done when Google says everything came back, or an empty / short page arrives (no rowCount to trust).
    if (rows.length === 0 || (rowCount !== null ? offset >= rowCount : rows.length < GA4_SYNC.rowLimit)) break;
  }
  return [...pairs.values()];
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** blog_metric_snapshots rows for replace_synced_range (scope page, dimension = pagePath). Pages that cannot be stored are skipped and counted (-> partial). */
export function toGa4SyncRows(pairs: Ga4Pair[]): { rows: SyncRow[]; skipped: number } {
  const rows: SyncRow[] = [];
  let skipped = 0;
  for (const p of pairs) {
    if (!p.page || p.page.length > GA4_SYNC.maxPageChars) {
      skipped++;
      continue;
    }
    const base = { scope: "page" as const, dimension: p.page, measured_on: p.date };
    rows.push({ ...base, ...NAMES.views, value: round4(p.views) });
    rows.push({ ...base, ...NAMES.sessions, value: round4(p.sessions) });
    rows.push({ ...base, ...NAMES.users, value: round4(p.users) });
  }
  return { rows, skipped };
}
