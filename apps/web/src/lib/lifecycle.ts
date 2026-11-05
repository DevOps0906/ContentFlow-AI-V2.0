// Full article lifecycle from PRD §3 / DATABASE_SCHEMA §3. Must match the `article_state`
// enum in supabase/migrations (enforced by tests/lifecycle.test.ts).
// The local prototype only drives draft/review/approved; see localToLifecycle.

export const lifecycleStates = [
  "idea",
  "researching",
  "briefing",
  "drafting",
  "qa_pending",
  "needs_revision",
  "approval_pending",
  "approved",
  "export_ready",
  "manual_pending",
  "publishing",
  "publish_failed",
  "draft_created",
  "published",
  "monitoring",
  "update_due",
] as const;
export type LifecycleState = (typeof lifecycleStates)[number];

export const lifecycleLabels: Record<LifecycleState, string> = {
  idea: "아이디어",
  researching: "자료 조사",
  briefing: "브리프 작성",
  drafting: "초안 작성",
  qa_pending: "QA 대기",
  needs_revision: "수정 필요",
  approval_pending: "승인 대기",
  approved: "승인 완료",
  export_ready: "내보내기 준비",
  manual_pending: "수동 게시 대기",
  publishing: "발행 중",
  publish_failed: "발행 실패",
  draft_created: "초안 생성됨",
  published: "게시 완료",
  monitoring: "성과 모니터링",
  update_due: "업데이트 필요",
};

const transitions: Record<LifecycleState, readonly LifecycleState[]> = {
  idea: ["researching"],
  researching: ["briefing"],
  briefing: ["drafting"],
  drafting: ["qa_pending"],
  qa_pending: ["needs_revision", "approval_pending"],
  needs_revision: ["drafting"],
  approval_pending: ["approved", "needs_revision"],
  // An approval is only valid for the exact approved content. Edits go back to drafting.
  approved: ["export_ready", "drafting"],
  export_ready: ["manual_pending", "publishing", "drafting"],
  manual_pending: ["published", "export_ready"],
  publishing: ["draft_created", "publish_failed"],
  // Explicit retry only: failure never silently re-publishes.
  publish_failed: ["publishing", "manual_pending", "drafting"],
  // A created remote draft is not "published" until an operator confirms it.
  draft_created: ["published", "drafting"],
  published: ["monitoring", "update_due"],
  monitoring: ["update_due"],
  update_due: ["drafting"],
};

export function canTransition(from: LifecycleState, to: LifecycleState) {
  return transitions[from].includes(to);
}
export function nextStates(from: LifecycleState): readonly LifecycleState[] {
  return transitions[from];
}
export function transition(
  from: LifecycleState,
  to: LifecycleState,
): LifecycleState {
  if (!canTransition(from, to))
    throw new Error(`허용되지 않는 상태 전환입니다: ${from} → ${to}`);
  return to;
}
/** States that must never be reachable without a prior approval. */
export const requiresApproval: readonly LifecycleState[] = [
  "approved",
  "export_ready",
  "manual_pending",
  "publishing",
  "publish_failed",
  "draft_created",
  "published",
  "monitoring",
  "update_due",
];

export const legacyStatuses = ["draft", "review", "approved"] as const;
export type LegacyStatus = (typeof legacyStatuses)[number];

/** Converts the v1 local prototype status (3 steps) into the full lifecycle. */
export function localToLifecycle(status: LegacyStatus): LifecycleState {
  return { draft: "drafting", review: "approval_pending", approved: "approved" }[
    status
  ] as LifecycleState;
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return lifecycleStates.includes(value as LifecycleState);
}

/** Planning states keep their state while the operator fills in the manuscript. */
const editableWithoutReset: readonly LifecycleState[] = [
  "idea",
  "researching",
  "briefing",
  "drafting",
];

/**
 * State after the manuscript content changes. This is a safety reset, not a forward
 * transition: any review, approval or publication applied to older content is void,
 * so the article goes back to drafting and must be reviewed and approved again.
 */
export function afterEdit(state: LifecycleState): LifecycleState {
  return editableWithoutReset.includes(state) ? state : "drafting";
}

/** States whose transitions need a CMS API, which the local prototype does not have. */
export const cmsOnlyStates: readonly LifecycleState[] = [
  "publishing",
  "publish_failed",
  "draft_created",
];

export type LocalAction = { to: LifecycleState; available: boolean };
/** Next states for the UI; CMS-only targets are listed but not available locally. */
export function localActions(from: LifecycleState): LocalAction[] {
  return nextStates(from).map((to) => ({
    to,
    available: !cmsOnlyStates.includes(to),
  }));
}

export const phases = ["plan", "write", "approve", "publish", "after"] as const;
export type Phase = (typeof phases)[number];
export const phaseLabels: Record<Phase, string> = {
  plan: "기획",
  write: "작성·검수",
  approve: "승인·내보내기",
  publish: "게시",
  after: "사후 관리",
};
const phaseMap: Record<LifecycleState, Phase> = {
  idea: "plan",
  researching: "plan",
  briefing: "plan",
  drafting: "write",
  qa_pending: "write",
  needs_revision: "write",
  approval_pending: "write",
  approved: "approve",
  export_ready: "approve",
  manual_pending: "publish",
  publishing: "publish",
  publish_failed: "publish",
  draft_created: "publish",
  published: "publish",
  monitoring: "after",
  update_due: "after",
};
export function phaseOf(state: LifecycleState): Phase {
  return phaseMap[state];
}
/** States that need operator attention regardless of their phase. */
export const warningStates: readonly LifecycleState[] = [
  "needs_revision",
  "publish_failed",
  "update_due",
];
