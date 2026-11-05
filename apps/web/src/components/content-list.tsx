"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, FileText, Search, Trash2 } from "lucide-react";
import { statusLabels, templateName, type ArticleStatus } from "@/lib/content";
import { PageHeading, NewContentButton } from "./shell";
import { useWorkspace } from "./workspace";
import { ConfirmDialog } from "./dialog";
export function ContentList({ initialQuery = "" }: { initialQuery?: string }) {
  const { articles, ready, remove } = useWorkspace();
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<ArticleStatus | "all">("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const filtered = articles.filter(
    (a) =>
      (status === "all" || a.status === status) &&
      `${a.title} ${a.keyword} ${templateName(a)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="MAKE SOMETHING WORTH READING"
        title="나의 콘텐츠"
        description="흩어진 아이디어를 모으고, 하나씩 읽히는 글로 만들어보세요."
        action={<NewContentButton />}
      />
      <div className="toolbar">
        <div className="filter-tabs" role="group" aria-label="콘텐츠 상태">
          {(["all", "draft", "review", "approved"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={status === s}
              className={`filter-tab ${status === s ? "selected" : ""}`}
              onClick={() => setStatus(s)}
            >
              {s === "all" ? "전체" : statusLabels[s]}
              <span>
                {s === "all"
                  ? articles.length
                  : articles.filter((a) => a.status === s).length}
              </span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="콘텐츠 목록 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목, 키워드 검색"
          />
        </label>
      </div>
      <section className="panel">
        {!ready ? (
          <div className="loading-state">콘텐츠를 불러오고 있어요.</div>
        ) : filtered.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>콘텐츠 제목</th>
                  <th>템플릿</th>
                  <th>상태</th>
                  <th>수정일</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id}>
                    <td className="content-title-cell">
                      <Link
                        className="article-title-link"
                        href={`/content/${a.id}`}
                      >
                        <span className="article-file">
                          <FileText size={17} />
                        </span>
                        {a.title || "제목 없는 콘텐츠"}
                      </Link>
                    </td>
                    <td>{templateName(a)}</td>
                    <td>
                      <span className={`status ${a.status}`}>
                        {statusLabels[a.status]}
                      </span>
                    </td>
                    <td>{new Date(a.updatedAt).toLocaleDateString("ko-KR")}</td>
                    <td>
                      <div className="table-actions">
                        <Link
                          className="icon-button"
                          href={`/content/${a.id}`}
                          aria-label={`${a.title} 편집`}
                        >
                          <ArrowUpRight size={16} />
                        </Link>
                        <button
                          className="icon-button"
                          aria-label={`${a.title} 삭제`}
                          onClick={() => setDeleting(a.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <FileText size={32} />
            <h2>
              {articles.length
                ? "검색 결과가 없어요"
                : "아직 작성한 콘텐츠가 없어요"}
            </h2>
            <p>
              {articles.length
                ? "검색어나 상태 필터를 바꿔보세요."
                : "글의 목적에 맞는 템플릿을 골라 첫 문장을 시작해보세요."}
            </p>
            {articles.length ? (
              <button
                className="button secondary"
                onClick={() => {
                  setStatus("all");
                  setQuery("");
                }}
              >
                필터 초기화
              </button>
            ) : (
              <Link className="button primary" href="/templates">
                템플릿 선택하기
              </Link>
            )}
          </div>
        )}
      </section>
      <p className="metric-note">
        콘텐츠는 현재 브라우저에만 저장됩니다. 승인된 원고는 HTML로 백업할 수
        있습니다.
      </p>
      {deleting && (
        <ConfirmDialog
          title="이 콘텐츠를 삭제할까요?"
          description="브라우저에 저장된 원고가 삭제됩니다. 내보내지 않은 내용은 복구할 수 없습니다."
          confirmLabel="삭제하기"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (remove(deleting)) setDeleting(null);
          }}
        />
      )}
    </>
  );
}
