import { useEffect, useState } from "react";
import { SessionExpiredError } from "@contentflow/shell-bridge";
import { bridge, session } from "../app-context.ts";
import { statusLabel, type Article } from "../labels.ts";

type Props = { id: string; onBack: () => void; onExpired: () => void };

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

/** Read-only. Body and URLs are rendered as React text, never as HTML. */
export function ArticleDetail({ id, onBack, onExpired }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    session
      .requestJson<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}`)
      .then((data) => !cancelled && setArticle(data.article))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof SessionExpiredError) return onExpired();
        setError(err instanceof Error ? err.message : "글을 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [id, onExpired]);

  return (
    <section>
      <header className="bar">
        <button type="button" onClick={onBack}>
          ← 목록
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!error && !article && <p className="muted">불러오는 중…</p>}
      {article && (
        <article className="card">
          <h1>{article.title || "(제목 없음)"}</h1>
          <p className="row-meta">
            <span className="badge">{statusLabel(article.status)}</span>
            {article.keyword && <span>{article.keyword}</span>}
            <span>{new Date(article.updatedAt).toLocaleString("ko-KR")}</span>
          </p>
          {article.sourceUrl &&
            (isHttpUrl(article.sourceUrl) ? (
              <button type="button" className="link" onClick={() => void bridge.openExternal(article.sourceUrl)}>
                근거 URL: {article.sourceUrl}
              </button>
            ) : (
              <p className="muted">근거 URL: {article.sourceUrl}</p>
            ))}
          {article.body ? <div className="body">{article.body}</div> : <p className="muted">본문이 비어 있습니다.</p>}
        </article>
      )}
    </section>
  );
}
