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
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { findTemplate, templateBody, templates } from "@/lib/templates";
import {
  type Article,
  approvalBlockers,
  briefErrors,
  contentChanged,
  exportHtml,
  isApprovedContent,
  isPublishedUrl,
  REVIEW_STATUSES,
  reviewErrors,
  reviewStatusLabels,
  saveRevision,
  type ReviewStatus,
} from "@/lib/content";
import {
  afterEdit,
  lifecycleLabels,
  localActions,
  phaseOf,
  requiresApproval,
  transition,
  type LifecycleState,
} from "@/lib/lifecycle";
import { download, useWorkspace } from "./workspace";
import { PageHeading } from "./shell";
import { ConfirmDialog } from "./dialog";
import { TemplateExampleButton } from "./template-example";
import { PhaseSteps, StatusBadge } from "./status-badge";
import { loadChoice } from "@/lib/ai-settings";
import { accountDeliveryCheck, fetchStoredArticle, postJson, useIntegrations } from "./integrations";
import { useBlogs } from "./blog-filter";
import { blogOptionLabel, selectableBlogs } from "@/lib/blogs";
import { runQa } from "@/lib/qa";
import { kindLabels, type ReviewFinding } from "@/lib/review";
import { runSummary, type RunInfo } from "@/lib/agent-runs";
import { DeliveryHistory } from "./delivery-history";
import { TitleEvaluationPanel } from "./title-evaluation";
import type { TitleEvaluationEntry } from "@/lib/titles";
import { canDecide, canEdit, roleLabels } from "@/lib/team";
import { tistoryPackage } from "@/lib/tistory";
import { assertDeliverable, assertSameAsStored } from "@/lib/delivery";
import {
  AD_PROFILES,
  adLabels,
  DEFAULT_AD,
  DEFAULT_LAYOUT,
  LAYOUT_PROFILES,
  layoutLabels,
  previewBlocks,
} from "@/lib/render";

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
  const { articles, save, saveReview, sendWordpress, error, role, mode } = useWorkspace();
  // Local mode has one user who can do everything; in an account the role decides.
  const editable = role === null || canEdit(role);
  const decider = role === null || canDecide(role);
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
        layoutProfile: DEFAULT_LAYOUT,
        adProfile: DEFAULT_AD,
      },
  );
  const [saved, setSaved] = useState(initial);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"ai" | "wp" | "save" | "download" | null>(null);
  const [aiOverwrite, setAiOverwrite] = useState(false);
  const [review, setReview] = useState<{ findings: ReviewFinding[]; model: string; sameModel: boolean; run: RunInfo } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [askManual, setAskManual] = useState(false);
  const integrations = useIntegrations();
  const blogAccounts = useBlogs(mode === "account");
  const aiReady = !!integrations?.ai.configured;
  const cmsConnected =
    !!integrations?.wordpress.configured && form.platform === "wordpress";
  const template = findTemplate(form.templateId);
  const deliveryCheck = mode === "account" ? accountDeliveryCheck : undefined;
  const dirty = saved
    ? contentChanged(form, saved)
    : !!(
        form.title ||
        form.keyword ||
        form.sourceUrl ||
        form.briefPurpose ||
        form.briefAudience ||
        form.body !== templateBody(form.templateId)
      );
  // Unsaved edits void any review/approval until the operator saves and reviews again.
  const currentStatus = dirty ? afterEdit(form.status) : form.status;
  // Editors can not approve; reviewers can only approve or send back what waits for approval;
  // viewers get nothing. The database enforces the same, this just avoids offering dead buttons.
  const actionsFor = (status: LifecycleState) =>
    localActions(status, { cmsConnected }).filter((a) => {
      if (!editable) return decider && status === "approval_pending" && (a.to === "approved" || a.to === "needs_revision");
      if (a.to === "approved") return decider;
      return true;
    });
  const actions = actionsFor(currentStatus);
  const qa = runQa(form, articles);
  const canExport = !dirty && isApprovedContent(form);
  const reviewBlockers = approvalBlockers(form);
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
    setAskManual(false);
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
  const skeleton = form.body.trim() === templateBody(form.templateId).trim();
  async function generateDraft() {
    if (!form.keyword.trim()) {
      setErrors(["AI 초안을 만들려면 핵심 키워드를 입력해주세요."]);
      return;
    }
    setAiOverwrite(false);
    setBusy("ai");
    setErrors([]);
    setMessage("");
    try {
      const { body, run } = await postJson<{ body: string; run: RunInfo }>("/api/ai/generate", {
        templateId: form.templateId,
        keyword: form.keyword,
        title: form.title,
        ai: loadChoice(),
      });
      update("body", body);
      setPreview(false);
      setMessage(
        `AI 초안을 채웠어요. 사실·출처·경험을 직접 확인하고 [확인 필요] 표시를 지운 뒤 검수를 요청해주세요. 모델 ${run.model} · ${runSummary(run)}`,
      );
    } catch (e) {
      setErrors([e instanceof Error ? e.message : "AI 초안을 만들지 못했습니다."]);
    } finally {
      setBusy(null);
    }
  }
  async function crossReview() {
    if (reviewing || dirty) return;
    setReviewing(true);
    setReviewError("");
    setReview(null);
    try {
      // Account mode sends only the id (the server reads the saved article); local mode sends it all.
      const payload = { ...(mode === "account" ? { id: form.id } : form), ai: loadChoice() };
      setReview(await postJson("/api/ai/review", payload));
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "AI 검수를 하지 못했습니다.");
    } finally {
      setReviewing(false);
    }
  }
  /** Runs a store/server call and reports its failure in the form. */
  function fail(e: unknown, fallback: string) {
    setErrors([e instanceof Error ? e.message : fallback]);
  }
  function adopt(stored: Article) {
    setSaved(stored);
    setForm(stored);
  }
  /** export_ready/publish_failed → publishing → draft_created | publish_failed (decided by the server in account mode). */
  async function sendToWordpress() {
    if (dirty || !isApprovedContent(form) || busy) return;
    setBusy("wp");
    setErrors([]);
    setMessage("");
    try {
      await assertDeliverable(form, deliveryCheck);
      const r = await sendWordpress(form);
      adopt(r.article);
      setMessage(
        `WordPress에 초안으로 ${r.created ? "만들었어요" : "갱신했어요"}. 게시 전에 WordPress에서 slug를 읽기 좋은 값으로 변경해주세요(cf-로 시작하는 현재 값은 자동 식별용입니다). 게시는 WordPress에서 직접 한 뒤 '게시 완료 확인'을 눌러주세요.`,
      );
    } catch (e) {
      fail(e, "WordPress 전송에 실패했습니다.");
      // The failed state was stored by the server/provider; show it.
      const stored = (e as { article?: Article }).article;
      if (stored) adopt(stored);
    } finally {
      setBusy(null);
    }
  }
  /** What may be handed off: in account mode the server's copy, refused when this screen is behind it. */
  async function latestCopy(): Promise<Article> {
    if (mode !== "account") return form;
    const stored = await fetchStoredArticle(form.id);
    assertSameAsStored(form, stored);
    return stored;
  }
  /** The state moves only after the operator confirms, so a download alone changes nothing. */
  async function downloadTistory() {
    if (dirty || busy) return;
    setBusy("download");
    setErrors([]);
    setMessage("");
    try {
      const copy = await latestCopy();
      const pack = await tistoryPackage(copy, deliveryCheck);
      download(pack.name, pack.data, "application/zip");
      if (actionsFor(copy.status).some((a) => a.to === "manual_pending")) setAskManual(true);
      else setMessage("티스토리 패키지를 내려받았어요.");
    } catch (e) {
      fail(e, "티스토리 패키지를 만들지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  async function downloadHtml() {
    if (dirty || busy) return;
    setBusy("download");
    setErrors([]);
    setMessage("");
    try {
      const copy = await latestCopy();
      await assertDeliverable(copy, deliveryCheck);
      download(`contentflow-${copy.id}.html`, exportHtml(copy));
    } catch (e) {
      fail(e, "HTML을 내보내지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  async function markPublishFailed() {
    if (busy) return;
    setBusy("wp");
    try {
      adopt(
        await save({
          ...form,
          status: transition(form.status, "publish_failed"),
          updatedAt: new Date().toISOString(),
        }),
      );
      setMessage("전송 실패로 표시했어요. WordPress에 글이 생겼는지 확인한 뒤 다시 시도해주세요.");
    } catch (e) {
      fail(e, "상태를 바꿀 수 없습니다.");
    } finally {
      setBusy(null);
    }
  }
  /** A person's evidence and rights decision, stored on the saved article. */
  async function decideReview(field: "evidenceStatus" | "rightsStatus", value: ReviewStatus) {
    if (busy || dirty || !saved) return;
    setBusy("save");
    setErrors([]);
    setMessage("");
    try {
      adopt(
        await saveReview(saved, {
          evidenceStatus: saved.evidenceStatus ?? "unreviewed",
          rightsStatus: saved.rightsStatus ?? "unreviewed",
          [field]: value,
        }),
      );
      setConfirmed(false);
    } catch (e) {
      fail(e, "근거·권리 상태를 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  /** Stored on the saved copy, so unsaved manuscript edits stay in the form and approval is untouched. */
  async function saveTitleEvaluation(entries: TitleEvaluationEntry[]) {
    if (!saved) return;
    const stored = await save({ ...saved, titleEvaluation: entries, updatedAt: new Date().toISOString() });
    setSaved(stored);
    setForm((f) => ({ ...f, titleEvaluation: stored.titleEvaluation, updatedAt: stored.updatedAt }));
  }
  /** Stored on the saved copy like the title ratings: the account is not part of the approved content. */
  async function chooseBlog(value: string) {
    const blogId = value || null;
    if (!saved) {
      setForm((f) => ({ ...f, blogId }));
      return;
    }
    if (busy) return;
    setBusy("save");
    setErrors([]);
    try {
      const stored = await save({ ...saved, blogId, updatedAt: new Date().toISOString() });
      setSaved(stored);
      setForm((f) => ({ ...f, blogId: stored.blogId, updatedAt: stored.updatedAt }));
      setMessage("블로그 계정을 바꿨어요. 검수·승인 상태는 그대로예요.");
    } catch (e) {
      fail(e, "블로그 계정을 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }
  /** Saves the manuscript and, if given, moves it to `target` via the lifecycle rules. */
  async function persist(target?: LifecycleState) {
    if (busy) return;
    let next = saveRevision(form, saved);
    let issues: string[] = [];
    if (target) {
      if (["qa_pending", "approval_pending", "approved"].includes(target))
        issues = reviewErrors(next);
      // Same rule as applyBriefRule: without a brief the checklist fails and review is refused.
      if (target === "qa_pending") issues = [...new Set([...issues, ...briefErrors(next)])];
      if (target === "drafting" && next.status === "briefing") issues = briefErrors(next);
      if (target === "approved") issues.push(...approvalBlockers(next));
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
        if (target === "published") next.publishedUrl = publishedUrl.trim();
      } catch (e) {
        fail(e, "상태를 바꿀 수 없습니다.");
        return;
      }
    }
    setBusy("save");
    try {
      // Checked before the save: a refused export must not move the article to export_ready.
      if (target === "export_ready") await assertDeliverable(await latestCopy(), deliveryCheck);
      // In account mode the server and database decide whether this state is legal.
      const stored = await save(next);
      if (target === "export_ready" && stored.status === "export_ready")
        download(`contentflow-${stored.id}.html`, exportHtml(stored));
      adopt(stored);
      if (stored.status === "published") setPublishedUrl("");
      setErrors(issues);
      setConfirmed(false);
      setMessage(
        !target && saved && stored.status !== saved.status
          ? "내용이 바뀌어 기존 검수·승인이 해제됐어요. 다시 검수해주세요."
          : savedMessage(stored.status, target),
      );
      if (!initial) router.replace(`/content/${stored.id}`);
    } catch (e) {
      fail(e, "저장하지 못했습니다.");
    } finally {
      setBusy(null);
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
              disabled={!editable}
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
              disabled={!editable}
                value={form.templateId}
                onChange={(e) => chooseTemplate(e.target.value)}
              >
                {templates.map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.id} · {t.name}
                  </option>
                ))}
              </select>
              <TemplateExampleButton
                templateId={form.templateId}
                className="button secondary small template-example-btn"
                onUse={editable ? chooseTemplate : undefined}
              />
            </div>
            <div className="field">
              <label htmlFor="platform">발행 대상</label>
              <select
                id="platform"
              disabled={!editable}
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
          {mode === "account" ? (
            <div className="field">
              <label htmlFor="blog-account">블로그 계정</label>
              <select
                id="blog-account"
                disabled={!editable || !!busy || blogAccounts.loading || !!blogAccounts.error}
                value={form.blogId ?? ""}
                onChange={(e) => chooseBlog(e.target.value)}
              >
                <option value="">미분류</option>
                {selectableBlogs(blogAccounts.blogs, form.blogId).map((b) => (
                  <option key={b.id} value={b.id}>
                    {blogOptionLabel(b)}
                  </option>
                ))}
              </select>
              {blogAccounts.error && <small role="alert">{blogAccounts.error}</small>}
            </div>
          ) : (
            mode === "local" && <p className="metric-note">블로그 계정 연결은 계정 모드에서 사용 가능합니다.</p>
          )}
          <div className="field">
            <label htmlFor="keyword">핵심 키워드</label>
            <input
              id="keyword"
              disabled={!editable}
              placeholder="예: Next.js 포트 오류"
              value={form.keyword}
              onChange={(e) => update("keyword", e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="brief-purpose">브리프 목적</label>
              <input
                id="brief-purpose"
                disabled={!editable}
                maxLength={1000}
                placeholder="이 글로 독자의 어떤 문제를 해결하나요?"
                value={form.briefPurpose ?? ""}
                onChange={(e) => update("briefPurpose", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="brief-audience">대상 독자</label>
              <input
                id="brief-audience"
                disabled={!editable}
                maxLength={1000}
                placeholder="예: Windows에서 개발하는 입문자"
                value={form.briefAudience ?? ""}
                onChange={(e) => update("briefAudience", e.target.value)}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="layout-profile">표시 프로필</label>
              <select
                id="layout-profile"
                disabled={!editable}
                value={form.layoutProfile ?? DEFAULT_LAYOUT}
                onChange={(e) => update("layoutProfile", e.target.value as Article["layoutProfile"])}
              >
                {LAYOUT_PROFILES.map((p) => (
                  <option value={p} key={p}>
                    {p} · {layoutLabels[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ad-profile">광고 프로필</label>
              <select
                id="ad-profile"
                disabled={!editable}
                aria-describedby="ad-profile-note"
                value={form.adProfile ?? DEFAULT_AD}
                onChange={(e) => update("adProfile", e.target.value as Article["adProfile"])}
              >
                {AD_PROFILES.map((p) => (
                  <option value={p} key={p}>
                    {p} · {adLabels[p]}
                  </option>
                ))}
              </select>
              <small id="ad-profile-note">
                후보 위치는 미리보기에만 표시되고 내보내는 글에는 들어가지 않아요. 프로필을 바꾸면 다시 승인해야 합니다.
              </small>
            </div>
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
            <button
              className="ai-button"
              onClick={() => (skeleton ? generateDraft() : setAiOverwrite(true))}
              disabled={!aiReady || busy !== null || !editable}
              title={
                aiReady
                  ? "핵심 키워드와 템플릿으로 초안을 만듭니다."
                  : "AI가 연결되지 않았습니다. GEMINI_API_KEY 또는 OPENAI_API_KEY를 설정해주세요."
              }
            >
              <Sparkles size={13} />
              {busy === "ai" ? "초안 작성 중…" : aiReady ? "AI 초안 생성" : "AI 미연결"}
            </button>
            <span>{form.body.length.toLocaleString()}자</span>
          </div>
          {preview ? (
            <div className="content-preview">
              {previewBlocks(form).map((block, i) =>
                block.kind === "heading" ? (
                  <h2 key={i}>{block.text}</h2>
                ) : block.kind === "paragraph" ? (
                  <p key={i}>{block.text}</p>
                ) : block.kind === "source" ? (
                  <p key={i}>출처: {block.url}</p>
                ) : (
                  <p key={i} className="ad-slot-preview">
                    광고 후보 위치 (미리보기 전용)
                  </p>
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
                readOnly={!editable}
                value={form.body}
                onChange={(e) => update("body", e.target.value)}
                placeholder="이곳에 본문을 작성하세요. ## 으로 소제목을 표시할 수 있어요."
              />
              <small>
                AI 초안은 참고용입니다. 사실·출처·경험은 직접 확인해야 하며,
                자동으로 승인하거나 게시하지 않습니다.
              </small>
            </div>
          )}
          <div className="field">
            <label htmlFor="source">근거 자료 URL</label>
            <input
              id="source"
              disabled={!editable}
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
            {!editable && (
              <p role="status" className="metric-note">
                {roleLabels[role ?? "viewer"]} 권한이라 내용을 수정할 수 없어요.
                {decider ? " 승인 대기 글은 오른쪽에서 승인하거나 수정을 요청할 수 있어요." : ""}
              </p>
            )}
            <div className="editor-actions">
              <button
                className="button secondary"
                onClick={() => persist()}
                disabled={!!error || !editable}
              >
                <Save size={15} />
                임시 저장
              </button>
              {phaseOf(currentStatus) === "plan" && (
                <p className="metric-note">
                  기획 단계예요. 자료 조사와 브리프(제목·근거·구조)를 정리한 뒤 초안
                  작성을 시작하면 검수를 요청할 수 있어요.
                </p>
              )}
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
                  onClick={downloadHtml}
                  disabled={busy !== null}
                >
                  <Download size={15} />
                  HTML 다시 받기
                </button>
              )}
              {canExport && form.platform === "tistory" && (
                <button className="button secondary" onClick={downloadTistory} disabled={busy !== null}>
                  <Download size={15} />
                  티스토리 패키지 받기
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
                <small>
                  {template.id} · 글쓰기 구조
                  {form.templateVersion ? ` · 버전 ${form.templateVersion}` : ""}
                </small>
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
              <div className="field-row">
                {(
                  [
                    ["evidenceStatus", "근거 검토"],
                    ["rightsStatus", "권리 검토"],
                  ] as const
                ).map(([field, label]) => (
                  <div className="field" key={field}>
                    <label htmlFor={field}>{label}</label>
                    <select
                      id={field}
                      disabled={!decider || busy !== null}
                      value={form[field] ?? "unreviewed"}
                      onChange={(e) => decideReview(field, e.target.value as ReviewStatus)}
                    >
                      {REVIEW_STATUSES.map((s) => (
                        <option value={s} key={s}>
                          {reviewStatusLabels[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            {currentStatus === "approval_pending" && reviewBlockers.length > 0 && (
              <ul className="qa-list">
                {reviewBlockers.map((b) => (
                  <li key={b} className="blocker">{b}</li>
                ))}
              </ul>
            )}
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
            {actions.some((a) => a.to === "published") && (
              <div className="field">
                <label htmlFor="published-url">공개 URL</label>
                <input
                  id="published-url"
                  type="url"
                  placeholder="https://게시한 글의 주소"
                  aria-describedby="published-url-note"
                  value={publishedUrl}
                  onChange={(e) => setPublishedUrl(e.target.value)}
                />
                <small id="published-url-note">
                  초안 링크가 아니라 실제로 공개된 글의 http/https 주소를 입력하면 게시 완료를 확인할 수 있어요.
                </small>
              </div>
            )}
            {!dirty && form.publishedUrl && (
              <p className="metric-note published-url">
                공개 URL{" "}
                <a href={form.publishedUrl} target="_blank" rel="noreferrer">
                  {form.publishedUrl}
                </a>
              </p>
            )}
            <div className="lifecycle-actions" role="group" aria-label="다음 단계">
              {actions
                .filter((a) => a.to !== "qa_pending")
                .map(({ to, available }) =>
                  available && to === "publishing" ? (
                    <button
                      key={to}
                      className="button primary"
                      onClick={sendToWordpress}
                      disabled={!!error || busy !== null}
                    >
                      <Send size={15} />
                      {busy === "wp"
                        ? "전송 중…"
                        : currentStatus === "publish_failed"
                          ? "WordPress 초안 다시 보내기"
                          : "WordPress 초안 보내기"}
                    </button>
                  ) : available && currentStatus === "publishing" ? (
                    <button
                      key={to}
                      className="button secondary"
                      onClick={markPublishFailed}
                      disabled={!!error || busy !== null}
                    >
                      응답 없음 — 실패로 표시
                    </button>
                  ) : available ? (
                    <button
                      key={to}
                      className={`button ${to === "approved" ? "primary" : "secondary"}`}
                      onClick={() => persist(to)}
                      disabled={
                        !!error ||
                        (to === "approved" && (!confirmed || reviewBlockers.length > 0)) ||
                        (to === "published" && !isPublishedUrl(publishedUrl.trim()))
                      }
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
                      title={
                        cmsConnected
                          ? "전송 결과에 따라 자동으로 바뀝니다."
                          : "CMS 연동 전에는 사용할 수 없습니다."
                      }
                    >
                      {lifecycleLabels[to]}
                      <small className="unavailable-note">
                        {cmsConnected ? "자동 결정" : "CMS 연동 전"}
                      </small>
                    </button>
                  ),
                )}
              {phaseOf(currentStatus) === "plan" && (
                <p className="metric-note">
                  기획 단계예요. 자료 조사와 브리프(제목·근거·구조)를 정리한 뒤 초안
                  작성을 시작하면 검수를 요청할 수 있어요.
                </p>
              )}
              {actions.some((a) => a.to === "qa_pending") && (
                <p className="metric-note">
                  제목, 실제 본문, 근거 URL, 브리프 목적과 대상 독자를 채운 뒤 본문 하단의 &lsquo;검수 요청&rsquo;을
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
          <TitleEvaluationPanel
            keyword={form.keyword}
            value={form.titleEvaluation}
            editable={editable}
            saved={!!saved}
            onSave={saveTitleEvaluation}
          />
          {saved && <DeliveryHistory articleId={saved.id} version={saved.updatedAt} account={mode === "account"} />}
          {phaseOf(currentStatus) !== "plan" && (
            <section className="panel qa-panel" aria-live="polite">
              <h2>검수 점검</h2>
              {qa.blockers.length === 0 && qa.warnings.length === 0 ? (
                <p className="qa-ok">
                  <Check size={14} /> 자동 점검 {qa.checked}개 항목에서 문제를 찾지 못했어요.
                </p>
              ) : null}
              {qa.blockers.length > 0 && (
                <>
                  <h3 className="qa-heading blocker">검수 전에 해결해야 해요</h3>
                  <ul className="qa-list">
                    {qa.blockers.map((b) => (
                      <li key={b} className="blocker">{b}</li>
                    ))}
                  </ul>
                </>
              )}
              {qa.warnings.length > 0 && (
                <>
                  <h3 className="qa-heading">확인해 보세요 (차단하지 않음)</h3>
                  <ul className="qa-list">
                    {qa.warnings.map((w) => (
                      <li key={w.code}>{w.message}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="metric-note">
                규칙 기반 점검이며 사실 여부나 저작권은 확인하지 않습니다. 근거와 권리는 직접 확인해주세요.
              </p>
              <button
                className="button secondary"
                onClick={crossReview}
                disabled={!aiReady || reviewing || dirty || !form.body.trim()}
                title={
                  !aiReady
                    ? "AI가 연결되지 않았습니다."
                    : dirty
                      ? "저장한 뒤에 검수할 수 있어요."
                      : "다른 모델로 두 번째 의견을 받습니다."
                }
              >
                <Sparkles size={14} /> {reviewing ? "AI 검수 중…" : aiReady ? "AI 교차 검수" : "AI 미연결"}
              </button>
              {reviewError && (
                <p role="alert" className="qa-list blocker">
                  {reviewError}
                </p>
              )}
              {review && (
                <>
                  <h3 className="qa-heading">AI 교차 검수 의견 (참고용)</h3>
                  {review.findings.length === 0 ? (
                    <p className="qa-ok">AI가 따로 짚은 항목이 없어요. 그래도 사실과 권리는 직접 확인해주세요.</p>
                  ) : (
                    <ul className="qa-list">
                      {review.findings.map((f, i) => (
                        <li key={i} className={f.severity === "high" ? "blocker" : undefined}>
                          <b>[{kindLabels[f.kind]}]</b> {f.message}
                          {f.quote && <q className="qa-quote">{f.quote}</q>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="metric-note">
                    모델 {review.model}
                    {review.sameModel ? " — 글 작성과 같은 모델이라 독립적인 검수가 아니에요(설정의 AI API에서 검수 모델을 따로 지정)." : ""} · 승인이나
                    상태를 바꾸지 않습니다.
                  </p>
                  <p className="metric-note">{runSummary(review.run)}</p>
                </>
              )}
            </section>
          )}
        </aside>
      </div>
      {aiOverwrite && (
        <ConfirmDialog
          title="작성한 본문을 AI 초안으로 바꿀까요?"
          description="현재 본문이 AI가 만든 초안으로 교체됩니다. 제목, 키워드, 출처는 유지되며 기존 검수·승인은 해제됩니다."
          confirmLabel="AI 초안으로 교체"
          onCancel={() => setAiOverwrite(false)}
          onConfirm={generateDraft}
        />
      )}
      {askManual && !dirty && actions.some((a) => a.to === "manual_pending") && (
        <ConfirmDialog
          title="수동 게시 대기로 표시할까요?"
          description="내려받은 패키지를 티스토리에 직접 게시하는 단계입니다. 자동으로 게시되지 않으며, 게시한 뒤 공개 URL을 입력해 완료를 확인합니다."
          confirmLabel="수동 게시 대기로 표시"
          onCancel={() => setAskManual(false)}
          onConfirm={() => {
            setAskManual(false);
            persist("manual_pending");
          }}
        />
      )}
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
