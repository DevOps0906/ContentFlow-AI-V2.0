// Rule-based Title Lab. No AI/network: deterministic candidates from keyword + template.

export type TitleCandidate = { title: string; pattern: string; warnings: string[] };

const MAX_LEN = 60;

const patterns: { name: string; build: (k: string) => string }[] = [
  { name: "방법", build: (k) => `${k} 방법: 처음부터 차근차근 정리` },
  { name: "체크리스트", build: (k) => `${k} 전에 꼭 확인할 체크리스트` },
  { name: "문제해결", build: (k) => `${k} 안 될 때 원인과 해결 순서` },
  { name: "비교", build: (k) => `${k}, 무엇을 기준으로 고를까` },
  { name: "실수", build: (k) => `${k}에서 자주 하는 실수와 피하는 법` },
  { name: "요약", build: (k) => `${k} 핵심만 5분 요약` },
];

/** Warnings only flag things we can verify mechanically; they never block. */
export function titleWarnings(title: string): string[] {
  const w: string[] = [];
  if (title.length > MAX_LEN) w.push(`제목이 ${MAX_LEN}자를 넘어 검색 결과에서 잘릴 수 있습니다.`);
  if (/(무조건|100%|반드시 성공|확실한 수익|월 \d+만원)/.test(title))
    w.push("과장·보장 표현은 근거 없이 쓰지 마세요.");
  return w;
}

export function generateTitles(keyword: string): TitleCandidate[] {
  const k = keyword.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!k) throw new Error("키워드를 입력해주세요.");
  if (k.length > 40) throw new Error("키워드가 너무 깁니다. (최대 40자)");
  return patterns.slice(0, 5).map((p) => {
    const title = p.build(k);
    return { title, pattern: p.name, warnings: titleWarnings(title) };
  });
}