"use client";
import { useEffect, useState } from "react";
import { failureLabels, formatDuration, type ArticleHistory, type DeliveryAttempt } from "@/lib/delivery";
import { lifecycleLabels } from "@/lib/lifecycle";

const when = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function outcome(a: DeliveryAttempt) {
  if (a.channel === "manual") return "수동 전달";
  return a.failureType ? `실패 · ${failureLabels[a.failureType]}` : "성공";
}

/** Delivery attempts and state history of a saved article. Reloads when `version` changes. */
export function DeliveryHistory({ articleId, version, account }: { articleId: string; version: string; account: boolean }) {
  const [state, setState] = useState<{ key: string; history?: ArticleHistory; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${articleId}|${version}|${retry}`;

  useEffect(() => {
    if (!account) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/articles/${articleId}/history`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const history = (await res.json()) as ArticleHistory;
        if (active) setState({ key, history });
      } catch {
        if (active) setState({ key, error: "기록을 불러오지 못했습니다." });
      }
    })();
    return () => {
      active = false;
    };
  }, [account, articleId, key]);

  if (!account)
    return (
      <section className="panel">
        <h2>발행 기록</h2>
        <p className="metric-note">시도 횟수·실패 유형·상태 이력은 계정 모드에서 사용 가능합니다.</p>
      </section>
    );

  const current = state?.key === key ? state : null;
  const history = current?.history;
  return (
    <section className="panel" aria-live="polite">
      <h2>발행 기록</h2>
      {current?.error ? (
        <>
          <p className="metric-note">{current.error}</p>
          <button className="button secondary" onClick={() => setRetry((n) => n + 1)}>
            다시 불러오기
          </button>
        </>
      ) : !history ? (
        <p className="metric-note">불러오는 중…</p>
      ) : (
        <>
          <p className="metric-note">작업 시간(첫 전이~승인): {formatDuration(history.workTimeMs)}</p>
          {history.attempts.length === 0 ? (
            <p className="metric-note">아직 전달 시도가 없습니다.</p>
          ) : (
            <ol className="block-list">
              {history.attempts.map((a) => (
                <li key={`${a.channel}-${a.attempt}`}>
                  {a.channel === "manual" ? "수동" : "WordPress"} {a.attempt}회차 · {outcome(a)}
                  {a.durationMs !== null && ` · ${formatDuration(a.durationMs)}`} · {when(a.createdAt)}
                  {a.url && (
                    <>
                      {" · "}
                      <a href={a.url} target="_blank" rel="noopener noreferrer">
                        초안 링크
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
          {history.events.length === 0 ? (
            <p className="metric-note">아직 상태 변경 기록이 없습니다.</p>
          ) : (
            <ol className="block-list">
              {history.events.slice(-20).reverse().map((e) => (
                <li key={`${e.createdAt}-${e.toState}`}>
                  {lifecycleLabels[e.fromState]} → {lifecycleLabels[e.toState]} · {when(e.createdAt)}
                </li>
              ))}
            </ol>
          )}
          <p className="metric-note">운영 참고값이며 정산 근거로 쓰지 않습니다.</p>
        </>
      )}
    </section>
  );
}
