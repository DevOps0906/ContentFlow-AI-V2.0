// "Sync now" for a Search Console / AdSense / GA4 connection (CF-07b A4). Runs under the session's own Supabase client and the
// 0024/0026 RPCs (no service role). Order: begin_sync_run (cooldown / one running / admin checks are the
// database's) -> refresh the access token -> fetch every page -> replace_synced_range in one transaction.
// Any failure closes the run with finish_sync_run and writes no rows (a failure is never stored as 0).
import type { Authed } from "./api";
import { AnalyticsError, readRefreshToken } from "./analytics-connections-server";
import { ADSENSE_ACCOUNT_RE, GA4_PROPERTY_RE } from "./google-oauth";
import { fetchGa4Pairs, Ga4SyncError, toGa4SyncRows } from "./ga4-sync";
import { AdsenseSyncError, fetchAccountTimeZone, fetchAdsenseReport } from "./adsense-sync";
import { fetchGscPairs, GscSyncError, syncRange, toSyncRows } from "./gsc-sync";
import { GoogleError, refreshAccessToken, type GoogleConfig } from "./google-oauth";

export class SyncError extends Error {
  constructor(message: string, public status: number, public code: string, public runStatus?: "failed" | "delayed") {
    super(message);
  }
}

export type SyncOutcome = { status: "succeeded" | "partial"; rows: number; range: { start: string; end: string }; runId: string; pageLevel?: boolean };
export type LastRun = { status: string; finishedAt: string | null; rows: number; errorCode: string | null };
type Deps = { fetchImpl?: typeof fetch; now?: Date };
type RpcError = { message?: string } | null;

// RPC exception text -> HTTP answer (the contract of POST /api/analytics/connections/[id]/sync).
const RPC_MAP: [string, number, string, string][] = [
  ["SYNC_COOLDOWN", 409, "SYNC_COOLDOWN", "방금 동기화했습니다. 15분 뒤에 다시 시도해주세요."],
  ["SYNC_RUNNING", 409, "SYNC_IN_PROGRESS", "이미 동기화가 진행 중입니다."],
  ["CONNECTION_NOT_ACTIVE", 409, "CONNECTION_NOT_ACTIVE", "다시 연결이 필요한 상태입니다."],
  ["GRANT_OWNER_INACTIVE", 409, "GRANT_OWNER_INACTIVE", "이 Google 연결을 만든 사람이 더 이상 관리자가 아닙니다. 다시 연결해주세요."],
  ["ANALYTICS_FORBIDDEN", 403, "forbidden", "동기화는 소유자·관리자만 할 수 있습니다."],
  ["SYNC_CAP_EXCEEDED", 422, "SYNC_CAP_EXCEEDED", "가져올 데이터가 워크스페이스 행 상한을 넘습니다. 기간이나 페이지 수를 줄여주세요."],
];
function mapRpc(error: RpcError): SyncError {
  const msg = error?.message ?? "";
  const hit = RPC_MAP.find(([k]) => msg.includes(k));
  return hit ? new SyncError(hit[3], hit[1], hit[2]) : new SyncError("동기화를 처리하지 못했습니다.", 500, "sync_failed");
}

export async function runSync(account: Authed, cfg: GoogleConfig, connectionId: string, deps: Deps = {}): Promise<SyncOutcome> {
  const db = account.supabase;
  const { data: con, error } = await db
    .from("analytics_connections")
    .select("id, provider, external_ref, status, grant_id")
    .eq("id", connectionId)
    .eq("organization_id", account.workspaceId)
    .maybeSingle();
  if (error) throw new SyncError("연결을 불러오지 못했습니다.", 500, "read_failed");
  if (!con) throw new SyncError("연결을 찾을 수 없습니다.", 404, "not_found");
  if (con.provider !== "gsc" && con.provider !== "adsense" && con.provider !== "ga4") throw new SyncError("이 연결은 아직 동기화를 지원하지 않습니다.", 400, "provider_unsupported");
  if (con.provider === "adsense" && !ADSENSE_ACCOUNT_RE.test(con.external_ref)) throw new SyncError("저장된 AdSense 계정 값이 올바르지 않습니다. 연결을 해제하고 다시 연결해주세요.", 409, "CONNECTION_INVALID");
  if (con.provider === "ga4" && !GA4_PROPERTY_RE.test(con.external_ref)) throw new SyncError("저장된 GA4 속성 값이 올바르지 않습니다. 연결을 해제하고 다시 연결해주세요.", 409, "CONNECTION_INVALID");
  if (!["pending", "active", "error"].includes(con.status) || !con.grant_id) throw mapRpc({ message: "CONNECTION_NOT_ACTIVE" });

  const { data: last } = await db
    .from("analytics_sync_runs")
    .select("range_end")
    .eq("connection_id", connectionId)
    .eq("status", "succeeded")
    .order("range_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  const range = syncRange((last as { range_end?: string } | null)?.range_end ?? null, deps.now);

  const begun = await db.rpc("begin_sync_run", { p_connection: connectionId, p_range_start: range.start, p_range_end: range.end });
  if (begun.error) throw mapRpc(begun.error);
  const runId = begun.data as string;

  // From here the run is open: every exit either finishes it through replace_synced_range or through finish_sync_run.
  try {
    let access: string;
    try {
      const refresh = await readRefreshToken(db, cfg.ring, con.grant_id);
      access = await refreshAccessToken(cfg, refresh, deps.fetchImpl);
    } catch (e) {
      if (e instanceof GoogleError && e.code === "invalid_grant") throw new GscSyncError("auth", e.message);
      if (e instanceof GoogleError) throw new GscSyncError("failed", e.message);
      throw e;
    }
    let rows: unknown[];
    let skipped: number;
    let pageLevel: boolean | undefined;
    if (con.provider === "adsense") {
      // Time zone first (accounts.get), then one report whose header carries the currency.
      const timezone = await fetchAccountTimeZone(cfg.adsenseBase, access, con.external_ref, deps.fetchImpl);
      const report = await fetchAdsenseReport(cfg.adsenseBase, access, con.external_ref, timezone, range, deps.fetchImpl);
      rows = report.rows;
      skipped = report.skipped;
      pageLevel = report.pageLevel;
    } else if (con.provider === "ga4") {
      const pairs = await fetchGa4Pairs(cfg.ga4DataBase, access, con.external_ref, range, deps.fetchImpl);
      ({ rows, skipped } = toGa4SyncRows(pairs));
    } else {
      const pairs = await fetchGscPairs(cfg.apiBase, access, con.external_ref, range, deps.fetchImpl);
      ({ rows, skipped } = toSyncRows(pairs));
    }
    const coverage = skipped > 0 ? "partial" : "complete";
    const done = await db.rpc("replace_synced_range", {
      p_connection: connectionId,
      p_run: runId,
      p_range_start: range.start,
      p_range_end: range.end,
      p_rows: rows,
      p_coverage: coverage,
    });
    if (done.error) throw mapRpc(done.error);
    return { status: coverage === "partial" ? "partial" : "succeeded", rows: done.data as number, range, runId, ...(pageLevel === undefined ? {} : { pageLevel }) };
  } catch (e) {
    let out: SyncError;
    let status: "failed" | "delayed" = "failed";
    let conn: "needs_reauth" | null = null;
    const prov = e instanceof AdsenseSyncError ? "AdSense" : e instanceof Ga4SyncError ? "Google Analytics" : "Search Console";
    const kind = e instanceof GscSyncError || e instanceof AdsenseSyncError || e instanceof Ga4SyncError ? e.kind : null;
    if (kind === "auth") {
      out = new SyncError("Google 권한이 만료되었거나 철회되었습니다. 다시 연결해주세요.", 409, "NEEDS_REAUTH");
      conn = "needs_reauth";
    } else if (kind === "quota") {
      out = new SyncError(`${prov} 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.`, 502, "PROVIDER_QUOTA", "delayed");
      status = "delayed";
    } else if (kind === "cap") {
      out = mapRpc({ message: "SYNC_CAP_EXCEEDED" });
    } else if (kind === "forbidden") {
      out = new SyncError("이 Google 계정에 해당 GA4 속성을 읽을 권한이 없거나 Analytics Data API를 쓸 수 없습니다.", 502, "PROVIDER_FORBIDDEN", "failed");
    } else if (kind === "currency") {
      out = new SyncError("AdSense 보고서에서 통화를 확인하지 못해 가져오지 않았습니다.", 502, "CURRENCY_MISSING", "failed");
    } else if (kind === "timezone") {
      out = new SyncError("AdSense 계정의 시간대를 확인하지 못해 가져오지 않았습니다.", 502, "TIMEZONE_MISSING", "failed");
    } else if (kind) {
      out = new SyncError(`${prov}에서 데이터를 가져오지 못했습니다.`, 502, "PROVIDER_ERROR", "failed");
    } else if (e instanceof SyncError) {
      out = e;
    } else if (e instanceof AnalyticsError) {
      // token read problems (grant owner gone, token unreadable)
      out = new SyncError(e.message, e.status, e.code === "grant_owner_inactive" ? "GRANT_OWNER_INACTIVE" : e.code);
    } else {
      out = new SyncError("동기화를 처리하지 못했습니다.", 500, "sync_failed");
    }
    // rpc() returns { error } instead of throwing: retry once, then log the code only (the database closes a
    // run left open as STALE after 10 minutes).
    const finish = () => db.rpc("finish_sync_run", { p_run: runId, p_status: status, p_error_code: out.code.slice(0, 60), p_connection_status: conn });
    let closed = (await finish().then((r) => r, () => ({ error: { message: "threw" } }))).error;
    if (closed) closed = (await finish().then((r) => r, () => ({ error: { message: "threw" } }))).error;
    if (closed) console.error(`finish_sync_run failed for ${out.code}`);
    throw out;
  }
}

/** Newest run of each connection of the workspace (members read). Absent when a connection has never run. */
export async function lastRuns(account: Authed): Promise<Map<string, LastRun>> {
  const { data } = await account.supabase
    .from("analytics_sync_runs")
    .select("connection_id, status, finished_at, rows_written, error_code")
    .eq("organization_id", account.workspaceId)
    .order("requested_at", { ascending: false })
    .limit(200);
  const map = new Map<string, LastRun>();
  for (const r of (data ?? []) as { connection_id: string; status: string; finished_at: string | null; rows_written: number; error_code: string | null }[])
    if (!map.has(r.connection_id)) map.set(r.connection_id, { status: r.status, finishedAt: r.finished_at, rows: r.rows_written, errorCode: r.error_code });
  return map;
}

/** Kept for callers of the Search Console era. */
export const runGscSync = runSync;
