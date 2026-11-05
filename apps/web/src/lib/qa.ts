// Rule-based QA. `blockers` are exactly the review rules the database also enforces
// (reviewErrors); `warnings` are advisory checks that a person must weigh but that never
// block, because they are heuristics and not proof of a problem. This is not a fact check.
import { reviewErrors, type Article } from "./content";
import { normalizePhrase } from "./keywords";

export type QaFinding = { code: string; message: string };
export type QaReport = {
  blockers: string[];
  warnings: QaFinding[];
  /** Number of advisory checks that ran, so "0 warnings" is distinguishable from "not run". */
  checked: number;
};

const GUARANTEE = /(수익\s*보장|무조건|100\s*%\s*(성공|보장|확실)|반드시\s*(돈|수익|성공)|손해\s*없)/;
const PLACEHOLDER_HOSTS = /^(example\.(com|org|net)|localhost|127\.0\.0\.1)$/i;

function sections(body: string) {
  const out: { heading: string; text: string }[] = [];
  let cur: { heading: string; text: string } | null = null;
  for (const line of body.split("\n")) {
    if (/^#{1,2}\s/.test(line)) {
      if (cur) out.push(cur);
      cur = { heading: line.replace(/^#{1,2}\s*/, "").trim(), text: "" };
    } else if (cur) cur.text += line;
  }
  if (cur) out.push(cur);
  return out;
}

export function runQa(article: Article, others: Article[] = []): QaReport {
  const warnings: QaFinding[] = [];
  const add = (code: string, message: string) => warnings.push({ code, message });
  const title = article.title.trim();
  const secs = sections(article.body);
  const plain = article.body.replace(/^#{1,2}\s.*$/gm, "").replace(/\s+/g, "");

  if (title && (title.length < 8 || title.length > 60))
    add("title-length", `제목이 ${title.length}자입니다. 검색 결과에서 잘리지 않도록 8~60자를 권장합니다.`);
  if (secs.length === 0) add("no-headings", "소제목(##)이 없습니다. 구조 없이 이어진 글은 읽기 어렵습니다.");
  const empty = secs.filter((s) => !s.text.trim()).map((s) => s.heading);
  if (empty.length)
    add("empty-sections", `내용이 없는 소제목이 있습니다: ${empty.slice(0, 3).join(", ")}${empty.length > 3 ? ` 외 ${empty.length - 3}개` : ""}`);
  if (plain.length > 0 && plain.length < 300)
    add("short-body", `본문이 ${plain.length}자로 짧습니다. 독자 질문에 충분히 답했는지 확인하세요.`);
  const kw = article.keyword.trim();
  if (kw && !normalizePhrase(`${title} ${article.body}`).includes(normalizePhrase(kw)))
    add("keyword-missing", `핵심 키워드 '${kw}'가 제목과 본문에 없습니다.`);
  if (GUARANTEE.test(`${title} ${article.body}`))
    add("guarantee", "수익·성과를 보장하는 표현이 있습니다. 근거 없는 보장 표현은 피하세요.");
  try {
    const host = new URL(article.sourceUrl).hostname;
    if (PLACEHOLDER_HOSTS.test(host))
      add("placeholder-source", `근거 URL이 예시/로컬 주소(${host})입니다. 실제 근거 자료인지 확인하세요.`);
  } catch {
    // an invalid URL is already a blocker
  }
  const key = normalizePhrase(title);
  if (key) {
    const dup = others.filter((o) => o.id !== article.id && normalizePhrase(o.title) === key);
    if (dup.length) add("duplicate-title", `같은 제목의 다른 글이 ${dup.length}개 있습니다. 중복 콘텐츠가 아닌지 확인하세요.`);
  }
  const sameKw = others.filter(
    (o) => o.id !== article.id && kw && normalizePhrase(o.keyword) === normalizePhrase(kw) && o.status !== "idea",
  );
  if (sameKw.length) add("keyword-overlap", `같은 키워드로 작성된 글이 ${sameKw.length}개 더 있습니다. 서로 검색 의도가 겹치지 않는지 확인하세요.`);

  return { blockers: reviewErrors(article), warnings, checked: 8 };
}