"use client";

import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleAlert, CircleDashed, ExternalLink, Info, Newspaper, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import {
  FORMULAS,
  HOMEFEED_STORAGE_KEY,
  PURPOSES,
  applyEdit,
  charLength,
  isPartialViews,
  PURPOSE_TARGET,
  THUMBNAIL_CHECKS,
  NAVER_NOTICE,
  NAVER_TERMS_URL,
  THUMBNAIL_TYPES,
  checkBody,
  checkTitle,
  formatShare,
  formatStat,
  formulaInfo,
  keywordSetWarnings,
  newPost,
  parseCount,
  parseHomefeed,
  purposeInfo,
  researchInputKey,
  resultInputKey,
  splitKeywords,
  summarize,
  thumbnailTypeLabels,
  titleExtraWarnings,
  totalViews,
  type CheckItem,
  type Formula,
  type HomefeedPost,
  type HomefeedRecord,
  type Purpose,
  type ThumbnailType,
} from "@/lib/naver-homefeed";
import type { ResearchResult, TitleCandidateResult, Volume } from "@/lib/naver-research";
import { loadChoice } from "@/lib/ai-settings";
import { runSummary, type RunInfo } from "@/lib/agent-runs";
import { postJson } from "./integrations";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";
import { useWorkspace } from "./workspace";

const statusText = { pass: "통과", warn: "경고", manual: "직접 확인" } as const;

function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ul className="hf-checks">
      {items.map((c) => (
        <li key={c.id} className={`hf-check ${c.status}`}>
          {c.status === "pass" ? <CircleCheck size={15} aria-hidden /> : c.status === "warn" ? <CircleAlert size={15} aria-hidden /> : <CircleDashed size={15} aria-hidden />}
          <span>
            <span className="sr-only">{statusText[c.status]}: </span>
            {c.label}
            {c.detail && <small>{c.detail}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const formatVolume = (v: Volume) => (v === null ? "N/A" : typeof v === "number" ? v.toLocaleString("ko-KR") : v);
const STALE_ANSWER = "입력이 바뀌어 받은 결과를 버렸습니다. 다시 실행해주세요.";
const sourceText = { ok: "연결됨", not_configured: "연결 안 됨", error: "오류" } as const;

function CountField({ id, label, value, onChange }: { id: string; label: string; value: number | null; onChange: (n: number | null) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        inputMode="numeric"
        placeholder="N/A"
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(parseCount(e.target.value))}
      />
    </div>
  );
}

export function NaverHomefeed() {
  const { articles, ready: wsReady } = useWorkspace();
  const [posts, setPosts] = useState<HomefeedPost[]>([]);
  const [ready, setReady] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<HomefeedPost | null>(null);
  const [articlePick, setArticlePick] = useState("");
  // Reference research and AI candidates live only on this screen (never stored, §11).
  // Each result keeps the input snapshot it was made from (researchInputKey / resultInputKey).
  const [research, setResearch] = useState<{ postId: string; key: string; data: ResearchResult } | null>(null);
  const [candidates, setCandidates] = useState<{ postId: string; key: string; items: TitleCandidateResult[]; note: string } | null>(null);
  /** Snapshot of the selected post right now; read when an answer arrives to drop late ones. */
  const liveKey = useRef({ research: "", titles: "" });
  const [busy, setBusy] = useState<"research" | "titles" | null>(null);
  const [aiError, setAiError] = useState("");

  useEffect(() => {
    liveKey.current = post ? { research: researchInputKey(post), titles: resultInputKey(post) } : { research: "", titles: "" };
  });

  useEffect(() => {
    try {
      const loaded = parseHomefeed(localStorage.getItem(HOMEFEED_STORAGE_KEY));
      setPosts(loaded);
      setSelectedId(loaded[0]?.id ?? null);
    } catch {
      setReadError("저장된 홈판 점검 데이터를 읽을 수 없습니다. 원본 데이터는 덮어쓰지 않았습니다.");
    }
    setReady(true);
  }, []);

  /** Keeps the edit on screen even if the browser refuses to store it. */
  function persist(next: HomefeedPost[]) {
    if (readError) return;
    setPosts(next);
    try {
      localStorage.setItem(HOMEFEED_STORAGE_KEY, JSON.stringify(next));
      setSaveError("");
    } catch {
      setSaveError("저장하지 못했습니다. 저장 공간이 부족하거나 사용할 수 없습니다. 변경 내용은 이 화면을 닫으면 사라집니다.");
    }
  }

  const post = posts.find((p) => p.id === selectedId) ?? null;
  function update(patch: Partial<HomefeedPost>) {
    if (!post) return;
    const now = new Date().toISOString();
    persist(posts.map((p) => (p.id === post.id ? applyEdit(p, patch, now) : p)));
  }
  function updateRecord(patch: Partial<HomefeedRecord>) {
    if (post) update({ record: { ...post.record, ...patch } });
  }

  function add() {
    const p = newPost(crypto.randomUUID(), new Date().toISOString());
    persist([p, ...posts]);
    setSelectedId(p.id);
  }

  function remove(target: HomefeedPost) {
    const next = posts.filter((p) => p.id !== target.id);
    persist(next);
    if (selectedId === target.id) setSelectedId(next[0]?.id ?? null);
  }

  async function runResearch() {
    if (!post || busy) return;
    const key = researchInputKey(post);
    setBusy("research");
    setAiError("");
    try {
      const data = await postJson<ResearchResult>("/api/naver/research", {
        mainKeyword: post.mainKeyword,
        detailKeywords: post.detailKeywords,
      });
      if (liveKey.current.research !== key) return setAiError(STALE_ANSWER);
      setResearch({ postId: post.id, key, data });
      setCandidates(null);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "레퍼런스를 분석하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  async function generateTitles() {
    if (!post || !ref || busy) return;
    const key = resultInputKey(post);
    setBusy("titles");
    setAiError("");
    try {
      const { titles, run } = await postJson<{ titles: TitleCandidateResult[]; run: RunInfo }>("/api/naver/titles", {
        purpose: post.purpose,
        formula: post.formula,
        mainKeyword: post.mainKeyword,
        detailKeywords: post.detailKeywords,
        subKeywords: post.subKeywords,
        thumbnailText: post.thumbnailText,
        // Search Ad related keywords only: blog search results never go to the AI (§11.2).
        research: { keywords: ref.keywords.items.map((k) => k.keyword) },
        ai: loadChoice(),
      });
      if (liveKey.current.titles !== key) return setAiError(STALE_ANSWER);
      setCandidates({ postId: post.id, key, items: titles, note: `모델 ${run.model} · ${runSummary(run)}` });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI 제목을 만들지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  function addKeyword(field: "detailKeywords" | "subKeywords", keyword: string) {
    if (!post) return;
    const list = splitKeywords(post[field]);
    if (list.some((k) => k.toLowerCase() === keyword.toLowerCase())) return;
    update({ [field]: [...list, keyword].join(", ") });
  }

  function loadArticle() {
    const a = articles.find((x) => x.id === articlePick);
    if (!a || !post) return;
    update({ title: a.title, body: a.body, mainKeyword: post.mainKeyword || a.keyword, articleId: a.id });
    setArticlePick("");
  }

  const summary = summarize(posts);
  const disabled = !ready || !!readError;
  const titleWarn = post ? titleExtraWarnings(post.title) : [];
  const ref = post && research?.key === researchInputKey(post) ? research.data : null;
  const picks = post && candidates?.key === resultInputKey(post) ? candidates : null;
  const stale = !!post && ((research?.postId === post.id && !ref) || (candidates?.postId === post.id && !picks));
  const hasMain = !!post && splitKeywords(post.mainKeyword).length > 0;

  return (
    <>
      <PageHeading
        eyebrow="NAVER HOMEFEED"
        title="네이버 홈판"
        description="글 목적·키워드 세트·제목·썸네일·본문을 규칙으로 점검하고, 발행 후 성과를 직접 기록하세요."
      />
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>노출·수익을 보장하지 않으며, 이 브라우저에만 저장돼요.</b> 네이버는 홈판 알고리즘을 공개하지 않습니다. 모든
          점검은 고정 규칙으로 만든 경고이고 발행을 막지 않습니다. 네이버 API·AI는 ‘레퍼런스 분석’·‘AI 제목 생성’을 누를 때만
          호출하고 결과는 저장하지 않습니다. 성과는 직접 입력한 값만 쓰고 없으면 N/A로 표시합니다.
        </div>
      </div>
      {readError && (
        <p role="alert" className="error-banner">
          {readError}
        </p>
      )}
      {saveError && (
        <p role="alert" className="error-banner">
          {saveError}
        </p>
      )}

      <section className="panel keywords-panel" aria-labelledby="hf-list">
        <div className="hf-list-head">
          <h2 id="hf-list">점검 중인 글</h2>
          <button className="button primary" onClick={add} disabled={disabled}>
            <Plus size={16} /> 새 글 점검
          </button>
        </div>
        {ready && posts.length === 0 && !readError ? (
          <div className="empty-state">
            <Newspaper size={28} aria-hidden />
            <h2>아직 점검 중인 글이 없어요</h2>
            <p>‘새 글 점검’을 눌러 글 목적부터 정해 보세요.</p>
          </div>
        ) : (
          <ul className="hf-posts">
            {posts.map((p) => (
              <li key={p.id} className={p.id === selectedId ? "active" : undefined}>
                <button type="button" className="hf-post-open" aria-pressed={p.id === selectedId} onClick={() => setSelectedId(p.id)}>
                  <b>{p.title.trim() || "제목 없음"}</b>
                  <span>
                    {purposeInfo[p.purpose].label} · {p.formula}
                    {p.record.publishedOn && ` · 발행 ${p.record.publishedOn}`}
                  </span>
                </button>
                <button type="button" className="icon-button" aria-label={`‘${p.title.trim() || "제목 없음"}’ 삭제`} onClick={() => setDeleting(p)} disabled={disabled}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {post && (
        <>
          <section className="panel keywords-panel" aria-labelledby="hf-purpose">
            <h2 id="hf-purpose">1. 글 목적</h2>
            <fieldset className="hf-purposes" disabled={disabled}>
              <legend className="sr-only">글 목적</legend>
              {PURPOSES.map((key) => (
                <label key={key} className={`hf-purpose${post.purpose === key ? " active" : ""}`}>
                  <input
                    type="radio"
                    name="hf-purpose"
                    value={key}
                    checked={post.purpose === key}
                    onChange={() => update({ purpose: key as Purpose, formula: purposeInfo[key].formula })}
                  />
                  <b>{purposeInfo[key].label}</b>
                  <span>
                    {purposeInfo[key].surface} · {purposeInfo[key].formula}
                  </span>
                  <small>본문 중심: {purposeInfo[key].focus}</small>
                </label>
              ))}
            </fieldset>
            <div className="ledger-fields">
              <div className="field">
                <label htmlFor="hf-formula">제목 공식</label>
                <select id="hf-formula" value={post.formula} disabled={disabled} onChange={(e) => update({ formula: e.target.value as Formula })}>
                  {FORMULAS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <small>{formulaInfo[post.formula]}</small>
              </div>
              <div className="field">
                <label htmlFor="hf-article">기존 글 불러오기 (제목·본문 복사, 원본은 바뀌지 않음)</label>
                <select id="hf-article" value={articlePick} disabled={disabled || !wsReady || articles.length === 0} onChange={(e) => setArticlePick(e.target.value)}>
                  <option value="">{articles.length ? "글 선택" : "불러올 글이 없습니다"}</option>
                  {articles.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title || a.keyword || "제목 없음"}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="button secondary" disabled={disabled || !articlePick} onClick={loadArticle}>
                불러오기
              </button>
            </div>
            {post.purpose === "discover" && <p className="metric-note">발견글에는 상품 광고를 넣지 않습니다. 수익 연결은 전환글에서 합니다.</p>}
          </section>

          <section className="panel keywords-panel" aria-labelledby="hf-keywords">
            <h2 id="hf-keywords">2. 키워드 세트</h2>
            <p className="metric-note">메인 1개 + 세부 3개 이상 + 서브. 여러 개는 쉼표로 구분합니다.</p>
            <div className="ledger-fields">
              <div className="field">
                <label htmlFor="hf-main">메인 키워드</label>
                <input id="hf-main" value={post.mainKeyword} maxLength={200} disabled={disabled} onChange={(e) => update({ mainKeyword: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="hf-details">세부 키워드</label>
                <input id="hf-details" value={post.detailKeywords} maxLength={1000} placeholder="대상, 상황, 도구, 문제" disabled={disabled} onChange={(e) => update({ detailKeywords: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="hf-subs">서브 키워드</label>
                <input id="hf-subs" value={post.subKeywords} maxLength={1000} disabled={disabled} onChange={(e) => update({ subKeywords: e.target.value })} />
              </div>
            </div>
            <ul className="qa-list" aria-live="polite">
              {keywordSetWarnings(post.mainKeyword, post.detailKeywords, post.subKeywords).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>

          <section className="panel keywords-panel" aria-labelledby="hf-title">
            <h2 id="hf-title">3. 제목 점검</h2>
            <div className="field">
              <label htmlFor="hf-title-input">제목 ({charLength(post.title)}자)</label>
              <input id="hf-title-input" value={post.title} maxLength={300} disabled={disabled} onChange={(e) => update({ title: e.target.value })} />
            </div>
            <CheckList items={checkTitle(post)} />
            <div className="hf-manual">
              <label>
                <input type="checkbox" checked={post.titleReadable} disabled={disabled} onChange={(e) => update({ titleReadable: e.target.checked })} /> 읽히는 문장임을 확인했다
              </label>
              <label>
                <input type="checkbox" checked={post.titlePromise} disabled={disabled} onChange={(e) => update({ titlePromise: e.target.checked })} /> 본문이 제목의 약속을 지킨다
              </label>
            </div>
            {titleWarn.length > 0 && (
              <ul className="qa-list">
                {titleWarn.map((w) => (
                  <li key={w} className="blocker">
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="hf-ref">
              <h3 className="team-heading">레퍼런스 기반 AI 제목</h3>
              <p className="metric-note">
                메인·세부 키워드로 네이버 연관 키워드와 네이버 검색결과(블로그)를 가져와 참고합니다. AI 제목은 키워드 세트와 연관 키워드만 씁니다. 결과는 저장하지 않습니다.
              </p>
              <details className="hf-terms">
                <summary>네이버 API 약관 요약</summary>
                <ul>
                  {NAVER_NOTICE.summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <a href={NAVER_TERMS_URL} target="_blank" rel="noopener noreferrer">
                  네이버 개발자센터 이용약관 <ExternalLink size={12} aria-hidden />
                  <span className="sr-only"> (새 탭)</span>
                </a>
              </details>
              <div className="hf-ref-actions">
                <button type="button" className="button secondary" disabled={disabled || !!busy || !hasMain} onClick={runResearch}>
                  <Search size={16} aria-hidden /> {busy === "research" ? "분석 중…" : "레퍼런스 분석"}
                </button>
                <button type="button" className="button primary" disabled={disabled || !!busy || !ref} onClick={generateTitles}>
                  <Sparkles size={16} aria-hidden /> {busy === "titles" ? "생성 중…" : "AI 제목 생성"}
                </button>
              </div>
              {!hasMain && <p className="metric-note">메인 키워드를 먼저 입력하세요.</p>}
              {stale && (
                <p className="metric-note hf-stale" role="status">
                  입력(키워드·목적·공식·썸네일 문구)이 바뀌어 이전 결과를 숨겼습니다. 다시 실행이 필요합니다.
                </p>
              )}
              {hasMain && !ref && !stale && <p className="metric-note">레퍼런스 분석을 먼저 실행하면 AI 제목을 만들 수 있습니다.</p>}
              {aiError && (
                <p role="alert" className="error-banner">
                  {aiError}
                </p>
              )}
              {ref && (
                <div className="hf-ref-result" aria-live="polite">
                  <ul className="hf-sources">
                    {([["연관 키워드 (검색광고 API)", ref.keywords], ["네이버 검색결과 (검색 API)", ref.blogs]] as const).map(([label, s]) => (
                      <li key={label} className={`hf-source ${s.status}`}>
                        {label}: <b>{sourceText[s.status]}</b>
                        {s.message && <small>{s.message}</small>}
                      </li>
                    ))}
                  </ul>

                  <h4 className="hf-ref-heading">연관 키워드 (월간 검색수)</h4>
                  <p className="metric-note hf-notice">{NAVER_NOTICE.keywords}</p>
                  {ref.keywords.items.length === 0 ? (
                    <p className="metric-note">표시할 연관 키워드가 없습니다.</p>
                  ) : (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">키워드</th>
                            <th scope="col">PC</th>
                            <th scope="col">모바일</th>
                            <th scope="col">경쟁도</th>
                            <th scope="col">추가</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ref.keywords.items.map((k) => (
                            <tr key={k.keyword}>
                              <th scope="row">{k.keyword}</th>
                              <td>{formatVolume(k.pc)}</td>
                              <td>{formatVolume(k.mobile)}</td>
                              <td>{k.competition || "N/A"}</td>
                              <td>
                                <span className="hf-add">
                                  <button type="button" className="button secondary" disabled={disabled} aria-label={`‘${k.keyword}’ 세부 키워드에 추가`} onClick={() => addKeyword("detailKeywords", k.keyword)}>
                                    + 세부
                                  </button>
                                  <button type="button" className="button secondary" disabled={disabled} aria-label={`‘${k.keyword}’ 서브 키워드에 추가`} onClick={() => addKeyword("subKeywords", k.keyword)}>
                                    + 서브
                                  </button>
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <h4 className="hf-ref-heading">네이버 검색결과 (검색 API 관련도순 10건, 실제 노출 순위 아님)</h4>
                  <p className="metric-note hf-notice">{NAVER_NOTICE.blogs}</p>
                  {ref.blogs.items.length === 0 ? (
                    <p className="metric-note">표시할 글이 없습니다.</p>
                  ) : (
                    <ol className="hf-ref-titles">
                      {ref.blogs.items.map((b, i) => (
                        <li key={`${i}-${b.title}`}>
                          {b.link ? (
                            <a href={b.link} target="_blank" rel="noopener noreferrer">
                              {b.title || "제목 없음"} <ExternalLink size={12} aria-hidden />
                              <span className="sr-only"> (새 탭)</span>
                            </a>
                          ) : (
                            <span>{b.title || "제목 없음"}</span>
                          )}
                          <small>
                            {b.blogger || "블로그명 없음"}
                            {b.postdate && ` · ${b.postdate}`}
                          </small>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {picks && (
                <div className="hf-candidates" aria-live="polite">
                  <h4 className="hf-ref-heading">AI 제목 후보</h4>
                  <p className="metric-note">{picks.note}</p>
                  <ol>
                    {picks.items.map((c, i) => (
                      <li key={`${i}-${c.title}`} className="hf-candidate">
                        <div className="hf-candidate-head">
                          <b>{c.title}</b>
                          <button type="button" className="button secondary" disabled={disabled || post.title === c.title} onClick={() => update({ title: c.title })}>
                            {post.title === c.title ? "적용됨" : "제목에 적용"}
                          </button>
                        </div>
                        <CheckList items={c.checks} />
                        {c.warnings.length > 0 && (
                          <ul className="qa-list">
                            {c.warnings.map((w) => (
                              <li key={w} className="blocker">
                                {w}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </section>

          <section className="panel keywords-panel" aria-labelledby="hf-thumb">
            <h2 id="hf-thumb">4. 썸네일</h2>
            <div className="ledger-fields">
              <div className="field">
                <label htmlFor="hf-thumb-text">썸네일 문구</label>
                <input id="hf-thumb-text" value={post.thumbnailText} maxLength={200} disabled={disabled} onChange={(e) => update({ thumbnailText: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="hf-thumb-type">유형</label>
                <select id="hf-thumb-type" value={post.thumbnailType} disabled={disabled} onChange={(e) => update({ thumbnailType: e.target.value as ThumbnailType | "" })}>
                  <option value="">선택 안 함</option>
                  {THUMBNAIL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {thumbnailTypeLabels[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <fieldset className="hf-manual" disabled={disabled}>
              <legend className="metric-note">직접 확인 ({post.thumbnailChecks.filter(Boolean).length}/{THUMBNAIL_CHECKS.length})</legend>
              {THUMBNAIL_CHECKS.map((label, i) => (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={post.thumbnailChecks[i]}
                    onChange={(e) => update({ thumbnailChecks: post.thumbnailChecks.map((c, j) => (j === i ? e.target.checked : c)) })}
                  />{" "}
                  {label}
                </label>
              ))}
            </fieldset>
          </section>

          <section className="panel keywords-panel" aria-labelledby="hf-body">
            <h2 id="hf-body">5. 본문 점검</h2>
            <div className="field hf-body-field">
              <label htmlFor="hf-body-input">본문</label>
              <textarea id="hf-body-input" value={post.body} maxLength={200000} disabled={disabled} onChange={(e) => update({ body: e.target.value })} />
              <small>이미지는 ![설명](주소), &lt;img&gt;, [이미지] 표시로 인식합니다.</small>
            </div>
            <CheckList items={checkBody(post)} />
          </section>

          <section className="panel keywords-panel" aria-labelledby="hf-record">
            <h2 id="hf-record">6. 발행 후 기록</h2>
            <p className="metric-note">네이버 통계에서 직접 확인한 값만 입력하세요. 비워 두면 0이 아니라 N/A입니다.</p>
            <div className="ledger-fields">
              <div className="field">
                <label htmlFor="hf-published">발행일</label>
                <input id="hf-published" type="date" value={post.record.publishedOn} disabled={disabled} onChange={(e) => updateRecord({ publishedOn: e.target.value })} />
              </div>
              <CountField id="hf-home" label="홈판 조회수" value={post.record.homeViews} onChange={(n) => updateRecord({ homeViews: n })} />
              <CountField id="hf-search" label="검색 조회수" value={post.record.searchViews} onChange={(n) => updateRecord({ searchViews: n })} />
              <CountField id="hf-other" label="기타 조회수" value={post.record.otherViews} onChange={(n) => updateRecord({ otherViews: n })} />
              <CountField id="hf-comments" label="댓글 수" value={post.record.comments} onChange={(n) => updateRecord({ comments: n })} />
              <CountField id="hf-neighbors" label="이웃 증가" value={post.record.neighbors} onChange={(n) => updateRecord({ neighbors: n })} />
              <div className="field">
                <label htmlFor="hf-clip">클립 연계</label>
                <select id="hf-clip" value={post.record.clipLinked ? "yes" : "no"} disabled={disabled} onChange={(e) => updateRecord({ clipLinked: e.target.value === "yes" })}>
                  <option value="no">안 함</option>
                  <option value="yes">함</option>
                </select>
              </div>
              <CountField id="hf-clip-views" label="클립 조회수" value={post.record.clipViews} onChange={(n) => updateRecord({ clipViews: n })} />
              <div className="field wide">
                <label htmlFor="hf-memo">메모 (좋았던 점·개선할 점)</label>
                <input id="hf-memo" value={post.record.memo} maxLength={2000} disabled={disabled} onChange={(e) => updateRecord({ memo: e.target.value })} />
              </div>
            </div>
            <p className="metric-note">합계 조회수: {formatStat(totalViews(post.record))}
              {isPartialViews(post.record) && " (일부 지면 미입력: 홈판·검색·기타를 모두 입력해야 합계·평균에 넣습니다)"}
            </p>
          </section>
        </>
      )}

      <section className="panel keywords-panel" aria-labelledby="hf-summary">
        <h2 id="hf-summary">성과 비교</h2>
        <p className="metric-note">2주마다 썸네일 유형·제목 공식별로 비교해 다음 글의 비율과 공식을 정하세요. 홈판·검색·기타 조회수가 모두 입력된 글만 평균에 넣습니다.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">구분</th>
                <th scope="col">글 수</th>
                <th scope="col">기록 있음</th>
                <th scope="col">평균 조회수</th>
                <th scope="col">평균 홈판 조회수</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...THUMBNAIL_TYPES.map((t) => [`썸네일 ${thumbnailTypeLabels[t]}`, summary.byThumbnail[t]] as const),
                ...FORMULAS.map((f) => [`공식 ${f}`, summary.byFormula[f]] as const),
              ].map(([label, s]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{s.posts}</td>
                  <td>{s.measured}</td>
                  <td>{formatStat(s.avgViews, 1)}</td>
                  <td>{formatStat(s.avgHomeViews, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="team-heading">글 목적 비율 (목표 5 : 3 : 2)</h3>
        <ul className="qa-list">
          {PURPOSES.map((p) => (
            <li key={p}>
              {purposeInfo[p].label}: {summary.purposeCount[p]}개 · {formatShare(summary.purposeShare[p])} (목표 {formatShare(PURPOSE_TARGET[p])})
            </li>
          ))}
        </ul>
      </section>

      {deleting && (
        <ConfirmDialog
          title="이 점검 기록을 삭제할까요?"
          description={`‘${deleting.title.trim() || "제목 없음"}’ 점검 기록이 이 브라우저에서 삭제돼요. 되돌릴 수 없어요. 불러온 원본 글은 그대로입니다.`}
          confirmLabel="삭제하기"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            remove(target);
          }}
        />
      )}
    </>
  );
}
