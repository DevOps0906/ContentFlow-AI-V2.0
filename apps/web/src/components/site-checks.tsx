"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import {
  isStale,
  needsEvidence,
  parseSiteCheck,
  siteCheckItems,
  statusesFor,
  statusLabels,
  STALE_AFTER_DAYS,
  summarizeSiteChecks,
  type SiteCheck,
  type SiteCheckStatus,
} from "@/lib/site-checks";
import { postJson } from "./integrations";

type Loaded = { checks: SiteCheck[]; canRecord: boolean };
type Item = (typeof siteCheckItems)[number];

const when = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

function tone(status: SiteCheckStatus) {
  if (status === "pass" || status === "active") return "good";
  if (status === "fail" || status === "rejected" || status === "limited" || status === "disabled") return "bad";
  return "";
}

function CheckRow({
  item, check, canRecord, onSaved,
}: { item: Item; check: SiteCheck; canRecord: boolean; onSaved: (c: SiteCheck) => void }) {
  const [status, setStatus] = useState<SiteCheckStatus>(check.status);
  const [evidenceUrl, setEvidenceUrl] = useState(check.evidenceUrl ?? "");
  const [note, setNote] = useState(check.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const id = `site-${item.key}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setDone("");
    setBusy(true);
    try {
      const body = parseSiteCheck({ key: item.key, status, evidenceUrl, note });
      const saved = await postJson<{ check: SiteCheck }>("/api/site-checks", body);
      onSaved(saved.check);
      setDone("기록했어요.");
    } catch (err) {
      // What the operator typed stays in the form so the save can be retried.
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="site-check">
      <div className="site-check-head">
        <b>{item.label}</b>
        <span className="site-check-badges">
          {isStale(check.checkedAt) && <span className="site-status stale">재확인 필요</span>}
          <span className={`site-status ${tone(check.status)}`}>{statusLabels[check.status]}</span>
        </span>
      </div>
      <p className="metric-note site-check-hint">
        {item.hint}
        {item.policyUrl && (
          <>
            {" "}
            <a className="view-link" href={item.policyUrl} target="_blank" rel="noreferrer">
              공식 안내
              <ExternalLink size={12} />
            </a>
          </>
        )}
      </p>
      {canRecord ? (
        <form className="site-check-fields" onSubmit={save} noValidate>
          <div className="field">
            <label htmlFor={`${id}-status`}>상태</label>
            <select
              id={`${id}-status`}
              value={status}
              disabled={busy}
              onChange={(e) => setStatus(e.target.value as SiteCheckStatus)}
            >
              {statusesFor(item.key).map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-url`}>근거 URL</label>
            <input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              maxLength={2000}
              placeholder="https://"
              value={evidenceUrl}
              disabled={busy}
              onChange={(e) => setEvidenceUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-note`}>메모{needsEvidence(status) ? " (URL이 없으면 필수)" : ""}</label>
            <input
              id={`${id}-note`}
              maxLength={1000}
              placeholder="확인 방법, 외부 원문 상태"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button className="button secondary" type="submit" disabled={busy}>
            {busy ? "기록 중…" : "확인 기록"}
          </button>
        </form>
      ) : (
        (check.evidenceUrl || check.note) && (
          <p className="metric-note">
            {check.evidenceUrl && (
              <a className="view-link" href={check.evidenceUrl} target="_blank" rel="noreferrer">
                근거 보기
                <ExternalLink size={12} />
              </a>
            )}
            {check.evidenceUrl && check.note && " · "}
            {check.note}
          </p>
        )
      )}
      <p className="metric-note">
        {check.checkedAt
          ? `${when(check.checkedAt)} 확인 · ${check.checkedBy ?? "이전 멤버"}`
          : "아직 확인 기록이 없습니다."}
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="success-message">
          {done}
        </p>
      )}
    </li>
  );
}

/** Operator-recorded site and ad readiness. Account mode only; local mode shows an empty state. */
export function SiteChecks({ account }: { account: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/site-checks", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? "사이트 점검을 불러오지 못했습니다.");
      setData(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "사이트 점검을 불러오지 못했습니다.");
    }
  }, []);
  useEffect(() => {
    if (account) load();
  }, [account, load]);

  if (!account) return <p className="metric-note">사이트 준비 점검은 계정 모드에서 사용 가능합니다.</p>;
  if (error && !data)
    return (
      <>
        <p role="alert" className="error-banner">
          {error}
        </p>
        <button className="button secondary" onClick={load}>
          다시 불러오기
        </button>
      </>
    );
  if (!data) return <p className="metric-note">사이트 점검을 불러오고 있어요.</p>;

  const { checks, canRecord } = data;
  const onSaved = (saved: SiteCheck) =>
    setData((d) => d && { ...d, checks: d.checks.map((c) => (c.key === saved.key ? saved : c)) });
  const sum = summarizeSiteChecks(checks);
  const section = (scope: Item["scope"]) => (
    <ul className="site-check-list">
      {siteCheckItems
        .filter((i) => i.scope === scope)
        .map((i) => (
          <CheckRow
            key={i.key}
            item={i}
            check={checks.find((c) => c.key === i.key)!}
            canRecord={canRecord}
            onSaved={onSaved}
          />
        ))}
    </ul>
  );

  return (
    <>
      <p>
        운영자가 직접 확인한 내용을 기록합니다. URL을 자동으로 점검하지 않으며, Google의 승인 판정이나 법률 준수
        인증을 대신하지 않습니다. 광고 상태와 점검 결과는 글 작성·승인·내보내기·발행을 막지 않습니다.
      </p>
      <p className="metric-note" role="status">
        {sum.recorded === 0
          ? `아직 기록이 없습니다. ${canRecord ? "항목별로 확인한 내용을 남겨주세요." : "소유자·관리자가 기록할 수 있습니다."}`
          : `기록 ${sum.recorded}/${checks.length} · 미충족 ${sum.failed} · ${STALE_AFTER_DAYS}일 지나 재확인 필요 ${sum.stale}`}
      </p>
      <h3 className="team-heading">사이트</h3>
      {section("site")}
      <h3 className="team-heading">광고</h3>
      {section("ad")}
    </>
  );
}
