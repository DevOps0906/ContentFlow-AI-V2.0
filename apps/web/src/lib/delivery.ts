// Delivery log and state history (P0-09), account mode only. Attempts are an operating reference:
// members can write them. Article content and credentials are never logged.
import { contentChanged, isApprovedContent, reviewErrors, type Article } from "./content";
import type { LifecycleState } from "./lifecycle";
import { RENDERER_VERSION } from "./render";

// Keep in sync with the delivery_attempts check in migration 0008 (a test compares them).
export const FAILURE_TYPES = [
  "auth",
  "not_found",
  "rate_limited",
  "server",
  "rejected",
  "timeout",
  "network",
  "remote_state",
  "invalid_response",
  "not_sendable",
  "config",
  "unknown",
] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

export const failureLabels: Record<FailureType, string> = {
  auth: "인증·권한",
  not_found: "주소·글 없음",
  rate_limited: "요청 제한",
  server: "CMS 서버 오류",
  rejected: "요청 거절",
  timeout: "시간 초과",
  network: "연결 실패",
  remote_state: "원격 글 상태",
  invalid_response: "응답 형식",
  not_sendable: "전송 조건 미충족",
  config: "연결 설정",
  unknown: "알 수 없음",
};

export class DeliveryError extends Error {
  failureType: FailureType;
  constructor(failureType: FailureType, message: string) {
    super(message);
    this.name = "DeliveryError";
    this.failureType = failureType;
  }
}

const REAPPROVE = "다시 승인한 뒤 전달해주세요.";
// Keep in sync with the reasons returned by article_delivery_check in migration 0010 (a test compares them).
export const deliveryBlockMessages = {
  not_found: "콘텐츠를 찾을 수 없습니다.",
  not_approved: "승인된 콘텐츠만 내보낼 수 있습니다.",
  no_approval: `승인 기록이 없습니다. ${REAPPROVE}`,
  hash_version: `이전 방식으로 승인된 글입니다. ${REAPPROVE}`,
  hash_mismatch: `승인한 뒤 내용이 달라졌습니다. ${REAPPROVE}`,
  renderer_mismatch: `승인 후 표시 방식(렌더러)이 바뀌었습니다. ${REAPPROVE}`,
} as const;
export type DeliveryBlockReason = keyof typeof deliveryBlockMessages;
// The database reports a missing version as renderer_mismatch: nothing changed, it was never recorded.
export const rendererUnrecordedMessage = `재승인 필요: 승인 당시 표시 방식(렌더러) 기록이 없습니다. ${REAPPROVE}`;
export const staleCopyMessage = "다른 곳에서 이 글이 변경되어 내려받지 않았습니다. 새로고침해 최신 내용을 확인한 뒤 다시 시도해주세요.";

export type DeliveryVerdict = { ok: true } | { ok: false; reason: DeliveryBlockReason | "unknown" };
/** Account mode: the database's verdict on an article. Local mode has none. */
export type DeliveryCheck = (articleId: string) => Promise<DeliveryVerdict>;

/** Anything but an explicit approval blocks the delivery. */
export function parseVerdict(data: unknown): DeliveryVerdict {
  const v = (data ?? {}) as { ok?: unknown; reason?: unknown };
  if (v.ok === true) return { ok: true };
  return { ok: false, reason: typeof v.reason === "string" && v.reason in deliveryBlockMessages ? (v.reason as DeliveryBlockReason) : "unknown" };
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
/** Server side: the renderer version compared is always this deployment's, never a client's. */
export function rpcDeliveryCheck(client: RpcClient): DeliveryCheck {
  return async (articleId) => {
    const { data, error } = await client.rpc("article_delivery_check", {
      p_article_id: articleId,
      p_renderer_version: RENDERER_VERSION,
    });
    if (error) throw new DeliveryError("unknown", "전달 가능 여부를 확인하지 못했습니다.");
    return parseVerdict(data);
  };
}

/**
 * The one gate before anything is handed off. With `check` (account mode) the database decides:
 * approval, hash and renderer version. Local mode has no approval snapshots and compares the
 * renderer version only.
 */
export async function assertDeliverable(article: Article, check?: DeliveryCheck): Promise<void> {
  if (!isApprovedContent(article))
    throw new DeliveryError("not_sendable", "승인된 콘텐츠만 내보낼 수 있습니다.");
  const issues = reviewErrors(article);
  if (issues.length) throw new DeliveryError("not_sendable", issues[0]);
  const verdict: DeliveryVerdict = check
    ? await check(article.id)
    : article.rendererVersion === RENDERER_VERSION
      ? { ok: true }
      : { ok: false, reason: "renderer_mismatch" };
  if (!verdict.ok)
    throw new DeliveryError(
      "not_sendable",
      verdict.reason === "unknown"
        ? `전달 조건을 확인할 수 없습니다. ${REAPPROVE}`
        : verdict.reason === "renderer_mismatch" && article.rendererVersion === undefined
          ? rendererUnrecordedMessage
          : deliveryBlockMessages[verdict.reason],
    );
}

/** Account mode, before a download: the browser's copy must still be what the server holds. */
export function assertSameAsStored(article: Article, stored: Article) {
  if (contentChanged(article, stored) || article.status !== stored.status)
    throw new DeliveryError("not_sendable", staleCopyMessage);
}

type InsertClient = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
  };
};
export type DeliveryLog = { client: InsertClient; workspaceId: string; userId: string };

/** A failure to store the log never changes the delivery result: it only leaves a server warning. */
async function saveAttempt(
  log: DeliveryLog,
  articleId: string,
  outcome: { failure_type: FailureType | null; url: string | null; duration_ms: number },
) {
  try {
    // The database assigns the attempt number.
    const { error } = await log.client.from("delivery_attempts").insert({
      workspace_id: log.workspaceId,
      article_id: articleId,
      created_by: log.userId,
      channel: "wordpress",
      ...outcome,
    });
    if (error) console.warn("delivery_attempts insert failed", error.code ?? "", error.message ?? "");
  } catch (e) {
    console.warn("delivery_attempts insert failed", e instanceof Error ? e.message : "");
  }
}

/** Runs one send and records its outcome exactly once. The send's result or error passes through. */
export async function trackDelivery<T extends { url: string }>(
  log: DeliveryLog,
  articleId: string,
  send: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let result: T;
  try {
    result = await send();
  } catch (e) {
    const failure_type = e instanceof DeliveryError ? e.failureType : "unknown";
    await saveAttempt(log, articleId, { failure_type, url: null, duration_ms: Date.now() - started });
    throw e;
  }
  await saveAttempt(log, articleId, { failure_type: null, url: result.url, duration_ms: Date.now() - started });
  return result;
}

export type StateEvent = { fromState: LifecycleState; toState: LifecycleState; createdAt: string };
export type DeliveryAttempt = {
  channel: "wordpress" | "manual";
  attempt: number;
  failureType: FailureType | null;
  url: string | null;
  durationMs: number | null;
  createdAt: string;
};
export type ArticleHistory = { events: StateEvent[]; attempts: DeliveryAttempt[]; workTimeMs: number | null };

const PLANNING: LifecycleState[] = ["idea", "researching", "briefing", "drafting"];

/**
 * Time from the first transition to the latest approval, for events in ascending order. Null (N/A)
 * when nothing was approved, or when the recorded history starts after planning: an article that
 * was already under review when logging began would otherwise show a misleadingly short time.
 */
export function workTimeMs(events: StateEvent[]): number | null {
  const approvedAt = events.findLastIndex((e) => e.toState === "approved");
  if (approvedAt < 1 || !PLANNING.includes(events[0].fromState)) return null;
  return Date.parse(events[approvedAt].createdAt) - Date.parse(events[0].createdAt);
}

/** "N/A" for unknown values; otherwise the largest two units. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "N/A";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}
