"use client";
import { useState } from "react";
import {
  newTitleEvaluation,
  TITLE_AXES,
  TITLE_RATINGS,
  titleRatingLabels,
  titleWarnings,
  type TitleEvaluationEntry,
  type TitleRating,
} from "@/lib/titles";

/** Title Lab inside the editor: five rule-made candidates that a person rates. */
export function TitleEvaluationPanel({
  keyword,
  value,
  editable,
  saved,
  onSave,
}: {
  keyword: string;
  value?: TitleEvaluationEntry[];
  editable: boolean;
  /** The article exists in storage; ratings are stored on it. */
  saved: boolean;
  onSave: (entries: TitleEvaluationEntry[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function generate() {
    setMessage("");
    try {
      setDraft(newTitleEvaluation(keyword));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "제목 후보를 만들지 못했습니다.");
    }
  }
  function rate(index: number, axis: (typeof TITLE_AXES)[number]["key"], rating: TitleRating | null) {
    setMessage("");
    setDraft((list) => list?.map((e, i) => (i === index ? { ...e, [axis]: rating } : e)) ?? null);
  }
  async function store() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await onSave(draft);
      setMessage("제목 평가를 저장했어요. 승인 상태는 바뀌지 않습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "제목 평가를 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>제목 평가</h2>
      <p className="metric-note">
        규칙으로 만든 후보 5개를 직접 평가해 기록합니다. 검색 순위를 예측하는 점수가 아니에요.
      </p>
      {editable && (
        <button className="button secondary" onClick={generate} disabled={busy}>
          {draft ? "후보 다시 만들기" : "제목 후보 5개 만들기"}
        </button>
      )}
      {draft && (
        <ol className="title-list">
          {draft.map((entry, index) => (
            <li key={entry.pattern}>
              <b>{entry.title}</b> <small>({entry.pattern})</small>
              {titleWarnings(entry.title).map((w) => (
                <p key={w} className="metric-note">
                  {w}
                </p>
              ))}
              <div className="title-ratings">
                {TITLE_AXES.map((axis) => (
                  <div className="field" key={axis.key}>
                    <label htmlFor={`rating-${index}-${axis.key}`}>{axis.label}</label>
                    <select
                      id={`rating-${index}-${axis.key}`}
                      disabled={!editable || busy}
                      value={entry[axis.key] ?? ""}
                      onChange={(e) => rate(index, axis.key, (e.target.value || null) as TitleRating | null)}
                    >
                      <option value="">미평가</option>
                      {TITLE_RATINGS.map((r) => (
                        <option value={r} key={r}>
                          {titleRatingLabels[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
      {draft && editable && (
        <button className="button primary" onClick={store} disabled={busy || !saved}>
          {busy ? "저장 중…" : "제목 평가 저장"}
        </button>
      )}
      {draft && editable && !saved && <p className="metric-note">글을 먼저 임시 저장하면 평가를 저장할 수 있어요.</p>}
      {error && (
        <p role="alert" className="qa-list blocker">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="metric-note">
          {message}
        </p>
      )}
    </section>
  );
}
