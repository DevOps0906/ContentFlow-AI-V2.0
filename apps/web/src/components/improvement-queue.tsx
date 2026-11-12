"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import type { Article } from "@/lib/content";
import {
  improvementStateLabels,
  improvementStates,
  isOverdue,
  parseImprovement,
  parseImprovementUpdate,
  targetUrlAfterPick,
  type Improvement,
  type ImprovementState,
} from "@/lib/improvements";
import { localDay } from "@/lib/costs";
import { postJson } from "./integrations";
import { useFeedback } from "./feedback";

type Member = { id: string; email: string };
type Loaded = { tasks: Improvement[]; members: Member[]; canManage: boolean };

function TaskRow({
  task, title, members, canManage, onSaved,
}: { task: Improvement; title: string; members: Member[]; canManage: boolean; onSaved: (t: Improvement) => void }) {
  const [state, setState] = useState<ImprovementState>(task.state);
  const [resultVersion, setResultVersion] = useState(task.resultVersion === null ? "" : String(task.resultVersion));
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useFeedback();
  const id = `improve-${task.id}`;
  const assignee = members.find((m) => m.id === task.assigneeId)?.email ?? "담당자 없음";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const body = parseImprovementUpdate({ id: task.id, state, resultVersion, assigneeId });
      const res = await fetch("/api/improvements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { task?: Improvement; error?: string } | null;
      if (!res.ok || !data?.task) throw new Error(data?.error ?? "저장하지 못했습니다.");
      onSaved(data.task);
      toast("기록했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="site-check">
      <div className="site-check-head">
        <b>{title}</b>
        <span className="site-check-badges">
          {isOverdue(task, localDay()) && <span className="site-status bad">검토 기한 지남</span>}
          <span className="site-status">{improvementStateLabels[task.state]}</span>
        </span>
      </div>
      <p>{task.evidence}</p>
      <p className="metric-note">
        <a className="view-link" href={task.targetUrl} target="_blank" rel="noreferrer">
          대상 URL
          <ExternalLink size={12} />
        </a>{" "}
        · 관측 {task.observedFrom} ~ {task.observedTo} · 검토 기한 {task.reviewAt} · 담당 {assignee}
        {task.resultVersion !== null && ` · 변경 버전 v${task.resultVersion}`}
      </p>
      {canManage && (
        <form className="ledger-fields" onSubmit={save} noValidate>
          <div className="field">
            <label htmlFor={`${id}-state`}>상태</label>
            <select id={`${id}-state`} value={state} disabled={busy} onChange={(e) => setState(e.target.value as ImprovementState)}>
              {improvementStates.map((s) => (
                <option key={s} value={s}>
                  {improvementStateLabels[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-version`}>변경 버전{state === "done" ? " (필수)" : ""}</label>
            <input
              id={`${id}-version`}
              inputMode="numeric"
              placeholder="승인 버전 번호"
              value={resultVersion}
              disabled={busy}
              onChange={(e) => setResultVersion(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-assignee`}>담당자</label>
            <select id={`${id}-assignee`} value={assigneeId} disabled={busy} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">선택</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                </option>
              ))}
            </select>
          </div>
          <button className="button secondary" type="submit" disabled={busy}>
            {busy ? "기록 중…" : "진행 기록"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </li>
  );
}

/** Evidence-based work queue. Records work only: it changes no article and publishes nothing. */
export function ImprovementQueue({ account, articles }: { account: boolean; articles: Article[] }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [articleId, setArticleId] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [evidence, setEvidence] = useState("");
  const [observedFrom, setObservedFrom] = useState("");
  const [observedTo, setObservedTo] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [reviewAt, setReviewAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { toast } = useFeedback();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/improvements", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? "개선 큐를 불러오지 못했습니다.");
      setData(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "개선 큐를 불러오지 못했습니다.");
    }
  }, []);
  useEffect(() => {
    if (account) load();
  }, [account, load]);

  function pickArticle(id: string) {
    const publishedOf = (articleId: string) => articles.find((a) => a.id === articleId)?.publishedUrl;
    setTargetUrl(targetUrlAfterPick(targetUrl, publishedOf(articleId), publishedOf(id)));
    setArticleId(id);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMessage("");
    setBusy(true);
    try {
      const body = parseImprovement({ articleId, targetUrl, evidence, observedFrom, observedTo, assigneeId, reviewAt });
      const saved = await postJson<{ task: Improvement }>("/api/improvements", body);
      setData((d) => d && { ...d, tasks: [...d.tasks, saved.task].sort((a, b) => a.reviewAt.localeCompare(b.reviewAt)) });
      setArticleId("");
      setTargetUrl("");
      setEvidence("");
      toast("개선 큐에 추가했어요.");
    } catch (err) {
      // What the operator typed stays in the form so the save can be retried.
      setMessage(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const titleOf = (id: string) => {
    const a = articles.find((x) => x.id === id);
    return a ? a.title || a.keyword : "삭제되었거나 보이지 않는 글";
  };

  return (
    <section className="panel keywords-panel">
      <h2>개선 큐</h2>
      {!account ? (
        <p className="metric-note">개선 큐는 계정 모드에서 사용 가능합니다.</p>
      ) : error && !data ? (
        <>
          <p role="alert" className="error-banner">
            {error}
          </p>
          <button className="button secondary" onClick={load}>
            다시 불러오기
          </button>
        </>
      ) : !data ? (
        <p className="metric-note">개선 큐를 불러오고 있어요.</p>
      ) : (
        <>
          <p className="metric-note">
            관측한 근거와 해야 할 일을 기록하는 작업 목록입니다. 글을 자동으로 고치거나 발행하지 않고, 변경의 효과를
            판정하지 않습니다. 실제 수정은 편집기에서 하고 승인을 다시 받아야 합니다.
          </p>
          {data.canManage ? (
            <form className="ledger-fields" onSubmit={create} noValidate>
              <div className="field">
                <label htmlFor="improve-article">대상 글</label>
                <select id="improve-article" value={articleId} disabled={busy} onChange={(e) => pickArticle(e.target.value)}>
                  <option value="">선택</option>
                  {articles.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title || a.keyword}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="improve-url">대상 URL</label>
                <input
                  id="improve-url"
                  type="url"
                  inputMode="url"
                  maxLength={2000}
                  placeholder="https://"
                  value={targetUrl}
                  disabled={busy}
                  onChange={(e) => setTargetUrl(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="improve-assignee">담당자</label>
                <select id="improve-assignee" value={assigneeId} disabled={busy} onChange={(e) => setAssigneeId(e.target.value)}>
                  <option value="">선택</option>
                  {data.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field wide">
                <label htmlFor="improve-evidence">관측 근거</label>
                <input
                  id="improve-evidence"
                  maxLength={2000}
                  placeholder="어떤 지표가 어느 값으로 관측됐는지"
                  value={evidence}
                  disabled={busy}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="improve-from">관측 시작일</label>
                <input id="improve-from" type="date" value={observedFrom} disabled={busy} onChange={(e) => setObservedFrom(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="improve-to">관측 종료일</label>
                <input id="improve-to" type="date" value={observedTo} disabled={busy} onChange={(e) => setObservedTo(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="improve-review">검토 기한</label>
                <input id="improve-review" type="date" value={reviewAt} disabled={busy} onChange={(e) => setReviewAt(e.target.value)} />
              </div>
              <button className="button secondary" type="submit" disabled={busy}>
                {busy ? "기록 중…" : "개선 작업 추가"}
              </button>
            </form>
          ) : (
            <p className="metric-note">개선 큐는 소유자·관리자·편집자·검수자만 기록할 수 있어요. 지금은 볼 수만 있어요.</p>
          )}
          {message && (
            <p role="alert" className="metric-note">
              {message}
            </p>
          )}
          {data.tasks.length === 0 ? (
            <p className="metric-note">아직 개선 작업이 없습니다.</p>
          ) : (
            <ul className="site-check-list">
              {data.tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  title={titleOf(t.articleId)}
                  members={data.members}
                  canManage={data.canManage}
                  onSaved={(saved) =>
                    setData((d) => d && { ...d, tasks: d.tasks.map((x) => (x.id === saved.id ? saved : x)) })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
