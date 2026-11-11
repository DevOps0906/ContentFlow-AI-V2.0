"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ChartNoAxesCombined, ExternalLink, FileUp, Info, Trash2 } from "lucide-react";
import { blogName, blogOptionLabel, selectableBlogs, type Blog, type BlogFilterValue } from "@/lib/blogs";
import {
  filterMetrics,
  formatMetricValue,
  importGsc,
  INDEX_METRIC,
  indexSeries,
  MAX_METRICS_PER_REQUEST,
  metricRowKey,
  METRIC_TOOLS,
  metricFromForm,
  TOOL_INFO,
  toolGroupsFor,
  toolSummary,
  type IndexSeries,
  type MetricImport,
  type MetricInput,
  type MetricSnapshot,
  type MetricTool,
} from "@/lib/blog-metrics";
import { localDay } from "@/lib/costs";
import { revenueSendNotice, sendRevenueChunks } from "@/lib/revenue";
import { useBlogs } from "./blog-filter";
import { ConfirmDialog } from "./dialog";

const PAGE = 100;
const emptyForm = { tool: "bseupi" as MetricTool, metric: "", value: "", unit: "", memo: "" };
const scopeLabel = { site: "사이트", query: "검색어", page: "페이지" } as const;

const accountName = (blogs: Blog[], blogId: string | null) => {
  if (!blogId) return "미분류";
  const blog = blogs.find((b) => b.id === blogId);
  return blog ? blogName(blog) : "계정 정보 없음";
};

/** Per-tool records of the blog accounts on /analytics. Account mode only. */
export function BlogMetrics({ account, blogFilter }: { account: boolean; blogFilter: BlogFilterValue }) {
  if (!account)
    return (
      <section className="panel analytics-empty">
        <span className="empty-icon">
          <ChartNoAxesCombined size={27} />
        </span>
        <h2>도구별 성과 기록은 계정 모드에서 사용 가능합니다.</h2>
        <p>블로그 계정별 도구 값과 블로그지수 기록은 로그인한 워크스페이스에만 저장합니다.</p>
      </section>
    );
  return <MetricBoard blogFilter={blogFilter} />;
}

function MetricBoard({ blogFilter }: { blogFilter: BlogFilterValue }) {
  const [rows, setRows] = useState<MetricSnapshot[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [targetBlog, setTargetBlog] = useState("");
  const [measuredOn, setMeasuredOn] = useState(() => localDay());
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<MetricImport | null>(null);
  const [removing, setRemoving] = useState<MetricSnapshot | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { blogs } = useBlogs(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/blog-metrics", { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { rows?: MetricSnapshot[]; canWrite?: boolean; error?: string } | null;
    if (!res.ok || !data?.rows) throw new Error(data?.error ?? "성과 기록을 불러오지 못했습니다.");
    setRows(data.rows);
    setCanWrite(data.canWrite === true);
    setError("");
  }, []);
  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "성과 기록을 불러오지 못했습니다."))
      .finally(() => setLoaded(true));
  }, [load]);

  /** The database decides what is a duplicate, so its counts are the ones to report. */
  function send(list: MetricInput[]) {
    return sendRevenueChunks(
      list,
      async (chunk) => {
        const res = await fetch("/api/blog-metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: chunk }),
        });
        const data = (await res.json().catch(() => null)) as { added?: number; duplicates?: number; error?: string } | null;
        if (!res.ok) throw new Error(data?.error ?? `요청에 실패했습니다(${res.status}).`);
        return data ?? {};
      },
      load,
      MAX_METRICS_PER_REQUEST,
      metricRowKey,
    );
  }

  async function onFile(f: File | undefined) {
    setMessage("");
    setReport(null);
    if (!f || busy) return;
    setBusy(true);
    try {
      const result = importGsc(await f.text(), rows, { blogId: targetBlog || null, measuredOn, evidenceUrl });
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
      const sent = await send([metricFromForm({ ...form, blogId: targetBlog || null, measuredOn, evidenceUrl })]);
      const notice = revenueSendNotice(sent);
      if (sent.failure) {
        setMessage(notice);
        return;
      }
      if (sent.added > 0) setForm((f) => ({ ...emptyForm, tool: f.tool }));
      setMessage(
        [sent.added > 0 ? "저장했어요." : "같은 블로그·도구·지표·측정일의 값이 이미 있어 기존 값을 유지했어요.", notice].filter(Boolean).join(" "),
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: MetricSnapshot) {
    setRemoving(null);
    setMessage("");
    try {
      const res = await fetch(`/api/blog-metrics?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "삭제하지 못했습니다.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "삭제하지 못했습니다.");
      return;
    }
    await load().catch(() => setMessage("삭제했지만 목록을 새로 불러오지 못했어요. 페이지를 새로고침해 주세요."));
  }

  const shown = filterMetrics(rows, blogFilter);
  const today = localDay();
  const set = (key: keyof typeof emptyForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <section className="panel keywords-panel">
        <h2>도구별 성과 기록</h2>
        <ToolBundles rows={shown} blogs={blogs} filter={blogFilter} />
      </section>

      <section className="panel keywords-panel">
        <h2>블로그지수 추이</h2>
        <IndexTrend series={indexSeries(shown)} blogs={blogs} />
      </section>

      <section className="panel keywords-panel">
        <h2>기록 목록 ({shown.length.toLocaleString("ko-KR")}개)</h2>
        {!loaded ? (
          <p className="metric-note">불러오는 중…</p>
        ) : shown.length === 0 ? (
          <p className="metric-note">{rows.length === 0 ? "아직 기록한 값이 없습니다. 아래에서 직접 입력하거나 Search Console CSV를 가져와 주세요." : "이 필터에 해당하는 기록이 없습니다."}</p>
        ) : (
          <>
            <MetricTable rows={shown.slice(0, limit)} blogs={blogs} canWrite={canWrite} onRemove={setRemoving} />
            {shown.length > limit && (
              <button className="button secondary trend-more" onClick={() => setLimit((n) => n + PAGE)}>
                더 보기 ({(shown.length - limit).toLocaleString("ko-KR")}개 남음)
              </button>
            )}
          </>
        )}
      </section>

      <section className="panel keywords-panel">
        <h2>성과 값 기록하기</h2>
        <p className="metric-note">
          외부 도구 화면에서 확인한 값을 그대로 적어 주세요. 이 화면은 어떤 도구와도 연결되어 있지 않으며 값을 가져오거나 계산하지 않습니다. 근거 URL에는 값을 확인한 화면 주소를 남길 수 있어요.
        </p>
        <div className="ledger-fields">
          <div className="field">
            <label htmlFor="metric-blog">블로그 계정</label>
            <select id="metric-blog" value={targetBlog} onChange={(e) => setTargetBlog(e.target.value)}>
              <option value="">미분류</option>
              {selectableBlogs(blogs).map((b) => (
                <option key={b.id} value={b.id}>
                  {blogOptionLabel(b)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="metric-date">측정일</label>
            <input id="metric-date" type="date" value={measuredOn} max={today} onChange={(e) => setMeasuredOn(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="metric-evidence">근거 URL (선택)</label>
            <input id="metric-evidence" type="url" value={evidenceUrl} maxLength={2000} placeholder="https://" onChange={(e) => setEvidenceUrl(e.target.value)} />
          </div>
        </div>

        <h3 className="team-heading">직접 입력</h3>
        <form onSubmit={addRow}>
          <div className="ledger-fields">
            <div className="field">
              <label htmlFor="metric-tool">도구</label>
              <select id="metric-tool" value={form.tool} onChange={set("tool")}>
                {METRIC_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {TOOL_INFO[t].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="metric-name">지표</label>
              <input id="metric-name" required list="metric-names" value={form.metric} maxLength={40} placeholder={INDEX_METRIC} onChange={set("metric")} />
              <datalist id="metric-names">
                {[INDEX_METRIC, "누락 글 수", "방문자 수", "클릭수", "노출수", "이탈률"].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="metric-value">값</label>
              <input id="metric-value" required value={form.value} maxLength={40} placeholder="숫자 또는 도구가 표시한 문구" onChange={set("value")} />
            </div>
            <div className="field">
              <label htmlFor="metric-unit">단위 (선택)</label>
              <input id="metric-unit" value={form.unit} maxLength={20} onChange={set("unit")} />
            </div>
            <div className="field">
              <label htmlFor="metric-memo">메모 (선택)</label>
              <input id="metric-memo" value={form.memo} maxLength={500} onChange={set("memo")} />
            </div>
            <button className="button primary" disabled={!loaded || !canWrite || busy}>
              저장
            </button>
          </div>
        </form>

        <h3 className="team-heading">Search Console 실적 CSV 가져오기</h3>
        <p className="metric-note">
          Search Console 실적 보고서에서 내보낸 &lsquo;검색어(Queries)&rsquo; 또는 &lsquo;페이지(Pages)&rsquo; CSV를 가져옵니다. 한국어·영어 헤더(인기 검색어/Top queries, 클릭수/Clicks,
          노출수/Impressions, CTR, 게재순위/Position)를 모두 읽고, 비어 있는 값은 0이 아니라 기록하지 않습니다(N/A). 위의 블로그 계정과 측정일로 저장하며, 같은 계정·검색어(페이지)·지표·측정일은
          다시 가져와도 건너뛰고 기존 값을 유지합니다. 최대 2MB.
        </p>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Search Console CSV 파일 선택"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button className="button primary" disabled={!loaded || !canWrite || busy} onClick={() => file.current?.click()}>
          <FileUp size={16} /> CSV 파일 선택
        </button>
        {report && (
          <div role="status" className="success-message">
            {scopeLabel[report.scope]} 값 {report.added}개 추가 · 중복 {report.duplicates}개 건너뜀
            {report.conflicts > 0 && ` · 값이 달라 건너뜀 ${report.conflicts}개(기존 값 유지)`} · 오류 {report.invalid.length}행
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
        {loaded && !canWrite && !error && <p className="metric-note">성과 기록은 소유자·관리자·편집자만 입력하거나 삭제할 수 있어요. 지금은 볼 수만 있어요.</p>}
        {message && (
          <p role="alert" className="metric-note">
            {message}
          </p>
        )}
      </section>

      {removing && (
        <ConfirmDialog
          title={`'${removing.metric}' 기록을 삭제할까요?`}
          description={`${TOOL_INFO[removing.tool].label} · ${removing.measuredOn} 값 1개가 삭제됩니다.`}
          danger
          confirmLabel="삭제"
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </>
  );
}

/** Tools grouped by platform. Shortcuts only: nothing is connected, and values stay per tool. */
export function ToolBundles({ rows, blogs, filter }: { rows: MetricSnapshot[]; blogs: Blog[]; filter: BlogFilterValue }) {
  return (
    <>
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>외부 도구와 연결되어 있지 않습니다.</b> 아래 링크는 바로가기일 뿐이며, 값은 직접 입력하거나 CSV로 가져온 것만 도구 이름·측정일과 함께 표시합니다. 도구마다 기준이 달라 서로 합산하거나
          환산하지 않고, 기록이 없으면 N/A로 표시합니다.
        </div>
      </div>
      {toolGroupsFor(filter, blogs).map((g) => (
        <div key={g.id} className="tool-group">
          <h3 className="team-heading">{g.label}</h3>
          <div className="stats-grid tool-cards">
            {g.tools.map((t) => {
              const info = TOOL_INFO[t];
              const s = toolSummary(rows, t);
              return (
                <article className="stat-card" key={t}>
                  <div className="stat-top">
                    {info.label}
                    {info.url ? (
                      <a href={info.url} target="_blank" rel="noopener noreferrer" aria-label={`${info.label} 바로가기 (새 창)`}>
                        바로가기 <ExternalLink size={13} />
                      </a>
                    ) : (
                      <small>바로가기 없음</small>
                    )}
                  </div>
                  <p>{info.purpose}</p>
                  {s.count === 0 ? (
                    <>
                      <div className="stat-value">N/A</div>
                      <p>기록 없음</p>
                    </>
                  ) : (
                    <ul className="tool-values">
                      {s.items.slice(0, 4).map((i) => (
                        <li key={i.metric}>
                          {i.metric}: <b>{i.value}</b> <small>{i.note}</small>
                        </li>
                      ))}
                      {s.queries > 0 && <li>검색어 {s.queries.toLocaleString("ko-KR")}개 기록</li>}
                      {s.pages > 0 && <li>페이지 {s.pages.toLocaleString("ko-KR")}개 기록</li>}
                      <li>
                        <small>최근 측정일 {s.latest}</small>
                      </li>
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** The index as each tool displayed it, oldest first. Not an official Naver metric, never computed here. */
export function IndexTrend({ series, blogs }: { series: IndexSeries[]; blogs: Blog[] }) {
  return (
    <>
      <p className="metric-note">
        블로그지수는 네이버가 공개하는 공식 지표가 아닙니다. 블스피 등 외부 도구가 자체 기준으로 표시한 값을 도구 이름·측정일과 함께 기록한 것이며, 이 서비스는 지수를 계산하지 않습니다. 도구가
        다르면 기준이 달라 비교하지 않습니다. 지표 이름을 &lsquo;{INDEX_METRIC}&rsquo;로 기록한 값만 여기에 표시합니다.
      </p>
      {series.length === 0 ? (
        <p className="metric-note">N/A · 기록한 블로그지수가 없습니다.</p>
      ) : (
        series.map((s) => (
          <div key={s.key} className="index-series">
            <h3 className="team-heading">
              {accountName(blogs, s.blogId)} · {TOOL_INFO[s.tool].label}
            </h3>
            <div className="table-scroll trend-scroll">
              <table className="trend-table">
                <thead>
                  <tr>
                    <th scope="col">측정일</th>
                    <th scope="col">도구 표시 값</th>
                    <th scope="col">이전 기록 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {s.points.map((p) => (
                    <tr key={p.id}>
                      <td data-label="측정일">{p.measuredOn}</td>
                      <td data-label="도구 표시 값">
                        <b>{p.value}</b>
                      </td>
                      <td data-label="이전 기록 대비">{p.change}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </>
  );
}

/** A table from 768px up; below that each row is laid out as a card (see .trend-table in globals.css). */
export function MetricTable({
  rows,
  blogs,
  canWrite,
  onRemove,
}: {
  rows: MetricSnapshot[];
  blogs: Blog[];
  canWrite: boolean;
  onRemove: (row: MetricSnapshot) => void;
}) {
  return (
    <div className="table-scroll trend-scroll">
      <table className="trend-table">
        <thead>
          <tr>
            <th scope="col">측정일</th>
            <th scope="col">블로그 계정</th>
            <th scope="col">도구</th>
            <th scope="col">지표</th>
            <th scope="col">범위</th>
            <th scope="col">값</th>
            <th scope="col">근거 · 메모</th>
            {canWrite && (
              <th scope="col">
                <span className="sr-only">작업</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="측정일">{r.measuredOn}</td>
              <td data-label="블로그 계정">{accountName(blogs, r.blogId)}</td>
              <td data-label="도구">{TOOL_INFO[r.tool].label}</td>
              <td data-label="지표" className="trend-keyword">
                {r.metric}
              </td>
              <td data-label="범위">{r.scope === "site" ? scopeLabel.site : `${scopeLabel[r.scope]}: ${r.dimension}`}</td>
              <td data-label="값">
                <b>{formatMetricValue(r)}</b>
              </td>
              <td data-label="근거 · 메모">
                {r.evidenceUrl ? (
                  <a href={r.evidenceUrl} target="_blank" rel="noopener noreferrer nofollow">
                    근거
                  </a>
                ) : (
                  "근거 없음"
                )}
                {r.memo && ` · ${r.memo}`}
              </td>
              {canWrite && (
                <td data-label="작업" className="trend-actions">
                  <div className="table-actions">
                    <button className="icon-button" aria-label={`${r.metric} 기록 삭제`} title="삭제" onClick={() => onRemove(r)}>
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
