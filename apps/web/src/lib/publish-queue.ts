// Publishing queue (CF-24, docs/06-workflows/PUBLISH_QUEUE.md#16). Pure rules and view helpers;
// the database calls live in publish-queue-server.ts. Account mode only.
import { DeliveryError, failureLabels, FAILURE_TYPES, type FailureType } from "./delivery";

/** Database names in one place (migration 0020). */
export const PUBLISH_RPC = {
  enqueue: "enqueue_publish_job",
  claim: "claim_publish_job",
  finish: "finish_publish_job",
  cancel: "cancel_publish_job",
} as const;
export const PUBLISH_TABLE = "publish_jobs";
export const PUBLISH_COLUMNS =
  "id,workspace_id,article_id,approved_version_id,remote_key,status,attempts,max_attempts,next_attempt_at,last_error,created_at,updated_at";

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
export const BACKOFF_JITTER = 0.2;
/** A Retry-After beyond this is not waited for: the job needs a person. */
export const RETRY_AFTER_MAX_MS = 60 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 6;
export const POLL_MS = 5000;

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "needs_attention", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type Outcome = "success" | "retry" | "fail" | "attention";

export type PublishJob = {
  id: string;
  workspaceId: string;
  articleId: string;
  approvedVersionId: string | null;
  remoteKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  failureType: FailureType | null;
  createdAt: string;
  updatedAt: string;
  /** Joined by the list route for display. */
  title?: string;
};

/** Same remote site, same key: lowercase host, no trailing slash. Throws on an unparsable address. */
export function remoteKey(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  return (url.origin + url.pathname.replace(/\/+$/, "")).toLowerCase();
}

/** Seconds ("120") or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now: number): number | null {
  const v = header?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * When the next try may start. `attempts` is the number of tries made so far (>= 1): 30 s, 60 s,
 * 120 s ... up to 15 min, with +-20% jitter, never later than the cap; a longer Retry-After wins.
 */
export function nextAttemptAt(
  attempts: number,
  retryAfterHeader: string | null | undefined,
  now: Date | number = Date.now(),
  rand: () => number = Math.random,
): Date {
  const t = typeof now === "number" ? now : now.getTime();
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  const jittered = Math.min(base * (1 + (rand() * 2 - 1) * BACKOFF_JITTER), BACKOFF_CAP_MS);
  const wait = Math.max(jittered, retryAfterMs(retryAfterHeader, t) ?? 0);
  return new Date(t + Math.round(wait));
}

export type Verdict = "retry" | "fail" | "attention";
/** A status code or a thrown error. 401/403 need a person; 429, 5xx, timeouts and network are retried; other 4xx fail. */
export function classify(input: number | unknown): Verdict {
  if (typeof input === "number") {
    if (input === 401 || input === 403) return "attention";
    if (input === 408 || input === 429 || input >= 500) return "retry";
    return "fail";
  }
  if (input instanceof DeliveryError) {
    if (input.transient) return "retry";
    if (input.failureType === "auth") return "attention";
    if (["rate_limited", "server", "timeout", "network"].includes(input.failureType)) return "retry";
  }
  return "fail";
}

export type Decision = { outcome: Exclude<Outcome, "success">; retryAt: Date | null; failureType: FailureType };
/** What happens to a job after a failed try. `attempts` already counts that try. */
export function decide(
  err: unknown,
  attempts: number,
  maxAttempts: number,
  now: Date | number = Date.now(),
  rand: () => number = Math.random,
): Decision {
  const failureType: FailureType = err instanceof DeliveryError ? err.failureType : "unknown";
  const verdict = classify(err);
  if (verdict !== "retry") return { outcome: verdict, retryAt: null, failureType };
  if (attempts >= maxAttempts) return { outcome: "fail", retryAt: null, failureType };
  const t = typeof now === "number" ? now : now.getTime();
  const header = err instanceof DeliveryError ? err.retryAfter : null;
  if ((retryAfterMs(header, t) ?? 0) > RETRY_AFTER_MAX_MS) return { outcome: "attention", retryAt: null, failureType };
  return { outcome: "retry", retryAt: nextAttemptAt(attempts, header, t, rand), failureType };
}

// --- view ---------------------------------------------------------------------------------

export type QueueView = "queued" | "retry_wait" | "running" | "succeeded" | "failed" | "needs_attention" | "cancelled";
/** Retry-wait is not a stored state: it is queued with a later next_attempt_at after a failed try. */
export function viewOf(job: Pick<PublishJob, "status" | "attempts" | "nextAttemptAt">, now: number = Date.now()): QueueView {
  if (job.status === "queued" && job.attempts > 0 && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now)
    return "retry_wait";
  return job.status;
}
export const viewLabels: Record<QueueView, string> = {
  queued: "대기",
  retry_wait: "재시도 예정",
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  needs_attention: "주의 필요",
  cancelled: "취소",
};
export const QUEUE_TABS = ["all", "queued", "running", "retry_wait", "failed", "needs_attention", "cancelled", "succeeded"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const tabLabel = (t: QueueTab) => (t === "all" ? "전체" : viewLabels[t]);
export const canCancel = (job: Pick<PublishJob, "status">) => job.status === "queued" || job.status === "needs_attention";
/** Cancellation is only for jobs that have not started. */
export const hasDue = (jobs: Pick<PublishJob, "status" | "nextAttemptAt">[], now: number = Date.now()) =>
  jobs.some((j) => j.status === "queued" && (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= now));

/** Short reason from a classified failure type. Remote text never reaches the user. */
export function reasonOf(job: Pick<PublishJob, "failureType" | "status">): string {
  if (job.failureType === "auth") return "WordPress 연결을 확인해주세요.";
  if (job.failureType === "remote_state") return "공개된 글은 덮어쓰지 않습니다.";
  if (job.status === "failed" && job.failureType && ["rate_limited", "server", "timeout", "network"].includes(job.failureType))
    return "자동 재시도가 끝났습니다. 원인 확인 후 다시 시도해주세요.";
  return job.failureType ? failureLabels[job.failureType] : "";
}

/** "N분 뒤" / "N초 뒤" for a retry time. */
export function waitText(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  return s < 60 ? `${s}초 뒤` : `${Math.ceil(s / 60)}분 뒤`;
}

// --- rows ---------------------------------------------------------------------------------

export type JobRow = {
  id: string;
  workspace_id: string;
  article_id: string;
  approved_version_id?: string | null;
  remote_key: string;
  status: string;
  attempts?: number | null;
  max_attempts?: number | null;
  next_attempt_at?: string | null;
  /** The failure type key, possibly after a "QUEUE_EXHAUSTED: " prefix. */
  last_error?: string | null;
  created_at: string;
  updated_at: string;
};
export function rowToJob(r: JobRow): PublishJob {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    articleId: r.article_id,
    approvedVersionId: r.approved_version_id ?? null,
    remoteKey: r.remote_key,
    // The database calls a finished job draft_created; the screen calls it done.
    status: r.status === "draft_created" ? "succeeded" : (JOB_STATUSES as readonly string[]).includes(r.status) ? (r.status as JobStatus) : "failed",
    attempts: r.attempts ?? 0,
    maxAttempts: r.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: r.next_attempt_at ?? null,
    failureType: (FAILURE_TYPES as readonly FailureType[]).find((f) => r.last_error?.endsWith(f)) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Whatever an RPC returned (uuid, row, rows, {id}) reduced to the job id. */
export function idOf(data: unknown): string | null {
  const d = Array.isArray(data) ? data[0] : data;
  if (typeof d === "string") return d;
  const o = d as { id?: unknown; job_id?: unknown } | null | undefined;
  const v = o?.id ?? o?.job_id;
  return typeof v === "string" ? v : null;
}
