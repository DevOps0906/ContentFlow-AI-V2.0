// Site readiness checks (migration 0011). Records what an operator confirmed; nothing is verified
// automatically, and nothing here feeds the article lifecycle: ad status never blocks publishing.

export const checkStatuses = ["pass", "fail", "unknown", "not_applicable"] as const;
export const adStatuses = [
  "not_configured", "preparing", "review_pending", "active", "limited", "rejected", "disabled", "unknown",
] as const;
export type SiteCheckStatus = (typeof checkStatuses)[number] | (typeof adStatuses)[number];

export const statusLabels: Record<SiteCheckStatus, string> = {
  pass: "충족",
  fail: "미충족",
  unknown: "미확인",
  not_applicable: "해당 없음",
  not_configured: "미설정",
  preparing: "준비 중",
  review_pending: "심사 대기",
  active: "게재 중",
  limited: "제한",
  rejected: "거절",
  disabled: "중지",
};

const ELIGIBILITY = "https://support.google.com/adsense/answer/9724?hl=ko";
const PROGRAM_POLICY = "https://support.google.com/adsense/answer/48182?hl=ko";
const ADS_TXT = "https://support.google.com/adsense/answer/12171612?hl=ko";
const CONSENT = "https://support.google.com/adsense/answer/13554116?hl=ko";

export const siteCheckItems = [
  {
    key: "ownership_access", scope: "site", label: "소유·접근", policyUrl: ELIGIBILITY,
    hint: "도메인·CMS 권한·공개 URL·크롤링 차단을 확인합니다. 접근 가능이 색인이나 승인을 뜻하지는 않습니다.",
  },
  {
    key: "content_navigation", scope: "site", label: "콘텐츠·탐색", policyUrl: ELIGIBILITY,
    hint: "빈 페이지, 복제, 깨진 메뉴, 출처·권리를 확인합니다. 점수로 정책 적합을 판정하지 않습니다.",
  },
  {
    key: "operator_privacy", scope: "site", label: "운영자·개인정보 안내", policyUrl: null,
    hint: "안내 페이지 URL과 검토 내용을 기록합니다. 소개·문의는 운영 권장이며 지역별 의무와 구분합니다.",
  },
  {
    key: "ad_status", scope: "ad", label: "광고 상태", policyUrl: PROGRAM_POLICY,
    hint: "플랫폼 관리 화면에서 본 상태와 원문을 기록합니다. 글 작성·내보내기·발행과 무관합니다.",
  },
  {
    key: "ad_connection", scope: "ad", label: "광고 연결", policyUrl: null,
    hint: "게시자 ID, 설치 위치, 중복 삽입 여부를 기록합니다. ID 기록만으로 게재 중이라 보지 않습니다.",
  },
  {
    key: "ads_txt", scope: "ad", label: "ads.txt", policyUrl: ADS_TXT,
    hint: "적용 가능 여부·게시자 ID·접근 결과를 기록합니다. 권장 항목이며 미설치만으로 승인 불가가 아닙니다.",
  },
  {
    key: "consent_management", scope: "ad", label: "동의 관리", policyUrl: CONSENT,
    hint: "대상 방문 지역과 CMP 필요 여부를 기록합니다. EEA·영국·스위스 개인 맞춤 광고는 인증 CMP 요건을 따로 확인합니다.",
  },
  {
    key: "post_launch", scope: "ad", label: "게재 후 운영", policyUrl: PROGRAM_POLICY,
    hint: "정책 알림, 유입 급변, 잘못된 광고 배치를 점검합니다. 무효 트래픽을 확정 진단하지 않습니다.",
  },
] as const;
export type SiteCheckKey = (typeof siteCheckItems)[number]["key"];

/** The statuses an item accepts: the ad status has its own scale. */
export const statusesFor = (key: SiteCheckKey): readonly SiteCheckStatus[] =>
  key === "ad_status" ? adStatuses : checkStatuses;
/** "Not checked yet" and "not set up" have nothing to cite; every other verdict needs a basis. */
export const needsEvidence = (status: SiteCheckStatus) => status !== "unknown" && status !== "not_configured";

export type SiteCheckInput = {
  key: SiteCheckKey;
  status: SiteCheckStatus;
  evidenceUrl: string | null;
  note: string | null;
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
function validUrl(url: string) {
  if (url.length > 2000 || !/^https?:\/\/\S+$/i.test(url)) return false;
  return URL.canParse(url);
}

/** Validates what the browser sent. Workspace, checker and time are never taken from it. */
export function parseSiteCheck(input: unknown): SiteCheckInput {
  const r = (input ?? {}) as Record<string, unknown>;
  const item = siteCheckItems.find((i) => i.key === r.key);
  if (!item) throw new Error("알 수 없는 점검 항목입니다.");
  const status = r.status as SiteCheckStatus;
  if (!statusesFor(item.key).includes(status)) throw new Error("이 항목에 쓸 수 없는 상태입니다.");
  const evidenceUrl = text(r.evidenceUrl) || null;
  if (evidenceUrl && !validUrl(evidenceUrl)) throw new Error("근거 URL은 http 또는 https 주소여야 합니다.");
  const note = text(r.note) || null;
  if (note && note.length > 1000) throw new Error("메모는 1000자까지 쓸 수 있습니다.");
  if (needsEvidence(status) && !evidenceUrl && !note) throw new Error("이 상태는 근거 URL이나 메모가 필요합니다.");
  return { key: item.key, status, evidenceUrl, note };
}

export const toDbSiteCheck = (c: SiteCheckInput, workspaceId: string) => ({
  workspace_id: workspaceId,
  check_key: c.key,
  status: c.status,
  evidence_url: c.evidenceUrl,
  note: c.note,
});

export const SITE_CHECK_COLUMNS = "check_key,status,evidence_url,note,checked_by,checked_at";
export type SiteCheckDbRow = {
  check_key: SiteCheckKey;
  status: SiteCheckStatus;
  evidence_url: string | null;
  note: string | null;
  checked_by: string;
  checked_at: string;
};
export type SiteCheck = SiteCheckInput & { checkedBy: string | null; checkedAt: string | null };

export const dbToSiteCheck = (r: SiteCheckDbRow, checkedBy: string | null): SiteCheck => ({
  key: r.check_key,
  status: r.status,
  evidenceUrl: r.evidence_url,
  note: r.note,
  checkedBy,
  checkedAt: r.checked_at,
});

/** One entry per item in display order; an item nobody recorded reads as unknown with no time. */
export function mergeSiteChecks(saved: SiteCheck[]): SiteCheck[] {
  return siteCheckItems.map(
    (i) =>
      saved.find((c) => c.key === i.key) ?? {
        key: i.key, status: "unknown", evidenceUrl: null, note: null, checkedBy: null, checkedAt: null,
      },
  );
}

export const STALE_AFTER_DAYS = 90;
export function isStale(checkedAt: string | null, now = Date.now()) {
  if (!checkedAt) return false;
  return now - new Date(checkedAt).getTime() > STALE_AFTER_DAYS * 86_400_000;
}

export function summarizeSiteChecks(checks: SiteCheck[], now = Date.now()) {
  return {
    recorded: checks.filter((c) => c.checkedAt).length,
    failed: checks.filter((c) => c.status === "fail").length,
    stale: checks.filter((c) => isStale(c.checkedAt, now)).length,
  };
}
