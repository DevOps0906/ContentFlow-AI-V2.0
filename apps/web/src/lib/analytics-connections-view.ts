/** Pure view rules of the connection panel (ANALYTICS_SYNC §6, D4·D7). The server stays the authority. */
export type LastRun = { status: string; finishedAt: string | null; rows: number | null; errorCode: string | null };
export type ConnectionView = {
  id: string;
  blog_id: string | null;
  grant_id: string | null;
  provider: string;
  external_ref: string;
  status: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  created_at: string;
  lastRun?: LastRun | null;
  /** AdSense only: what the stored rows say (null fields = nothing synced yet). */
  adsense?: { currency: string | null; timezone: string | null; pageLevel: boolean | null };
};

export const AUTO_SYNC_AFTER_MS = 24 * 60 * 60 * 1000;

export const connectionStatusLabels: Record<string, string> = {
  pending: "동의 대기",
  active: "활성",
  needs_reauth: "재연결 필요",
  revoked: "연결 해제됨",
  error: "오류",
};
/** Reuses the lifecycle badge colors: warn = needs the operator, approve = healthy, write = neutral. */
export function connectionStatusClass(status: string): string {
  if (status === "active") return "approve";
  if (status === "needs_reauth" || status === "error") return "warn";
  if (status === "pending") return "after";
  return "write";
}

export const syncErrorMessages: Record<string, string> = {
  SYNC_COOLDOWN: "방금 동기화했습니다. 잠시 후 다시 시도해주세요.",
  SYNC_IN_PROGRESS: "이미 동기화 중입니다.",
  CONNECTION_NOT_ACTIVE: "연결이 활성 상태가 아닙니다. 해제되었거나 재연결이 필요하면 다시 연결해주세요.",
  GRANT_OWNER_INACTIVE: "연결한 사용자가 더 이상 관리자가 아니어서 동기화할 수 없습니다. 다시 연결해주세요.",
  NEEDS_REAUTH: "Google 재연결이 필요합니다.",
  CONNECTION_INVALID: "저장된 연결 정보가 올바르지 않습니다. 연결을 해제하고 다시 연결해주세요.",
  SYNC_CAP_EXCEEDED: "가져올 데이터가 워크스페이스 행 상한(30,000행)을 넘을 것으로 예상되어 실행하지 않았습니다. 기간이나 페이지 수를 줄여주세요.",
  PROVIDER_ERROR: "Google에서 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.",
  CURRENCY_MISSING: "AdSense 보고서에서 통화를 확인하지 못해 가져오지 않았습니다. 수익은 N/A로 유지됩니다.",
  TIMEZONE_MISSING: "AdSense 계정의 시간대를 확인하지 못해 가져오지 않았습니다. 수익은 N/A로 유지됩니다.",
  PROVIDER_FORBIDDEN: "이 Google 계정에 해당 GA4 속성을 읽을 권한이 없거나 Analytics Data API를 쓸 수 없습니다. 속성 접근 권한을 확인해주세요.",
  PROVIDER_QUOTA: "Google 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.",
};
export function syncErrorMessage(code: unknown, status: number): string {
  if (typeof code === "string" && syncErrorMessages[code]) return syncErrorMessages[code];
  return status === 403 ? "동기화는 소유자·관리자만 할 수 있습니다." : `동기화하지 못했습니다(${status}).`;
}

const reasonMessages: Record<string, string> = {
  denied: "Google 동의를 취소했습니다.",
  forbidden: "연결은 소유자·관리자만 할 수 있습니다.",
  workspace_changed: "워크스페이스가 바뀌어 연결을 중단했습니다. 다시 시도해주세요.",
  scope_missing: "필요한 읽기 권한이 허용되지 않았습니다. 동의 화면에서 권한을 모두 허용해주세요.",
  invalid_grant: "Google 권한이 만료되었습니다. 다시 연결해주세요.",
};
export function googleErrorMessage(reason: string | null): string {
  return (reason && reasonMessages[reason]) || "Google 연결을 완료하지 못했습니다. 다시 시도해주세요.";
}

/** Auto sync only for an active connection whose last success is older than 24h (or never happened). */
export function isAutoSyncDue(c: Pick<ConnectionView, "status" | "last_success_at"> & { lastRun?: unknown }, now: number): boolean {
  // A pending connection has never synced: its first successful sync turns it active (the database does that).
  if (c.status === "pending") return !c.lastRun && !c.last_success_at;
  if (c.status !== "active") return false;
  if (!c.last_success_at) return true;
  const t = Date.parse(c.last_success_at);
  return Number.isNaN(t) || now - t >= AUTO_SYNC_AFTER_MS;
}

/** Rows are shown only for a run that returned data: a failed or delayed run is N/A, never 0. */
export function runSummary(run: LastRun | null | undefined): { label: string; rows: string; partial: boolean; failed: boolean } {
  if (!run) return { label: "동기화 기록 없음", rows: "N/A", partial: false, failed: false };
  if (run.status === "succeeded") return { label: "성공", rows: run.rows == null ? "N/A" : `${run.rows.toLocaleString("ko-KR")}행`, partial: false, failed: false };
  if (run.status === "partial") return { label: "부분 데이터", rows: run.rows == null ? "N/A" : `${run.rows.toLocaleString("ko-KR")}행`, partial: true, failed: false };
  if (run.status === "delayed") return { label: "지연", rows: "N/A", partial: false, failed: false };
  return { label: "가져오지 못함", rows: "N/A", partial: false, failed: true };
}

/** The list response is untrusted shape-wise: keep only rows with the fields the panel needs. */
export function parseConnections(raw: unknown): ConnectionView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is ConnectionView => !!c && typeof c === "object" && typeof (c as ConnectionView).id === "string" && typeof (c as ConnectionView).status === "string");
}

/** Text lines of an AdSense connection: estimated only, account currency and time zone, page level or not (D6). */
export function adsenseLines(info: ConnectionView["adsense"]): string[] {
  const lines = ["수익은 AdSense 추정치입니다(확정 아님)."];
  if (info?.currency) lines.push(`통화 ${info.currency} · 보고 시간대 ${info.timezone ?? "N/A"}`);
  if (info?.pageLevel === false) lines.push("글별 미지원: 이 계정은 페이지별 보고서를 허용하지 않아 사이트·일 단위로만 가져옵니다. 글별 ROI는 N/A입니다.");
  return lines;
}

/** Text lines of a GA4 connection: separate rows, never added to GSC/AdSense, users are not additive (D3). */
export function ga4Lines(): string[] {
  return [
    "GA4 조회수·세션·활성 사용자는 페이지·일 단위 별도 기록입니다. Search Console·AdSense 값과 합치지 않고, RPM 계산에도 쓰지 않습니다.",
    "활성 사용자는 날짜·페이지 사이에 합산할 수 없어 합계를 만들지 않습니다.",
  ];
}
