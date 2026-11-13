"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, Clock, Hourglass, Loader2, RotateCw, Send, XCircle } from "lucide-react";
import {
  canCancel,
  hasDue,
  POLL_MS,
  QUEUE_TABS,
  reasonOf,
  tabLabel,
  viewLabels,
  viewOf,
  waitText,
  type PublishJob,
  type QueueTab,
  type QueueView,
} from "@/lib/publish-queue";
import { canEdit } from "@/lib/team";
import { postJson } from "./integrations";
import { useFeedback } from "./feedback";
import { PageHeading } from "./shell";
import { useWorkspace } from "./workspace";

const viewIcon: Record<QueueView, typeof Clock> = {
  queued: Hourglass,
  retry_wait: RotateCw,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  needs_attention: AlertTriangle,
  cancelled: Ban,
};
const tone = (v: QueueView) =>
  v === "succeeded" ? "good" : v === "failed" || v === "needs_attention" ? "bad" : v === "retry_wait" ? "stale" : "";
const when = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Loaded = { jobs: PublishJob[] };

export function PublishQueue() {
  const { mode, role, ready } = useWorkspace();
  return (
    <>
      <PageHeading
        eyebrow="PUBLISHING QUEUE"
        title="발행 큐"
        description="승인된 글을 WordPress로 차례대로 보냅니다. 사이트가 바쁘거나 오류가 나면 간격을 두고 자동으로 다시 시도합니다."
      />
      {!ready || mode === null ? (
        <p className="metric-note">불러오는 중…</p>
      ) : mode !== "account" ? (
        <section className="panel analytics-empty">
          <h2>계정 모드에서 사용할 수 있어요</h2>
          <p className="metric-note">로컬 모드에서는 큐 없이 글 상세에서 바로 전송합니다.</p>
        </section>
      ) : (
        <QueueBoard editable={canEdit(role)} />
      )}
    </>
  );
}

function QueueBoard({ editable }: { editable: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<QueueTab>("all");
  const [busyId, setBusyId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { toast } = useFeedback();
  const draining = useRef(false);
  const jobsRef = useRef<PublishJob[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/publish/jobs", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? "발행 큐를 불러오지 못했습니다.");
      jobsRef.current = body.jobs;
      setData({ jobs: body.jobs });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "발행 큐를 불러오지 못했습니다.");
    }
    setNow(Date.now());
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // While something waits: send one due job every few seconds, only while this tab is visible.
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== "visible" || draining.current) return;
      const jobs = jobsRef.current;
      const due = editable && hasDue(jobs);
      const active = jobs.some((j) => j.status === "queued" || j.status === "running");
      if (!due && !active) return;
      draining.current = true;
      try {
        if (due) await postJson("/api/publish/drain", {});
      } catch (e) {
        setError(e instanceof Error ? e.message : "발행 큐를 처리하지 못했습니다.");
      } finally {
        draining.current = false;
        await load();
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [editable, load]);

  async function cancel(job: PublishJob) {
    if (busyId) return;
    setBusyId(job.id);
    try {
      await postJson(`/api/publish/jobs/${job.id}/cancel`, {});
      toast("발행을 취소했어요. 글 상태는 그대로예요.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "취소하지 못했습니다.");
    } finally {
      setBusyId("");
    }
  }

  if (!data)
    return error ? (
      <>
        <p role="alert" className="error-banner">
          {error}
        </p>
        <button className="button secondary" onClick={load}>
          다시 불러오기
        </button>
      </>
    ) : (
      <p className="metric-note">발행 큐를 불러오고 있어요.</p>
    );

  const rows = data.jobs.map((job) => ({ job, view: viewOf(job, now) }));
  const count = (t: QueueTab) => (t === "all" ? rows.length : rows.filter((r) => r.view === t).length);
  const shown = tab === "all" ? rows : rows.filter((r) => r.view === tab);

  return (
    <>
      {error && (
        <p role="alert" className="error-banner">
          {error}{" "}
          <button className="button secondary" onClick={load}>
            다시 불러오기
          </button>
        </p>
      )}
      <div className="toolbar">
        <div className="filter-tabs pq-tabs" role="group" aria-label="발행 상태">
          {QUEUE_TABS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              className={`filter-tab ${tab === t ? "selected" : ""}`}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
              <span>{count(t)}</span>
            </button>
          ))}
        </div>
      </div>
      {!editable && <p className="metric-note">조회만 할 수 있어요. 취소와 발행은 편집 권한이 필요합니다.</p>}
      {shown.length === 0 ? (
        <section className="empty-state">
          <Send size={28} aria-hidden />
          <h2>{rows.length === 0 ? "대기 중인 발행이 없습니다" : `${tabLabel(tab)} 항목이 없습니다`}</h2>
          <p>승인된 글의 상세 화면에서 WordPress로 전송하면 이곳에 쌓입니다.</p>
        </section>
      ) : (
        <ul className="pq-list" aria-label="발행 작업">
          {shown.map(({ job, view }) => {
            const Icon = viewIcon[view];
            const reason = reasonOf(job);
            return (
              <li key={job.id} className="pq-row">
                <div className="pq-main">
                  <b className="pq-title">{job.title || "제목 없음"}</b>
                  <span className={`site-status ${tone(view)}`}>
                    <Icon size={12} aria-hidden className={view === "running" ? "pq-spin" : undefined} />{" "}
                    {viewLabels[view]}
                  </span>
                </div>
                <div className="pq-meta metric-note">
                  <span>
                    시도 {job.attempts}/{job.maxAttempts}
                  </span>
                  {view === "retry_wait" && job.nextAttemptAt && (
                    <span>
                      다음 시도 {when(job.nextAttemptAt)} ({waitText(job.nextAttemptAt, now)})
                    </span>
                  )}
                  {view === "queued" && <span>곧 전송합니다</span>}
                  {reason && view !== "succeeded" && <span>{reason}</span>}
                  {view === "retry_wait" && <span>사이트가 바빠 {waitText(job.nextAttemptAt, now)} 자동 재시도</span>}
                </div>
                <div className="pq-actions">
                  <Link className="button secondary" href={`/content/${job.articleId}`}>
                    글 열기
                  </Link>
                  {editable && canCancel(job) && (
                    <button className="button secondary" disabled={busyId === job.id} onClick={() => cancel(job)}>
                      취소
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
