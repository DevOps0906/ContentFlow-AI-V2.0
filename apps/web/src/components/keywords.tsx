"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Copy, FilePlus2, FileUp, Info, ListChecks, Trash2 } from "lucide-react";
import {
  ideaFromKeyword,
  importKeywords,
  KEYWORD_STORAGE_KEY,
  linkedArticles,
  parseKeywords,
  type ImportResult,
  type Keyword,
} from "@/lib/keywords";
import { generateTitles, type TitleCandidate } from "@/lib/titles";
import { restoreRemoved } from "@/lib/feedback";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";
import { useFeedback } from "./feedback";
import { RowMenu } from "./row-menu";
import { useWorkspace } from "./workspace";
import { StatusBadge } from "./status-badge";
import { useBlogs } from "./blog-filter";
import { blogOptionLabel, selectableBlogs } from "@/lib/blogs";

export function Keywords() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportResult | null>(null);
  const [selected, setSelected] = useState("");
  const [selectedKeyword, setSelectedKeyword] = useState<Keyword | null>(null);
  const [titles, setTitles] = useState<TitleCandidate[]>([]);
  const [message, setMessage] = useState("");
  const { toast, snackbar, current } = useFeedback();
  const removedBatch = useRef<{ noticeId: number; items: { item: Keyword; index: number }[] } | null>(null);
  const [undoError, setUndoError] = useState("");
  const [deleting, setDeleting] = useState<Keyword | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { articles, save, mode, ready: wsReady } = useWorkspace();
  const [localCount, setLocalCount] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const account = mode === "account";
  const { blogs, canManage: canLinkBlog } = useBlogs(account);

  const readLocal = () => parseKeywords(localStorage.getItem(KEYWORD_STORAGE_KEY));

  async function loadAccount() {
    const res = await fetch("/api/keywords");
    const data = (await res.json().catch(() => null)) as { keywords?: Keyword[]; error?: string } | null;
    if (!res.ok || !data?.keywords) throw new Error(data?.error ?? "키워드를 불러오지 못했습니다.");
    setKeywords(data.keywords);
  }
  async function callApi(url: string, init: RequestInit) {
    const res = await fetch(url, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error((data?.error as string) ?? `요청에 실패했습니다(${res.status}).`);
    return data ?? {};
  }

  useEffect(() => {
    if (!wsReady) return;
    (async () => {
      if (mode === "account") {
        try {
          await loadAccount();
          try {
            setLocalCount(readLocal().length);
          } catch {
            setLocalCount(0);
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "키워드를 불러오지 못했습니다.");
        }
      } else {
        try {
          setKeywords(readLocal());
        } catch {
          setError("저장된 키워드를 읽을 수 없습니다. 원본 데이터는 덮어쓰지 않았습니다.");
        }
      }
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsReady, mode]);

  /** Copies the browser-stored keywords into the account. The browser copy is kept. */
  async function importLocalKeywords() {
    setMessage("");
    try {
      const local = readLocal();
      let added = 0;
      let duplicates = 0;
      for (let i = 0; i < local.length; i += 500) {
        const r = await callApi("/api/keywords", {
          method: "POST",
          body: JSON.stringify({ keywords: local.slice(i, i + 500) }),
        });
        added += Number(r.added ?? 0);
        duplicates += Number(r.duplicates ?? 0);
      }
      await loadAccount();
      toast(`브라우저 키워드 ${added}개를 계정으로 가져왔어요(이미 있어서 건너뜀 ${duplicates}개).`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "가져오지 못했습니다.");
    }
  }
  /** Account mode deletes through the API (ids cannot be restored), local mode can undo. */
  function askRemove(k: Keyword) {
    if (account) setDeleting(k);
    else removeKeyword(k);
  }
  async function removeKeyword(k: Keyword) {
    setMessage("");
    const index = keywords.findIndex((x) => x.id === k.id);
    try {
      if (account) {
        await callApi(`/api/keywords/${k.id}`, { method: "DELETE" });
        setKeywords((list) => list.filter((x) => x.id !== k.id));
        toast("키워드를 삭제했어요.");
      } else {
        if (!persist(keywords.filter((x) => x.id !== k.id))) return;
        setUndoError("");
        // Deletions while the previous undo snackbar is still showing share one snackbar.
        const prev = removedBatch.current;
        const items =
          prev && current()?.id === prev.noticeId ? [...prev.items, { item: k, index }] : [{ item: k, index }];
        snackbar(items.length > 1 ? `키워드 ${items.length}개를 삭제했어요.` : "키워드를 삭제했어요.", {
          label: "실행 취소",
          onAction: () => {
            // Re-read the stored list so edits made meanwhile are not lost.
            try {
              const stored = readLocal();
              const missing = items.filter((r) => !stored.some((x) => x.id === r.item.id));
              if (!persist(restoreRemoved(stored, missing))) throw new Error("저장 공간이 부족하거나 사용할 수 없습니다.");
              toast("되돌렸어요.");
            } catch (e) {
              setUndoError(`되돌리지 못했어요. ${e instanceof Error ? e.message : "저장된 키워드를 읽을 수 없습니다."}`);
            }
          },
        });
        removedBatch.current = { noticeId: current()?.id ?? -1, items };
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "삭제하지 못했습니다.");
    }
  }

  /** On failure the select keeps showing the stored account. */
  async function linkBlog(id: string, blogId: string | null) {
    setMessage("");
    try {
      const r = await callApi(`/api/keywords/${id}`, { method: "PATCH", body: JSON.stringify({ blogId }) });
      setKeywords((list) => list.map((x) => (x.id === id ? (r.keyword as Keyword) : x)));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "블로그 계정을 바꾸지 못했습니다.");
    }
  }

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
      if (mode === "account") {
        // The database decides duplicates, so its counts are the ones to report.
        const fresh = result.keywords.slice(keywords.length);
        let added = 0;
        for (let i = 0; i < fresh.length; i += 500) {
          const r = await callApi("/api/keywords", {
            method: "POST",
            body: JSON.stringify({ keywords: fresh.slice(i, i + 500) }),
          });
          added += Number(r.added ?? 0);
        }
        await loadAccount();
        setReport({
          ...result,
          added,
          duplicates: result.duplicates + (fresh.length - added),
        });
      } else if (persist(result.keywords)) setReport(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "가져오기에 실패했습니다.");
    } finally {
      if (file.current) file.current.value = "";
    }
  }

  function makeTitles(keyword: Keyword) {
    const phrase = keyword.phrase;
    setSelectedKeyword(keyword);
    setSelected(phrase);
    setMessage("");
    try {
      setTitles(generateTitles(phrase));
    } catch (e) {
      setTitles([]);
      setMessage(e instanceof Error ? e.message : "제목을 만들 수 없습니다.");
    }
  }

  /** Creates an article at the `idea` stage; the editor takes it from there. */
  async function createIdea(keyword: Pick<Keyword, "id" | "phrase" | "blogId">, title?: string) {
    if (creating) return;
    setCreating(keyword.id + (title ?? ""));
    setMessage("");
    setCreated(null);
    try {
      const stored = await save(ideaFromKeyword(keyword.phrase, { title, keywordId: keyword.id, blogId: keyword.blogId }));
      setCreated({ id: stored.id, title: stored.title || stored.keyword });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "글을 만들지 못했습니다.");
    } finally {
      setCreating(null);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("제목을 복사했어요.");
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
          <b>
            {mode === "account"
              ? "키워드는 내 계정(데이터베이스)에 저장돼요."
              : "키워드는 이 브라우저에만 저장돼요."}
          </b>{" "}
          검색량·경쟁도는 외부 도구에서 가져온 값이 없으면 표시하지 않습니다. 제목 후보는 AI가 아니라 고정
          규칙으로 만든 초안이에요. 키워드에서 만든 글은 {mode === "account" ? "내 계정" : "이 브라우저"}에
          &lsquo;아이디어&rsquo; 단계로 저장됩니다.
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {undoError && (
        <p role="alert" className="error-banner">
          {undoError}
        </p>
      )}
      <section className="panel keywords-panel">
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
        {mode === "account" && localCount > 0 && (
          <button className="button secondary" onClick={importLocalKeywords} style={{ marginLeft: 8 }}>
            브라우저 키워드 {localCount}개 가져오기
          </button>
        )}
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

      {created && (
        <div role="status" className="success-message keywords-created">
          &lsquo;{created.title}&rsquo; 글을 아이디어 단계로 만들었어요.{" "}
          <Link href={`/content/${created.id}`}>편집기에서 열기</Link>
        </div>
      )}
      <section className="panel keywords-panel">
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
                    {account && <th scope="col">블로그 계정</th>}
                    <th scope="col">연결된 글</th>
                    <th scope="col">
                      <span className="sr-only">작업</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...keywords]
                    .sort((a, b) => a.priority - b.priority)
                    .slice(0, 200)
                    .map((k) => {
                      const linked = linkedArticles(k, articles);
                      return (
                      <tr key={k.id} aria-current={selected === k.phrase ? "true" : undefined}>
                        <td>
                          {k.phrase}
                          {selected === k.phrase && <small> · 제목 후보 보는 중</small>}
                        </td>
                        <td>{k.intent || "—"}</td>
                        <td>{k.priority}</td>
                        <td>{k.note || "—"}</td>
                        {account && (
                          <td>
                            {canLinkBlog ? (
                              <select
                                aria-label={`${k.phrase} 블로그 계정`}
                                value={k.blogId ?? ""}
                                onChange={(e) => linkBlog(k.id, e.target.value || null)}
                              >
                                <option value="">미분류</option>
                                {selectableBlogs(blogs, k.blogId).map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {blogOptionLabel(b)}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              (() => {
                                const blog = blogs.find((b) => b.id === k.blogId);
                                return blog ? blogOptionLabel(blog) : "미분류";
                              })()
                            )}
                          </td>
                        )}
                        <td>
                          {linked.length === 0 ? (
                            "—"
                          ) : (
                            <Link href={`/content/${linked[0].id}`}>
                              <StatusBadge state={linked[0].status} />
                              {linked.length > 1 && <small> 외 {linked.length - 1}</small>}
                            </Link>
                          )}
                        </td>
                        <td>
                          <div className="table-actions">
                          <button
                            className="button secondary"
                            disabled={!!creating || !ready}
                            onClick={() => createIdea(k)}
                            aria-label={`${k.phrase} 글 만들기`}
                          >
                            <FilePlus2 size={14} /> {linked.length ? "글 추가" : "글 만들기"}
                          </button>
                          <RowMenu
                            label={`${k.phrase} 작업 더보기`}
                            items={[
                              { label: "제목 후보", icon: <ListChecks size={15} />, onSelect: () => makeTitles(k) },
                              { label: "삭제", icon: <Trash2 size={15} />, danger: true, onSelect: () => askRemove(k) },
                            ]}
                          />
                          </div>
                        </td>
                      </tr>
                      );
                    })}
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
                  disabled={!!creating}
                  onClick={() => selectedKeyword && createIdea(selectedKeyword, t.title)}
                >
                  <FilePlus2 size={14} /> 이 제목으로 글 만들기
                </button>
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
      {deleting && (
        <ConfirmDialog
          title="이 키워드를 삭제할까요?"
          description={`‘${deleting.phrase}’ 키워드가 계정에서 삭제돼요. 계정 키워드는 같은 항목으로 되돌릴 수 없어요.`}
          confirmLabel="삭제하기"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const k = deleting;
            setDeleting(null);
            void removeKeyword(k);
          }}
        />
      )}
    </>
  );
}
