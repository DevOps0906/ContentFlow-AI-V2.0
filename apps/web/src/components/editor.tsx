"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  LayoutTemplate,
  Save,
  ShieldCheck,
} from "lucide-react";
import { findTemplate, templateBody, templates } from "@/lib/templates";
import {
  type Article,
  type ArticleStatus,
  exportHtml,
  reviewErrors,
  saveRevision,
  statusLabels,
} from "@/lib/content";
import { download, useWorkspace } from "./workspace";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";

export function EditorScreen({
  id,
  templateId = "T01",
}: {
  id?: string;
  templateId?: string;
}) {
  const { articles, ready } = useWorkspace();
  if (!ready)
    return <div className="loading-state">작업 공간을 불러오고 있어요.</div>;
  const initial = id ? articles.find((a) => a.id === id) : undefined;
  if (id && !initial)
    return (
      <div className="panel empty-state">
        <FileText size={30} />
        <h2>콘텐츠를 찾을 수 없어요</h2>
        <p>다른 브라우저에서 작성했거나 삭제된 콘텐츠일 수 있습니다.</p>
        <Link className="button secondary" href="/content">
          목록으로 돌아가기
        </Link>
      </div>
    );
  return (
    <EditorForm
      key={id ?? `new-${templateId}`}
      initial={initial}
      templateId={templateId}
    />
  );
}
function EditorForm({
  initial,
  templateId,
}: {
  initial?: Article;
  templateId: string;
}) {
  const router = useRouter();
  const { save, error } = useWorkspace();
  const [form, setForm] = useState<Article>(
    () =>
      initial ?? {
        id: crypto.randomUUID(),
        title: "",
        keyword: "",
        templateId: findTemplate(templateId).id,
        platform: "wordpress",
        body: templateBody(templateId),
        sourceUrl: "",
        status: "draft",
        updatedAt: new Date().toISOString(),
      },
  );
  const [saved, setSaved] = useState(initial);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const template = findTemplate(form.templateId);
  const dirty = saved
    ? ["title", "keyword", "templateId", "platform", "body", "sourceUrl"].some(
        (k) => form[k as keyof Article] !== saved[k as keyof Article],
      )
    : !!(
        form.title ||
        form.keyword ||
        form.sourceUrl ||
        form.body !== templateBody(form.templateId)
      );
  const currentStatus = dirty ? "draft" : form.status;
  useEffect(() => {
    const handle = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const navigate = (e: MouseEvent) => {
      const link = (e.target as Element).closest?.("a[href]");
      if (
        !dirty ||
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.button !== 0
      )
        return;
      const next = new URL(link.href);
      if (
        next.pathname === location.pathname &&
        next.search === location.search
      )
        return;
      if (
        !window.confirm(
          "저장하지 않은 변경이 있습니다. 저장하지 않고 이동할까요?",
        )
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", handle);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", handle);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);
  function update<K extends keyof Article>(key: K, value: Article[K]) {
    setForm((f) => ({ ...f, [key]: value, status: "draft" }));
    setConfirmed(false);
    setMessage("");
    setErrors([]);
  }
  function applyTemplate(next: string) {
    setForm((f) => ({
      ...f,
      templateId: next,
      body: templateBody(next),
      status: "draft",
    }));
    setConfirmed(false);
    setPendingTemplate(null);
    setMessage("템플릿 골격을 적용했어요. 각 항목에 내용을 작성해주세요.");
  }
  function chooseTemplate(next: string) {
    if (next === form.templateId) return;
    if (form.body.trim() !== templateBody(form.templateId).trim())
      setPendingTemplate(next);
    else applyTemplate(next);
  }
  function persist(status: ArticleStatus) {
    if (status !== "draft") {
      const issues = reviewErrors(form);
      if (issues.length) {
        setErrors(issues);
        return;
      }
    }
    if (status === "approved" && !confirmed) {
      setErrors(["근거와 권리를 직접 검토했다는 항목을 확인해주세요."]);
      return;
    }
    const next = { ...saveRevision(form, saved), status };
    if (save(next)) {
      setSaved(next);
      setForm(next);
      setErrors([]);
      setMessage(
        status === "draft"
          ? "현재 브라우저에 저장했어요."
          : status === "review"
            ? "검수 대기로 저장했어요. 근거와 권리를 직접 확인해주세요."
            : "검토한 원고를 승인했어요. HTML 내보내기가 가능합니다.",
      );
      if (!initial) router.replace(`/content/${next.id}`);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="CONTENT STUDIO"
        title={initial ? "콘텐츠 편집" : "새로운 콘텐츠"}
        description="템플릿으로 구조를 잡고, 나만의 정보와 경험을 채워보세요."
        action={
          <Link href="/content" className="button secondary">
            <ArrowLeft size={15} />
            목록으로
          </Link>
        }
      />
      <div className="editor-layout">
        <section className="panel editor-main">
          <div className="field">
            <label htmlFor="title">콘텐츠 제목</label>
            <input
              id="title"
              className="title-input"
              placeholder="어떤 이야기를 들려줄까요?"
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="template">글쓰기 템플릿</label>
              <select
                id="template"
                value={form.templateId}
                onChange={(e) => chooseTemplate(e.target.value)}
              >
                {templates.map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.id} · {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="platform">발행 대상</label>
              <select
                id="platform"
                value={form.platform}
                onChange={(e) =>
                  update("platform", e.target.value as Article["platform"])
                }
              >
                <option value="wordpress">WordPress</option>
                <option value="tistory">티스토리</option>
                <option value="blogger">Blogger</option>
                <option value="naver">네이버 블로그</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="keyword">핵심 키워드</label>
            <input
              id="keyword"
              placeholder="예: Next.js 포트 오류"
              value={form.keyword}
              onChange={(e) => update("keyword", e.target.value)}
            />
          </div>
          <div className="editor-tabs">
            <button
              onClick={() => setPreview(false)}
              className={!preview ? "selected" : ""}
              aria-pressed={!preview}
            >
              본문 작성
            </button>
            <button
              onClick={() => setPreview(true)}
              className={preview ? "selected" : ""}
              aria-pressed={preview}
            >
              미리보기
            </button>
            <span>{form.body.length.toLocaleString()}자</span>
          </div>
          {preview ? (
            <div className="content-preview">
              {form.body
                .split("\n")
                .map((line, i) =>
                  line.startsWith("## ") ? (
                    <h2 key={i}>{line.slice(3)}</h2>
                  ) : line.startsWith("# ") ? (
                    <h1 key={i}>{line.slice(2)}</h1>
                  ) : (
                    <p key={i}>{line || "\u00a0"}</p>
                  ),
                )}
            </div>
          ) : (
            <div className="field">
              <label className="sr-only" htmlFor="body">
                본문
              </label>
              <textarea
                id="body"
                value={form.body}
                onChange={(e) => update("body", e.target.value)}
                placeholder="이곳에 본문을 작성하세요. ## 으로 소제목을 표시할 수 있어요."
              />
              <small>
                본문 구조만 제공합니다. AI 생성·외부 발행은 아직 연결되지
                않았습니다.
              </small>
            </div>
          )}
          <div className="field">
            <label htmlFor="source">근거 자료 URL</label>
            <input
              id="source"
              type="url"
              placeholder="https://공식문서 또는 근거 자료"
              value={form.sourceUrl}
              onChange={(e) => update("sourceUrl", e.target.value)}
            />
            <small>
              URL 형식만 검사합니다. 사실 여부와 사용 권한은 직접 확인해주세요.
            </small>
          </div>
          {errors.length > 0 && (
            <ul role="alert" className="validation-list">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {message && (
            <p role="status" className="success-message">
              <Check size={14} />
              {message}
            </p>
          )}
          <div className="editor-bottom">
            <div className="editor-actions">
              <button
                className="button secondary"
                onClick={() => persist("draft")}
                disabled={!!error}
              >
                <Save size={15} />
                임시 저장
              </button>
              <button
                className="button primary"
                onClick={() => persist("review")}
                disabled={!!error}
              >
                검수 요청
              </button>
              {currentStatus === "approved" && (
                <button
                  className="button secondary"
                  onClick={() =>
                    download(
                      `contentflow-${form.id}.html`,
                      exportHtml({ ...form, status: "approved" }),
                    )
                  }
                >
                  <Download size={15} />
                  HTML 내보내기
                </button>
              )}
            </div>
            <p>
              수정한 원고는 다시 승인해야 합니다. 외부 블로그에는 자동 게시되지
              않습니다.
            </p>
          </div>
        </section>
        <aside className="editor-side">
          <section className="panel">
            <h2>선택한 템플릿</h2>
            <div className="template-summary">
              <span className={template.color}>
                <LayoutTemplate size={18} />
              </span>
              <div>
                <b>{template.name}</b>
                <small>{template.id} · 글쓰기 구조</small>
              </div>
            </div>
            <ol className="block-list">
              {template.blocks.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ol>
            <p className="evidence-note">필수 근거: {template.evidence}</p>
          </section>
          <section className="panel">
            <h2>검수 · 승인</h2>
            <span className={`status ${currentStatus}`}>
              {statusLabels[currentStatus]}
            </span>
            <p className="metric-note">
              제목, 실제 본문, 근거 URL을 채운 후 직접 검토하고 승인하세요.
            </p>
            <label className="approval-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>사실·출처·이미지 권리를 직접 확인했습니다.</span>
            </label>
            <button
              style={{ marginTop: 16, width: "100%" }}
              className="button secondary"
              onClick={() => persist("approved")}
              disabled={!!error || !confirmed}
            >
              <ShieldCheck size={15} />
              검토 후 승인
            </button>
            {saved && (
              <p className="metric-note">
                마지막 저장{" "}
                {new Date(saved.updatedAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
          </section>
        </aside>
      </div>
      {pendingTemplate && (
        <ConfirmDialog
          title="본문을 새 템플릿으로 바꿀까요?"
          description="입력한 본문이 선택한 템플릿의 빈 골격으로 교체됩니다. 제목, 키워드, 출처는 유지되며 기존 승인은 해제됩니다."
          confirmLabel="새 골격 적용"
          onCancel={() => setPendingTemplate(null)}
          onConfirm={() => applyTemplate(pendingTemplate)}
        />
      )}
    </>
  );
}
