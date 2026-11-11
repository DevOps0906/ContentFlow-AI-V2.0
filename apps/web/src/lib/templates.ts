export type Template = {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  color: string;
  blocks: string[];
  evidence: string;
};

export const templates: Template[] = [
  {
    id: "T01",
    name: "검색형 정보 가이드",
    category: "정보",
    description: "독자의 질문에 명확한 답변을 전하는 기본 가이드",
    icon: "book",
    color: "mint",
    blocks: [
      "핵심 답변",
      "대상과 적용 조건",
      "단계별 안내",
      "주의 사항",
      "FAQ",
      "출처",
    ],
    evidence: "핵심 정보의 공식 출처와 확인일",
  },
  {
    id: "T02",
    name: "오류 해결 가이드",
    category: "정보",
    description: "문제의 원인부터 재현 가능한 해결 과정까지",
    icon: "tool",
    color: "blue",
    blocks: [
      "증상과 오류 메시지",
      "사용 환경과 버전",
      "원인과 우선 점검",
      "단계별 해결",
      "성공 확인",
      "출처",
    ],
    evidence: "재현 환경, 실행 결과, 공식 문서",
  },
  {
    id: "T03",
    name: "정부지원 · 환급",
    category: "생활",
    description: "대상과 조건, 신청 절차를 빠짐없이 정리",
    icon: "landmark",
    color: "purple",
    blocks: [
      "정보 기준일",
      "지원 대상",
      "기간과 조건",
      "공식 신청 절차",
      "주의 사항",
      "공식 출처",
    ],
    evidence: "유효한 공식 공고와 기준일. 민감 주제 별도 검수",
  },
  {
    id: "T04",
    name: "가격 · 서비스 비교",
    category: "비교",
    description: "동일한 기준으로 비교하고 합리적인 선택을 돕기",
    icon: "compare",
    color: "amber",
    blocks: [
      "비교 대상과 기준",
      "가격과 기능 비교",
      "장점과 단점",
      "대상별 선택 안내",
      "한계와 조건",
      "출처",
    ],
    evidence: "대상별 가격·버전·조건의 출처와 확인일",
  },
  {
    id: "T05",
    name: "실사용 리뷰",
    category: "리뷰",
    description: "직접 경험한 과정과 솔직한 장단점을 담기",
    icon: "star",
    color: "rose",
    blocks: [
      "사용 환경과 증거",
      "직접 사용한 과정",
      "좋았던 점",
      "아쉬웠던 점",
      "사용 한계",
      "증빙과 출처",
    ],
    evidence: "실제 사용 사진·기록. 미사용 제품의 경험 작성 금지",
  },
  {
    id: "T06",
    name: "홈판 스토리",
    category: "스토리",
    description: "실제 경험의 맥락과 변화를 하나의 이야기로",
    icon: "feather",
    color: "mint",
    blocks: [
      "이야기의 배경",
      "검증된 상황과 경험",
      "과정과 변화",
      "독자에게 주는 의미",
      "사진과 증빙",
    ],
    evidence: "본인의 경험·사진 또는 사용권이 있는 자료",
  },
  {
    id: "T07",
    name: "쇼핑 · 제휴 비교",
    category: "비교",
    description: "경제적 관계를 알리고 구매 기준을 제시",
    icon: "bag",
    color: "blue",
    blocks: [
      "경제적 관계 고지",
      "구매 기준",
      "제품 비교",
      "제한과 주의",
      "제휴 링크",
      "출처",
    ],
    evidence: "제휴 관계 고지, 비교 근거와 가격 기준일",
  },
  {
    id: "T08",
    name: "이슈 · 시즌 콘텐츠",
    category: "생활",
    description: "달라진 정보와 영향을 기준 시점에 맞춰 전달",
    icon: "calendar",
    color: "amber",
    blocks: [
      "사실 기준 시각",
      "무엇이 달라졌나",
      "영향받는 대상",
      "확인된 사실",
      "후속 확인",
      "공식 발표",
    ],
    evidence: "발표 원문과 확인 시각, 후속 검토일",
  },
  {
    id: "T09",
    name: "전문 튜토리얼",
    category: "정보",
    description: "설치부터 실행, 검증까지 따라 할 수 있는 안내",
    icon: "code",
    color: "purple",
    blocks: [
      "환경과 버전",
      "예상 결과",
      "준비와 설치",
      "실행 과정",
      "결과 검증",
      "FAQ와 출처",
    ],
    evidence: "실행 환경, 검증 결과와 공식 문서",
  },
  {
    id: "T10",
    name: "전문 리서치",
    category: "리서치",
    description: "원본 데이터와 분석으로 깊이 있는 인사이트",
    icon: "chart",
    color: "rose",
    blocks: [
      "핵심 결론",
      "조사 방법",
      "원본 데이터",
      "분석 결과",
      "해석의 한계",
      "출처와 확인일",
    ],
    evidence: "데이터 출처·사용권, 분석 방법과 한계",
  },
];

/**
 * MVP templates whose blocks and evidence are pinned. Bump the number when either changes
 * (a test holds the pinned contents). The other seven templates are not versioned yet.
 */
const TEMPLATE_VERSIONS: Record<string, string | undefined> = {
  T01: "T01@1",
  T02: "T02@1",
  T04: "T04@1",
};
export function templateVersion(id: string) {
  return TEMPLATE_VERSIONS[id];
}

export function findTemplate(id: string) {
  return templates.find((t) => t.id === id) ?? templates[0];
}
export function templateBody(id: string) {
  return findTemplate(id)
    .blocks.map((block) => `## ${block}\n\n`)
    .join("\n");
}
