"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, FileUp, Info, Trash2 } from "lucide-react";
import {
  importKeywords,
  KEYWORD_STORAGE_KEY,
  parseKeywords,
  type ImportResult,
  type Keyword,
} from "@/lib/keywords";
import { generateTitles, type TitleCandidate } from "@/lib/titles";
import { PageHeading } from "./shell";

export function Keywords() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportResult | null>(null);
  const [selected, setSelected] = useState("");
  const [titles, setTitles] = useState<TitleCandidate[]>([]);
  const [message, setMessage] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setKeywords(parseKeywords(localStorage.getItem(KEYWORD_STORAGE_KEY)));
    } catch {
      setError(
        "저장된 키워드를 읽을 수 없습니다. 원본 데이터는 덮어쓰지 않았습니다.",
      );
    }
    setReady(true);
  }, []);

  function persist(next: Keyword[]) {
    if (error) return false;
    try {
      localStorage.setItem(KEYWORD_STORAGE_KEY, JSON.stringify(next));
      setKeywords(next);
      return true;
    } catch {
      setError("저장 공간이 부족하거나 사용할 수 없습니다.");
      return false;
    }
  }

  async function onFile(f: File | undefined) {
    setMessage("");
    setReport(null);
    if (!f) return;
    try {
      const result = importKeywords(await f.text(), keywords);
      if (persist(result.keywords)) setReport(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "가져오기에 실패했습니다.");
    } finally {
      if (file.current) file.current.value = "";
    }
  }

  function makeTitles(phrase: string) {
    setSelected(phrase);
    setMessage("");
    try {
      setTitles(generateTitles(phrase));
    } catch (e) {
      setTitles([]);
      setMessage(e instanceof Error ? e.message : "제목을 만들 수 없습니다.");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("제목을 복사했어요.");
    } catch {
      setMessage("복사하지 못했어요. 제목을 직접 선택해 복사해주세요.");
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="KEYWORDS"
        title="키워드 · 제목 랩"
        description="CSV로 키워드를 가져오고, 키워드별 제목 후보를 확인하세요."
      />
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>이 브라우저에만 저장돼요.</b> 검색량·경쟁도는 외부 도구에서 가져온
          값이 없으면 표시하지 않습니다. 제목 후보는 AI가 아니라 고정 규칙으로
          만든 초안이에요.
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <section className="panel">
        <h2>CSV 가져오기</h2>
        <p className="metric-note">
          첫 줄 헤더(키워드, 검색의도, 우선순위 1~5, 메모)는 선택이에요. 헤더가
          없으면 첫 열을 키워드로 읽습니다. 중복 키워드는 기존 값을 덮어쓰지
          않고 건너뜁니다. 최대 1MB · 5,000개.
        </p>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          id="keyword-csv"
          aria-label="키워드 CSV 파일 선택"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button
          className="button primary"
          disabled={!ready || !!error}
          onClick={() => file.current?.click()}
        >
          <FileUp size={16} /> CSV 파일 선택
        </button>
        {report && (
          <div role="status" className="success-message">
            {report.added}개 추가 · 중복 {report.duplicates}개 건너뜀 · 오류{" "}
            {report.invalid.length}개
            {report.invalid.length > 0 && (
              <ul>
                {report.invalid.slice(0, 10).map((i) => (
                  <li key={i.line}>
                    {i.line}행: {i.reason}
                  </li>
                ))}
                {report.invalid.length > 10 && (
                  <li>외 {report.invalid.length - 10}건</li>
                )}
              </ul>
            )}
          </div>
        )}
        {message && (
          <p role="status" className="metric-note">
            {message}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>키워드 {keywords.length}개</h2>
        {!ready ? (
          <p className="metric-note">불러오는 중…</p>
        ) : keywords.length === 0 ? (
          <div className="empty-state">
            <h3>아직 키워드가 없어요</h3>
            <p>CSV 파일을 가져오면 여기에 표시됩니다.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">키워드</th>
                    <th scope="col">검색의도</th>
                    <th scope="col">우선순위</th>
                    <th scope="col">메모</th>
                    <th scope="col">
                      <span className="sr-only">작업</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...keywords]
                    .sort((a, b) => a.priority - b.priority)
                    .slice(0, 200)
                    .map((k) => (
                      <tr key={k.id}>
                        <td>{k.phrase}</td>
                        <td>{k.intent || "—"}</td>
                        <td>{k.priority}</td>
                        <td>{k.note || "—"}</td>
                        <td className="table-actions">
                          <button
                            className="button secondary"
                            aria-pressed={selected === k.phrase}
                            onClick={() => makeTitles(k.phrase)}
                          >
                            제목 후보
                          </button>
                          <button
                            className="button secondary"
                            aria-label={`${k.phrase} 삭제`}
                            onClick={() =>
                              persist(keywords.filter((x) => x.id !== k.id))
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {keywords.length > 200 && (
              <p className="metric-note">
                처음 200개만 표시합니다. 우선순위가 높은 순(1이 가장 높음)입니다.
              </p>
            )}
          </>
        )}
      </section>

      {titles.length > 0 && (
        <section className="panel" aria-live="polite">
          <h2>“{selected}” 제목 후보</h2>
          <ul className="title-list">
            {titles.map((t) => (
              <li key={t.pattern}>
                <b>{t.title}</b> <small>({t.pattern})</small>
                <button
                  className="button secondary"
                  aria-label={`${t.title} 복사`}
                  onClick={() => copy(t.title)}
                >
                  <Copy size={14} />
                </button>
                {t.warnings.map((w) => (
                  <p key={w} className="metric-note">
                    {w}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
