"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ChartNoAxesCombined, FilePlus2, FileUp, Info, Trash2 } from "lucide-react";
import { ALL_BLOGS, blogName, blogOptionLabel, selectableBlogs, type Blog, type BlogFilterValue } from "@/lib/blogs";
import { localDay } from "@/lib/costs";
import type { Article } from "@/lib/content";
import { ideaFromKeyword } from "@/lib/keywords";
import { revenueSendNotice, sendRevenueChunks } from "@/lib/revenue";
import {
  ALL_CATEGORIES,
  analyzeTrends,
  categoryLabel,
  formatCount,
  formatGrowth,
  formatScore,
  ideaBlogId,
  importTrends,
  MAX_TRENDS_PER_REQUEST,
  TREND_PERIODS,
  trendBars,
  trendCategories,
  trendFromForm,
  trendInsights,
  type KeywordTrend,
  type KeywordTrendInput,
  type ScoredTrend,
  type TrendBar,
  type TrendImport,
  type TrendPeriod,
} from "@/lib/trends";
import { ConfirmDialog } from "./dialog";
import { BlogFilter, useBlogs } from "./blog-filter";
import { PageHeading } from "./shell";
import { useWorkspace } from "./workspace";

const PAGE = 100;
const emptyMetrics = { keyword: "", category: "", monthlySearches: "", growthPct: "", documentCount: "" };

const accountName = (blogs: Blog[], blogId: string | null) => {
  if (!blogId) return "미분류";
  const blog = blogs.find((b) => b.id === blogId);
  return blog ? blogName(blog) : "계정 정보 없음";
};

export function Trends() {
  const { mode, ready, save } = useWorkspace();
  return <TrendsView account={mode === "account"} ready={ready && mode !== null} save={save} />;
}

export function TrendsView({ account, ready, save }: { account: boolean; ready: boolean; save: (article: Article) => Promise<Article> }) {
  return (
    <>
      <PageHeading
        eyebrow="BLOG KEYWORD TRENDS"
        title="트렌드 분석"
        description="외부 도구에서 확인한 키워드 값을 기록하고, 블로그별로 쓸 만한 키워드를 비교합니다."
      />
      {!ready ? (
        <p className="metric-note">불러오는 중…</p>
      ) : account ? (
        <TrendBoard save={save} />
      ) : (
        <section className="panel analytics-empty">
          <span className="empty-icon">
            <ChartNoAxesCombined size={27} />
          </span>
          <h2>트렌드 분석은 계정 모드에서 사용 가능합니다.</h2>
          <p>블로그 계정별 키워드 측정값은 로그인한 워크스페이스에만 저장합니다.</p>
        </section>
      )}
    </>
  );
}

function TrendBoard({ save }: { save: (article: Article) => Promise<Article> }) {
  const [rows, setRows] = useState<KeywordTrend[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [blog, setBlog] = useState<BlogFilterValue>(ALL_BLOGS);
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [period, setPeriod] = useState<TrendPeriod>("all");
  const [limit, setLimit] = useState(PAGE);
  const [targetBlog, setTargetBlog] = useState("");
  const [source, setSource] = useState("");
  const [measuredOn, setMeasuredOn] = useState(() => localDay());
  const [form, setForm] = useState(emptyMetrics);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<TrendImport | null>(null);
  const [removing, setRemoving] = useState<ScoredTrend | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { blogs } = useBlogs(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/trends", { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { rows?: KeywordTrend[]; canWrite?: boolean; error?: string } | null;
    if (!res.ok || !data?.rows) throw new Error(data?.error ?? "트렌드 데이터를 불러오지 못했습니다.");
    setRows(data.rows);
    setCanWrite(data.canWrite === true);
    setError("");
  }, []);
  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "트렌드 데이터를 불러오지 못했습니다."))
      .finally(() => setLoaded(true));
  }, [load]);

  /** The database decides what is a duplicate, so its counts are the ones to report. */
  function send(list: KeywordTrendInput[]) {
    return sendRevenueChunks(
      list,
      async (chunk) => {
        const res = await fetch("/api/trends", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: chunk }),
        });
        const data = (await res.json().catch(() => null)) as { added?: number; duplicates?: number; error?: string } | null;
        if (!res.ok) throw new Error(data?.error ?? `요청에 실패했습니다(${res.status}).`);
        return data ?? {};
      },
      load,
      MAX_TRENDS_PER_REQUEST,
    );
  }

  async function onFile(f: File | undefined) {
    setMessage("");
    setReport(null);
    if (!f || busy) return;
    setBusy(true);
    try {
      const result = importTrends(await f.text(), rows, { blogId: targetBlog || null, source, measuredOn });
      const sent = await send(result.rows);
      setMessage(revenueSendNotice(sent));
      if (!sent.failure) setReport({ ...result, added: sent.added, duplicates: result.duplicates + sent.duplicates });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "가져오기에 실패했습니다.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function addRow(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMessage("");
    setReport(null);
    setBusy(true);
    try {
      const sent = await send([trendFromForm({ ...form, blogId: targetBlog || null, source, measuredOn })]);
      const notice = revenueSendNotice(sent);
      if (sent.failure) {
        setMessage(notice);
        return;
      }
      if (sent.added > 0) setForm(emptyMetrics);
      setMessage(
        [sent.added > 0 ? "저장했어요." : "같은 블로그·키워드·카테고리·출처·측정일의 행이 이미 있어 기존 값을 유지했어요.", notice].filter(Boolean).join(" "),
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: ScoredTrend) {
    setRemoving(null);
    setMessage("");
    try {
      const res = await fetch(`/api/trends?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "삭제하지 못했습니다.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "삭제하지 못했습니다.");
      return;
    }
    await load().catch(() => setMessage("삭제했지만 목록을 새로 불러오지 못했어요. 페이지를 새로고침해 주세요."));
  }

  /** The same idea-stage article the keyword lab creates. */
  async function createIdea(row: ScoredTrend) {
    if (creating) return;
    setCreating(row.id);
    setMessage("");
    setCreated(null);
    try {
      const stored = await save(ideaFromKeyword(row.keyword, { blogId: ideaBlogId(row.blogId, blogs) }));
      setCreated({ id: stored.id, title: stored.title || stored.keyword });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "글을 만들지 못했습니다.");
    } finally {
      setCreating(null);
    }
  }

  const today = localDay();
  const shown = analyzeTrends(rows, { blog, category, period, today });
  const categories = trendCategories(rows, blog);
  const set = (key: keyof typeof emptyMetrics) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const changeBlog = (value: BlogFilterValue) => {
    setBlog(value);
    setCategory(ALL_CATEGORIES);
    setLimit(PAGE);
  };

  return (
    <>
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>기회 점수의 가중치는 검증되지 않은 가설입니다.</b> 기회 점수 = 0.4×검색 증가 + 0.3×검색 수요 + 0.3×(100−문서 경쟁)이며, 같은 블로그·카테고리·출처
          안에서만 0~100으로 맞춰 계산합니다. 값은 직접 입력하거나 CSV로 가져온 것만 쓰고, 도구 간 값은 합산하거나 환산하지 않습니다. 세 입력값 중 하나라도 없으면 점수는 N/A입니다.
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {created && (
        <div role="status" className="success-message keywords-created">
          &lsquo;{created.title}&rsquo; 글을 아이디어 단계로 만들었어요. <Link href={`/content/${created.id}`}>편집기에서 열기</Link>
        </div>
      )}
      <section className="panel keywords-panel trend-filters" aria-label="트렌드 필터">
        <BlogFilter account value={blog} onChange={changeBlog} />
        <div className="field">
          <label htmlFor="trend-category">카테고리</label>
          <select
            id="trend-category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setLimit(PAGE);
            }}
          >
            <option value={ALL_CATEGORIES}>전체</option>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="trend-period">기간</label>
          <select
            id="trend-period"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as TrendPeriod);
              setLimit(PAGE);
            }}
          >
            {TREND_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <div className="stats-grid trend-insights">
        {trendInsights(shown).map((m) => (
          <article className="stat-card" key={m.label}>
            <div className="stat-top">{m.label}</div>
            <div className="stat-value">{m.value}</div>
            <p>{m.note}</p>
          </article>
        ))}
      </div>

      <section className="panel keywords-panel">
        <h2>키워드 순위 ({shown.length.toLocaleString("ko-KR")}개)</h2>
        {!loaded ? (
          <p className="metric-note">불러오는 중…</p>
        ) : shown.length === 0 ? (
          <p className="metric-note">{rows.length === 0 ? "아직 기록한 값이 없습니다. 아래에서 CSV를 가져오거나 직접 입력해 주세요." : "이 필터에 해당하는 값이 없습니다."}</p>
        ) : (
          <>
            <TrendTable
              rows={shown.slice(0, limit)}
              blogs={blogs}
              canWrite={canWrite}
              creating={creating}
              onCreate={createIdea}
              onRemove={setRemoving}
            />
            {shown.length > limit && (
              <button className="button secondary trend-more" onClick={() => setLimit((n) => n + PAGE)}>
                더 보기 ({(shown.length - limit).toLocaleString("ko-KR")}개 남음)
              </button>
            )}
            <p className="metric-note">
              순위는 같은 블로그·카테고리·출처 안에서만 매깁니다. 비교 대상이 1개뿐이거나 값이 모두 같은 입력값은 중간값 50으로 계산합니다. 같은 키워드를 여러 번 측정했으면 기간 안의 최신
              값만 씁니다.
            </p>
          </>
        )}
      </section>

      <section className="panel keywords-panel">
        <h2>카테고리별 평균 기회 점수</h2>
        <CategoryBars bars={trendBars(shown)} blogs={blogs} showBlog={blog === ALL_BLOGS} />
      </section>

      <section className="panel keywords-panel">
        <h2>값 기록하기</h2>
        <p className="metric-note">
          출처에는 값을 확인한 도구 이름을 적어 주세요. 이 화면은 외부 도구에 연결되어 있지 않습니다. 비워 둔 숫자는 0이 아니라 N/A로 저장합니다.
        </p>
        <div className="ledger-fields">
          <div className="field">
            <label htmlFor="trend-blog">블로그 계정</label>
            <select id="trend-blog" value={targetBlog} onChange={(e) => setTargetBlog(e.target.value)}>
              <option value="">미분류</option>
              {selectableBlogs(blogs).map((b) => (
                <option key={b.id} value={b.id}>
                  {blogOptionLabel(b)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="trend-source">출처</label>
            <input id="trend-source" value={source} maxLength={40} placeholder="값을 확인한 도구 이름" onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="trend-date">측정일</label>
            <input id="trend-date" type="date" value={measuredOn} max={today} onChange={(e) => setMeasuredOn(e.target.value)} />
          </div>
        </div>

        <h3 className="team-heading">CSV 가져오기</h3>
        <p className="metric-note">
          필수 열은 키워드(keyword)이고, 월간 검색량·검색 증가율·문서 수 중 하나 이상이 필요해요. 카테고리·출처·측정일 열은 있으면 위 값 대신 씁니다. 같은 블로그·키워드·카테고리·출처·측정일의 행은
          다시 가져와도 건너뛰고 기존 값을 유지합니다. 최대 2MB · 20,000행.
        </p>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="트렌드 CSV 파일 선택"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button className="button primary" disabled={!loaded || !canWrite || busy} onClick={() => file.current?.click()}>
          <FileUp size={16} /> CSV 파일 선택
        </button>
        {report && (
          <div role="status" className="success-message">
            {report.added}행 추가 · 중복 {report.duplicates}행 건너뜀
            {report.conflicts > 0 && ` · 값이 달라 건너뜀 ${report.conflicts}행(기존 값 유지)`} · 오류 {report.invalid.length}행
            {report.invalid.length > 0 && (
              <ul>
                {report.invalid.slice(0, 10).map((i) => (
                  <li key={i.line}>
                    {i.line}행: {i.reason}
                  </li>
                ))}
                {report.invalid.length > 10 && <li>외 {report.invalid.length - 10}건</li>}
              </ul>
            )}
          </div>
        )}

        <h3 className="team-heading">직접 입력</h3>
        <form onSubmit={addRow}>
          <div className="ledger-fields">
            <div className="field">
              <label htmlFor="trend-keyword">키워드</label>
              <input id="trend-keyword" required value={form.keyword} maxLength={120} onChange={set("keyword")} />
            </div>
            <div className="field">
              <label htmlFor="trend-form-category">카테고리</label>
              <input id="trend-form-category" value={form.category} maxLength={40} onChange={set("category")} />
            </div>
            <div className="field">
              <label htmlFor="trend-volume">월간 검색량</label>
              <input id="trend-volume" inputMode="numeric" value={form.monthlySearches} onChange={set("monthlySearches")} />
            </div>
            <div className="field">
              <label htmlFor="trend-growth">검색 증가율(%)</label>
              <input id="trend-growth" inputMode="decimal" value={form.growthPct} onChange={set("growthPct")} />
            </div>
            <div className="field">
              <label htmlFor="trend-documents">문서 수</label>
              <input id="trend-documents" inputMode="numeric" value={form.documentCount} onChange={set("documentCount")} />
            </div>
            <button className="button primary" disabled={!loaded || !canWrite || busy}>
              저장
            </button>
          </div>
        </form>
        {loaded && !canWrite && !error && <p className="metric-note">트렌드 값은 소유자·관리자·편집자만 입력하거나 삭제할 수 있어요. 지금은 볼 수만 있어요.</p>}
        {message && (
          <p role="alert" className="metric-note">
            {message}
          </p>
        )}
      </section>

      {removing && (
        <ConfirmDialog
          title={`'${removing.keyword}' 측정값을 삭제할까요?`}
          description={`${removing.source} · ${removing.measuredOn} 측정값 1행이 삭제됩니다. 같은 키워드의 이전 측정값이 있으면 그 값이 다시 표시됩니다.`}
          danger
          confirmLabel="삭제"
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </>
  );
}

/** A table from 768px up; below that each row is laid out as a card (see .trend-table in globals.css). */
export function TrendTable({
  rows,
  blogs,
  canWrite,
  creating,
  onCreate,
  onRemove,
}: {
  rows: ScoredTrend[];
  blogs: Blog[];
  canWrite: boolean;
  creating: string | null;
  onCreate: (row: ScoredTrend) => void;
  onRemove: (row: ScoredTrend) => void;
}) {
  return (
    <div className="table-scroll trend-scroll">
      <table className="trend-table">
        <thead>
          <tr>
            <th scope="col">그룹 내 순위</th>
            <th scope="col">키워드</th>
            <th scope="col">블로그 계정</th>
            <th scope="col">카테고리</th>
            <th scope="col">월간 검색량</th>
            <th scope="col">검색 증가율</th>
            <th scope="col">문서 수</th>
            <th scope="col">기회 점수</th>
            <th scope="col">출처 · 측정일</th>
            {canWrite && (
              <th scope="col">
                <span className="sr-only">작업</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td data-label="그룹 내 순위">{t.rank ?? "N/A"}</td>
              <td data-label="키워드" className="trend-keyword">
                {t.keyword}
              </td>
              <td data-label="블로그 계정">{accountName(blogs, t.blogId)}</td>
              <td data-label="카테고리">{categoryLabel(t.category)}</td>
              <td data-label="월간 검색량">{formatCount(t.monthlySearches)}</td>
              <td data-label="검색 증가율">{formatGrowth(t.growthPct)}</td>
              <td data-label="문서 수">{formatCount(t.documentCount)}</td>
              <td data-label="기회 점수" title={t.missing.length ? `없는 값: ${t.missing.join(", ")}` : undefined}>
                <b>{formatScore(t.score)}</b>
              </td>
              <td data-label="출처 · 측정일">
                {t.source} · {t.measuredOn}
              </td>
              {canWrite && (
                <td data-label="작업" className="trend-actions">
                  <div className="table-actions">
                    <button className="button secondary" disabled={creating !== null} onClick={() => onCreate(t)}>
                      <FilePlus2 size={15} /> 글 만들기
                    </button>
                    <button className="icon-button" aria-label={`${t.keyword} 측정값 삭제`} title="삭제" onClick={() => onRemove(t)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CategoryBars({ bars, blogs, showBlog }: { bars: TrendBar[]; blogs: Blog[]; showBlog: boolean }) {
  if (bars.length === 0) return <p className="metric-note">표시할 카테고리가 없습니다.</p>;
  return (
    <>
      <ul className="trend-bars">
        {bars.map((b) => (
          <li key={b.group}>
            <span className="trend-bar-label">
              {showBlog && `${accountName(blogs, b.blogId)} · `}
              {categoryLabel(b.category)} · {b.source}
            </span>
            <span className="trend-bar-track" aria-hidden="true">
              {b.average !== null && <span style={{ width: `${b.average}%` }} />}
            </span>
            <span className="trend-bar-value">
              {formatScore(b.average)}
              <small>
                {" "}
                ({b.scored}/{b.total}개)
              </small>
            </span>
          </li>
        ))}
      </ul>
      <p className="metric-note">괄호는 점수를 계산한 키워드 수 / 전체 키워드 수입니다. 막대끼리의 차이는 서로 다른 기준에서 계산된 값이므로 참고로만 보세요.</p>
    </>
  );
}
