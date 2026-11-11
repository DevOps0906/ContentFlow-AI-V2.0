// Improvement queue (migration 0012). A task records what was observed and who will look at it.
// It never changes an article, never publishes anything and never claims that a change worked.
import { isUuid } from "./articles-db";
import { parseDay } from "./costs";

export const improvementStates = ["open", "in_progress", "done", "cancelled"] as const;
export type ImprovementState = (typeof improvementStates)[number];
export const improvementStateLabels: Record<ImprovementState, string> = {
  open: "대기",
  in_progress: "진행 중",
  done: "변경 완료",
  cancelled: "취소",
};

export type ImprovementInput = {
  articleId: string;
  targetUrl: string;
  evidence: string;
  observedFrom: string;
  observedTo: string;
  assigneeId: string;
  reviewAt: string;
};
export type ImprovementUpdate = {
  id: string;
  state: ImprovementState;
  resultVersion: number | null;
  assigneeId: string;
};
export type Improvement = Omit<ImprovementInput, "assigneeId"> & {
  id: string;
  assigneeId: string | null;
  state: ImprovementState;
  resultVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
function uuid(v: unknown, message: string): string {
  const s = text(v);
  if (!isUuid(s)) throw new Error(message);
  return s;
}

/** Validates a new task. Workspace, author, state and result version are never taken from it. */
export function parseImprovement(input: unknown): ImprovementInput {
  const r = (input ?? {}) as Record<string, unknown>;
  const articleId = uuid(r.articleId, "대상 글을 선택해주세요.");
  const targetUrl = text(r.targetUrl);
  if (targetUrl.length > 2000 || !/^https?:\/\/\S+$/i.test(targetUrl) || !URL.canParse(targetUrl))
    throw new Error("대상 URL은 http 또는 https 주소여야 합니다.");
  const evidence = text(r.evidence);
  if (!evidence || evidence.length > 2000) throw new Error("관측 근거를 1~2000자로 입력해주세요.");
  const observedFrom = parseDay(r.observedFrom, "관측 시작일");
  const observedTo = parseDay(r.observedTo, "관측 종료일");
  if (observedFrom > observedTo) throw new Error("관측 시작일은 종료일보다 늦을 수 없습니다.");
  const assigneeId = uuid(r.assigneeId, "담당자를 선택해주세요.");
  const reviewAt = parseDay(r.reviewAt, "검토 기한");
  return { articleId, targetUrl, evidence, observedFrom, observedTo, assigneeId, reviewAt };
}

export function parseImprovementUpdate(input: unknown): ImprovementUpdate {
  const r = (input ?? {}) as Record<string, unknown>;
  const id = uuid(r.id, "개선 작업을 찾을 수 없습니다.");
  const state = r.state as ImprovementState;
  if (!improvementStates.includes(state)) throw new Error("알 수 없는 상태입니다.");
  const raw = r.resultVersion;
  const resultVersion = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (resultVersion !== null && (!Number.isInteger(resultVersion) || resultVersion <= 0 || resultVersion > 2_147_483_647))
    throw new Error("변경 버전은 1 이상의 정수여야 합니다.");
  if (state === "done" && resultVersion === null) throw new Error("변경 완료는 변경 버전이 필요합니다.");
  return { id, state, resultVersion, assigneeId: uuid(r.assigneeId, "담당자를 선택해주세요.") };
}

export const toDbImprovement = (t: ImprovementInput, workspaceId: string, userId: string) => ({
  workspace_id: workspaceId,
  article_id: t.articleId,
  target_url: t.targetUrl,
  evidence: t.evidence,
  observed_from: t.observedFrom,
  observed_to: t.observedTo,
  assignee_id: t.assigneeId,
  review_at: t.reviewAt,
  created_by: userId,
});

export const IMPROVEMENT_COLUMNS =
  "id,article_id,target_url,evidence,observed_from,observed_to,assignee_id,review_at,state,result_version,created_at,updated_at";
export type ImprovementDbRow = {
  id: string;
  article_id: string;
  target_url: string;
  evidence: string;
  observed_from: string;
  observed_to: string;
  assignee_id: string | null;
  review_at: string;
  state: ImprovementState;
  result_version: number | null;
  created_at: string;
  updated_at: string;
};
export const dbToImprovement = (r: ImprovementDbRow): Improvement => ({
  id: r.id,
  articleId: r.article_id,
  targetUrl: r.target_url,
  evidence: r.evidence,
  observedFrom: r.observed_from,
  observedTo: r.observed_to,
  assigneeId: r.assignee_id,
  reviewAt: r.review_at,
  state: r.state,
  resultVersion: r.result_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Past its review date and still unfinished. `today` is YYYY-MM-DD. */
export const isOverdue = (t: Pick<Improvement, "state" | "reviewAt">, today: string) =>
  (t.state === "open" || t.state === "in_progress") && t.reviewAt < today;

/**
 * The URL field after another article is picked. Only a confirmed public URL is offered, because a
 * remote draft link is not the page readers see. A value filled in for the previous article is
 * cleared with it; a URL the operator typed stays.
 */
export function targetUrlAfterPick(current: string, previousPublished: string | undefined, nextPublished: string | undefined) {
  if (nextPublished) return nextPublished;
  return current === previousPublished ? "" : current;
}

/** Maps the database refusals specific to this table; anything else falls through to `dbError`. */
export function improvementError(error: { code?: string; message?: string }): { status: number; message: string } | null {
  if (error.code === "23503")
    return { status: 422, message: "대상 글, 담당자 또는 변경 버전이 이 워크스페이스의 기록과 맞지 않습니다." };
  return null;
}
