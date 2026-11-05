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
  exportHtml,
  isApprovedContent,
  reviewErrors,
  saveRevision,
} from "@/lib/content";
import {
  afterEdit,
  lifecycleLabels,
  localActions,
  requiresApproval,
  transition,
  type LifecycleState,
} from "@/lib/lifecycle";
import { download, useWorkspace } from "./workspace";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";
import { PhaseSteps, StatusBadge } from "./status-badge";

function actionLabel(from: LifecycleState, to: LifecycleState) {
  switch (to) {
    case "researching":
      return "자료 조사 시작";
    case "briefing":
      return "브리프 작성 시작";
    case "drafting":
      return requiresApproval.includes(from)
        ? "승인 해제하고 다시 작성"
        : from === "briefing"
          ? "초안 작성 시작"
          : "다시 작성";
    case "qa_pending":
      return "검수 요청";
    case "approval_pending":
      return "검수 통과 처리";
    case "needs_revision":
      return "수정 요청";
    case "approved":
      return "검토 후 승인";
    case "export_ready":
      return from === "approved" ? "HTML 내보내기" : "내보내기 단계로 되돌리기";
    case "manual_pending":
      return "수동 게시 시작";
    case "published":
      return "게시 완료 확인";
    case "monitoring":
      return "성과 모니터링 시작";
    case "update_due":
      return "업데이트 필요로 표시";
    default:
      return lifecycleLabels[to];
  }
}
function savedMessage(status: LifecycleState, target?: LifecycleState) {
  if (!target) return "현재 브라우저에 저장했어요.";
  switch (status) {
    case "approval_pending":
      return "검수를 통과해 승인 대기로 저장했어요. 근거와 권리를 직접 확인한 뒤 승인해주세요.";
    case "needs_revision":
      return "검수에서 고칠 항목이 있어 '수정 필요'로 저장했어요.";
    case "approved":
      return "검토한 원고를 승인했어요. HTML 내보내기가 가능합니다.";
    case "export_ready":
      return "HTML을 내려받고 '내보내기 준비'로 표시했어요.";
    case "manual_pending":
      return "수동 게시 대기로 표시했어요. 블로그에 직접 게시한 뒤 완료를 확인해주세요.";
    case "published":
      return "게시 완료로 표시했어요. 외부 블로그에 자동 게시하지는 않았습니다.";
    default:
      return `상태를 '${lifecycleLabels[status]}'(으)로 변경했어요.`;
  }
}

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
        status: "drafting",
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
  // Unsaved edits void any review/approval until the operator saves and reviews again.
  const currentStatus = dirty ? afterEdit(form.status) : form.status;
  const actions = localActions(currentStatus);
  const canExport = !dirty && isApprovedContent(form);
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
    setForm((f) => ({ ...f, [key]: value }));
    setConfirmed(false);
    setMessage("");
    setErrors([]);
  }
  function applyTemplate(next: string) {
    setForm((f) => ({
      ...f,
      templateId: next,
      body: templateBody(next),
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
  /** Saves the manuscript and, if given, moves it to `target` via the lifecycle rules. */
  function persist(target?: LifecycleState) {
    let next = saveRevision(form, saved);
    let issues: string[] = [];
    if (target) {
      if (["qa_pending", "approval_pending", "approved"].includes(target))
        issues = reviewErrors(next);
      if (target === "approved" && !confirmed)
        issues.push("근거와 권리를 직접 검토했다는 항목을 확인해주세요.");
      try {
        let status = transition(next.status, target);
        // QA is decided immediately by the checklist: pass → approval, fail → revision.
        if (target === "qa_pending")
          status = transition(
            status,
            issues.length ? "needs_revision" : "approval_pending",
          );
        else if (issues.length) {
          setErrors(issues);
          return;
        }
        next = { ...next, status };
      } catch (e) {
        setErrors([e instanceof Error ? e.message : "상태를 바꿀 수 없습니다."]);
        return;
      }
    }
    if (save(next)) {
      if (target === "export_ready" && next.status === "export_ready")
        download(`contentflow-${next.id}.html`, exportHtml(next));
      setSaved(next);
      setForm(next);
      setErrors(issues);
      setConfirmed(false);
      setMessage(
        !target && saved && next.status !== saved.status
          ? "내용이 바뀌어 기존 검수·승인이 해제됐어요. 다시 검수해주세요."
          : savedMessage(next.status, target),
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
                onClick={() => persist()}
                disabled={!!error}
              >
                <Save size={15} />
                임시 저장
              </button>
              {actions.some((a) => a.to === "qa_pending") && (
                <button
                  className="button primary"
                  onClick={() => persist("qa_pending")}
                  disabled={!!error}
                >
                  검수 요청
                </button>
              )}
              {canExport && (
                <button
                  className="button secondary"
                  onClick={() =>
                    download(`contentflow-${form.id}.html`, exportHtml(form))
                  }
                >
                  <Download size={15} />
                  HTML 다시 받기
                </button>
              )}
            </div>
            <p>
              수정한 원고는 다시 검수·승인해야 합니다. 외부 블로그에는 자동
              게시되지 않습니다.
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
          <section className="panel lifecycle-panel">
            <h2>진행 상태</h2>
            <div className="lifecycle-current">
              <StatusBadge state={currentStatus} />
              {dirty && <small>저장하지 않은 변경 있음</small>}
            </div>
            <PhaseSteps state={currentStatus} />
            {currentStatus === "approval_pending" && (
              <label className="approval-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>사실·출처·이미지 권리를 직접 확인했습니다.</span>
              </label>
            )}
            <div className="lifecycle-actions" role="group" aria-label="다음 단계">
              {actions
                .filter((a) => a.to !== "qa_pending")
                .map(({ to, available }) =>
                  available ? (
                    <button
                      key={to}
                      className={`button ${to === "approved" ? "primary" : "secondary"}`}
                      onClick={() => persist(to)}
                      disabled={!!error || (to === "approved" && !confirmed)}
                    >
                      {to === "approved" ? (
                        <ShieldCheck size={15} />
                      ) : to === "export_ready" && currentStatus === "approved" ? (
                        <Download size={15} />
                      ) : null}
                      {actionLabel(currentStatus, to)}
                    </button>
                  ) : (
                    <button
                      key={to}
                      className="button secondary"
                      aria-disabled="true"
                      disabled
                      title="CMS 연동 전에는 사용할 수 없습니다."
                    >
                      {lifecycleLabels[to]}
                      <small className="unavailable-note">CMS 연동 전</small>
                    </button>
                  ),
                )}
              {actions.some((a) => a.to === "qa_pending") && (
                <p className="metric-note">
                  제목, 실제 본문, 근거 URL을 채운 뒤 본문 하단의 &lsquo;검수 요청&rsquo;을
                  누르세요.
                </p>
              )}
            </div>
            <p className="metric-note">
              승인 후에만 HTML을 내보낼 수 있고, 게시는 직접 한 뒤 완료를
              확인합니다.
            </p>
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
