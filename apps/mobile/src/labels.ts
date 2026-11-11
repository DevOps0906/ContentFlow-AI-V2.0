/** Mirrors apps/web/src/lib/lifecycle.ts (lifecycleStates / lifecycleLabels). Update both together. */
export const lifecycleLabels = {
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
} as const;

export type LifecycleState = keyof typeof lifecycleLabels;

export function statusLabel(status: string): string {
  return (lifecycleLabels as Record<string, string>)[status] ?? status;
}

/** The subset of the server's Article that the app reads. */
export type Article = {
  id: string;
  title: string;
  keyword: string;
  platform: string;
  body: string;
  sourceUrl: string;
  status: string;
  updatedAt: string;
};
