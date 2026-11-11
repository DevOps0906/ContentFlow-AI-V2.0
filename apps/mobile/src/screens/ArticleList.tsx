import { useCallback, useEffect, useState } from "react";
import { SessionExpiredError } from "@contentflow/shell-bridge";
import { session } from "../app-context.ts";
import { lifecycleLabels, statusLabel, type Article } from "../labels.ts";

type Props = {
  title: string;
  /** Set for the approvals tab: the filter is fixed and the selector hidden. */
  fixedStatus?: string;
  onOpen: (id: string) => void;
  onExpired: () => void;
};

export function ArticleList({ title, fixedStatus, onOpen, onExpired }: Props) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setError(null);
    setArticles(null);
    try {
      const data = await session.requestJson<{ articles: Article[] }>("/api/articles");
      setArticles(data.articles);
    } catch (err) {
      if (err instanceof SessionExpiredError) return onExpired();
      setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
    }
  }, [onExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = fixedStatus ?? filter;
  const shown = articles?.filter((a) => status === "all" || a.status === status) ?? [];

  return (
    <section>
      <header className="bar">
        <h1>{title}</h1>
        <button type="button" onClick={() => void load()}>
          새로고침
        </button>
      </header>
      {!fixedStatus && (
        <label className="filter">
          상태
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">전체</option>
            {Object.entries(lifecycleLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!error && articles === null && <p className="muted">불러오는 중…</p>}
      {articles && shown.length === 0 && (
        <p className="muted">{fixedStatus ? "승인을 기다리는 글이 없습니다." : "해당하는 글이 없습니다."}</p>
      )}
      <ul className="list">
        {shown.map((a) => (
          <li key={a.id}>
            <button type="button" className="row" onClick={() => onOpen(a.id)}>
              <span className="row-title">{a.title || "(제목 없음)"}</span>
              <span className="row-meta">
                <span className="badge">{statusLabel(a.status)}</span>
                {a.keyword && <span>{a.keyword}</span>}
                <span>{new Date(a.updatedAt).toLocaleDateString("ko-KR")}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
