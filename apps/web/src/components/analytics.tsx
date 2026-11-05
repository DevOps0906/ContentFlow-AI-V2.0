"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChartNoAxesCombined, FileUp, Info, Trash2, Wallet } from "lucide-react";
import {
  formatMoney,
  importRevenue,
  pageSummaries,
  parseRevenue,
  REVENUE_STORAGE_KEY,
  statusLabel,
  summarize,
  type RevenueImport,
  type RevenueRow,
  type RevenueStatus,
  type Summary,
} from "@/lib/revenue";
import { PageHeading } from "./shell";
import { useWorkspace } from "./workspace";
import { ConfirmDialog } from "./dialog";

const num = (n: number | null) => (n === null ? "N/A" : n.toLocaleString("ko-KR"));

/** One value for a stat card only when it is unambiguous; otherwise point at the table. */
function single(summaries: Summary[], status: RevenueStatus, pick: (s: Summary) => string | null) {
  const list = summaries.filter((s) => s.status === status);
  if (list.length === 0) return { value: "—", note: "가져온 보고서 없음" };
  if (list.length > 1) return { value: "표 참고", note: "출처·통화별로 구분해 표시" };
  const v = pick(list[0]);
  return v === null ? { value: "N/A", note: "필요한 열이 보고서에 없음" } : { value: v, note: `${list[0].from} ~ ${list[0].to}` };
}

export function Analytics() {
  const { articles, mode } = useWorkspace();
  const [rows, setRows] = useState<RevenueRow[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<RevenueImport | null>(null);
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("AdSense");
  const [status, setStatus] = useState<RevenueStatus>("estimated");
  const [currency, setCurrency] = useState("KRW");
  const [confirmClear, setConfirmClear] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setRows(parseRevenue(localStorage.getItem(REVENUE_STORAGE_KEY)));
    } catch {
      setError("저장된 수익 데이터를 읽을 수 없습니다. 원본 데이터는 덮어쓰지 않았습니다.");
    }
    setReady(true);
  }, []);

  function persist(next: RevenueRow[]) {
    if (error) return false;
    try {
      localStorage.setItem(REVENUE_STORAGE_KEY, JSON.stringify(next));
      setRows(next);
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
      const result = importRevenue(await f.text(), rows, { source, status, currency });
      if (result.added > 0 && !persist(result.rows)) return;
      setReport(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "가져오기에 실패했습니다.");
    } finally {
      if (file.current) file.current.value = "";
    }
  }

  const summaries = summarize(rows);
  const pages = pageSummaries(rows, articles);
  const est = single(summaries, "estimated", (s) => (s.revenue === null ? null : formatMoney(s.revenue, s.currency)));
  const fin = single(summaries, "finalized", (s) => (s.revenue === null ? null : formatMoney(s.revenue, s.currency)));
  const rpm = single(summaries, "estimated", (s) => (s.rpm === null ? null : formatMoney(s.rpm, s.currency)));
  const linked = pages.filter((p) => p.article).length;

  return (
    <>
      <PageHeading
        eyebrow="UNDERSTAND YOUR GROWTH"
        title="수익 분석"
        description="광고 보고서 CSV를 가져와 예상 수익과 확정 정산을 구분해 확인하는 공간입니다."
      />
      <div className="notice-banner">
        <Info size={17} />
        <div>
          <b>수익 데이터는 이 브라우저에만 저장돼요{mode === "account" ? " (계정에 저장되지 않음)" : ""}.</b>{" "}
          직접 가져온 보고서의 값만 계산하며, 없는 값은 0이 아니라 N/A로 표시합니다. 광고 승인이나 수익 증가를
          보장하지 않습니다.
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="stats-grid">
        {[
          { label: "관측 예상 수익", ...est },
          { label: "확정 정산", ...fin },
          { label: "페이지 RPM(예상)", ...rpm, note: rpm.value === "—" ? "수익과 조회수가 같은 보고서에 필요" : rpm.note },
          { label: mode === "account" ? "계정 콘텐츠" : "로컬 콘텐츠", value: String(articles.length), note: `보고서 URL과 연결된 글 ${linked}개` },
        ].map((m) => (
          <article className="stat-card" key={m.label}>
            <div className="stat-top">
              {m.label}
              <Wallet size={17} />
            </div>
            <div className="stat-value">{m.value}</div>
            <p>{m.note}</p>
          </article>
        ))}
      </div>

      <section className="panel keywords-panel">
        <h2>보고서 CSV 가져오기</h2>
        <p className="metric-note">
          필수 열은 날짜(date)이고, 수익(revenue)·조회수(pageviews)·노출(impressions)·클릭(clicks) 중 하나 이상이
          필요해요. 페이지(page/url) 열이 비어 있으면 사이트 전체 합계로 읽습니다. 같은 출처·구분·통화·날짜·페이지는
          다시 가져와도 건너뜁니다. 최대 2MB · 20,000행.
        </p>
        <div className="revenue-form">
          <div className="field">
            <label htmlFor="rev-source">출처</label>
            <input id="rev-source" value={source} maxLength={40} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rev-status">구분</label>
            <select id="rev-status" value={status} onChange={(e) => setStatus(e.target.value as RevenueStatus)}>
              <option value="estimated">관측 예상 수익</option>
              <option value="finalized">확정 정산</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rev-currency">통화</label>
            <input id="rev-currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </div>
        </div>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="수익 보고서 CSV 파일 선택"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button className="button primary" disabled={!ready || !!error} onClick={() => file.current?.click()}>
          <FileUp size={16} /> CSV 파일 선택
        </button>
        {report && (
          <div role="status" className="success-message">
            {report.added}행 추가 · 중복 {report.duplicates}행 건너뜀 · 오류 {report.invalid.length}행
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
        {message && (
          <p role="alert" className="metric-note">
            {message}
          </p>
        )}
      </section>

      {rows.length === 0 ? (
        <section className="panel analytics-empty">
          <span className="empty-icon">
            <ChartNoAxesCombined size={27} />
          </span>
          <h2>보고서를 가져오면 성장이 보입니다.</h2>
          <p>아직 가져온 데이터가 없습니다. 수익을 0원으로 추정하거나 샘플 수치를 실적처럼 표시하지 않습니다.</p>
        </section>
      ) : (
        <>
          <section className="panel keywords-panel">
            <h2>기간·구분별 요약 ({rows.length.toLocaleString("ko-KR")}행)</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">출처</th>
                    <th scope="col">구분</th>
                    <th scope="col">기간</th>
                    <th scope="col">수익</th>
                    <th scope="col">조회수</th>
                    <th scope="col">RPM</th>
                    <th scope="col">집계 기준</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => (
                    <tr key={`${s.source}${s.status}${s.currency}`}>
                      <td>{s.source}</td>
                      <td>{statusLabel[s.status]}</td>
                      <td>
                        {s.from} ~ {s.to} ({s.days}일)
                      </td>
                      <td>{formatMoney(s.revenue, s.currency)}</td>
                      <td>{num(s.pageviews)}</td>
                      <td>{formatMoney(s.rpm, s.currency)}</td>
                      <td>
                        사이트 합계 {s.siteDays}일 · 페이지 합 {s.pageDays}일
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="metric-note">
              예상 수익과 확정 정산, 서로 다른 통화는 합치지 않습니다. 같은 날 사이트 합계와 페이지 행이 함께 있으면
              사이트 합계만 사용합니다. RPM은 같은 행에 수익과 조회수가 모두 있을 때만 계산합니다.
            </p>
          </section>

          {pages.length > 0 && (
            <section className="panel keywords-panel">
              <h2>페이지별 수익 (상위 {pages.length}개)</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">페이지</th>
                      <th scope="col">연결된 글</th>
                      <th scope="col">구분</th>
                      <th scope="col">수익</th>
                      <th scope="col">조회수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p) => (
                      <tr key={`${p.page}${p.status}${p.currency}`}>
                        <td>{p.page}</td>
                        <td>
                          {p.article ? (
                            <Link href={`/content/${p.article.id}`}>{p.article.title || p.article.keyword}</Link>
                          ) : (
                            "연결 안 됨"
                          )}
                        </td>
                        <td>{statusLabel[p.status]}</td>
                        <td>{formatMoney(p.revenue, p.currency)}</td>
                        <td>{num(p.pageviews)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="metric-note">
                글과의 연결은 WordPress 초안의 주소와 같은 페이지만 표시합니다. 주소가 다르면 &lsquo;연결 안 됨&rsquo;이며,
                귀속할 수 없는 수익을 글에 임의로 배분하지 않습니다.
              </p>
            </section>
          )}
          <button className="button danger" onClick={() => setConfirmClear(true)}>
            <Trash2 size={15} /> 가져온 수익 데이터 삭제
          </button>
        </>
      )}
      {confirmClear && (
        <ConfirmDialog
          title="가져온 수익 데이터를 모두 삭제할까요?"
          description="이 브라우저에 저장된 보고서 행이 삭제됩니다. 원본 CSV 파일은 영향을 받지 않으며, 다시 가져올 수 있습니다."
          danger
          confirmLabel="모두 삭제"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            if (persist([])) {
              setConfirmClear(false);
              setReport(null);
              setMessage("");
            }
          }}
        />
      )}
      <p className="metric-note">
        관측 예상 수익 · 확정 정산 · 모델 추정은 별도입니다. Search Console·GA4 연동과 제작 원가 장부는 아직
        없습니다.
      </p>
    </>
  );
}