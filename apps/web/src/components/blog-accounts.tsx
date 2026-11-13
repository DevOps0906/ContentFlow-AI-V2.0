"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { addGate, GATE_MESSAGES, graceLabel, parseUsage, type BlogUsage } from "@/lib/blog-usage";
import { BLOG_PLATFORMS, blogName, blogPlatformLabels, parseBlog, type Blog, type BlogPlatform } from "@/lib/blogs";
import { useBlogs } from "./blog-filter";
import { useFeedback } from "./feedback";

class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
const CONFIRM_REQUIRED = "BLOG_LIMIT_CONFIRM_REQUIRED";

async function send(method: "POST" | "PATCH", body: unknown) {
  const res = await fetch("/api/blogs", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `요청에 실패했습니다(${res.status}).`, data?.code);
}

const empty = { displayName: "", platform: "naver" as BlogPlatform, domain: "" };

/** Usage of the workspace (account mode only; a failed load shows no badge, the database still enforces the limits). */
function useBlogUsage(account: boolean) {
  const [usage, setUsage] = useState<BlogUsage | null>(null);
  const reload = useCallback(async (): Promise<BlogUsage | null> => {
    let fresh: BlogUsage | null = null;
    try {
      const res = await fetch("/api/blogs/usage");
      fresh = res.ok ? parseUsage(await res.json().catch(() => null)) : null;
    } catch {}
    setUsage(fresh);
    return fresh;
  }, []);
  useEffect(() => {
    if (account) reload();
  }, [account, reload]);
  return { usage, reloadUsage: reload };
}

/** What waits for the acknowledgement: a new account, or restoring an archived one. */
type Pending = { type: "add"; form: typeof empty } | { type: "restore"; id: string; success: string };

/** Alert dialog for going past the included number. No amount is shown: billing is not connected. */
function OverageDialog({
  usage,
  restore,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  usage: BlogUsage;
  restore: boolean;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);
  // A disabled confirm button drops the focus to the page; after a failed save it goes back into the dialog.
  useEffect(() => {
    if (!busy && ref.current && !ref.current.contains(document.activeElement)) cancelRef.current?.focus();
  }, [busy]);
  return (
    <div className="dialog-backdrop overage-backdrop">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="overage-title"
        aria-describedby="overage-desc"
        className="dialog overage-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (!busy) onCancel();
            return;
          }
          if (e.key !== "Tab") return;
          const els = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
          if (!els.length) return;
          const first = els[0];
          const last = els[els.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="overage-title">월 추가 요금이 발생할 수 있습니다</h2>
        <div id="overage-desc">
          <dl className="overage-facts">
            <div>
              <dt>현재 사용 중</dt>
              <dd>{usage.active}개</dd>
            </div>
            <div>
              <dt>{restore ? "복원" : "추가"} 후</dt>
              <dd>{usage.active + 1}개</dd>
            </div>
            <div>
              <dt>플랜에 포함된 수</dt>
              <dd>{usage.included}개</dd>
            </div>
            <div>
              <dt>추가 요금</dt>
              <dd>결제 준비 중 · 금액 미정</dd>
            </div>
          </dl>
          <p>포함된 수를 넘는 블로그는 한 달 중 가장 많이 동시에 사용한 수를 기준으로 계산됩니다. 나중에 보관해도 그 달의 기준 수는 줄지 않습니다.</p>
        </div>
        <label className="approval-label">
          <input type="checkbox" checked={checked} disabled={busy} onChange={(e) => setChecked(e.target.checked)} />
          <span>추가 요금이 발생할 수 있음을 확인했습니다.</span>
        </label>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        <div className="editor-actions">
          <button ref={cancelRef} type="button" className="button secondary" disabled={busy} onClick={onCancel}>
            취소
          </button>
          <button type="button" className="button primary" disabled={!checked || busy} onClick={onConfirm}>
            {busy ? "저장 중…" : restore ? "복원" : "추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Add, edit and archive the blog accounts of the workspace (account mode). */
export function BlogAccounts({ account }: { account: boolean }) {
  const { blogs, canManage, loading, error: loadError, reload } = useBlogs(account);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };
  const [error, setError] = useState("");
  const { toast, snackbar } = useFeedback();
  const { usage, reloadUsage } = useBlogUsage(account);
  // The undo snackbar outlives the render that made it: it must judge by the latest usage, not the one at archive time.
  const usageRef = useRef(usage);
  useEffect(() => {
    usageRef.current = usage;
  }, [usage]);
  const [pending, setPending] = useState<Pending | null>(null);

  if (!account) return <p className="metric-note">블로그 계정 관리는 계정 모드에서 사용 가능합니다.</p>;
  const gate = usage ? addGate(usage) : "ok";
  /** Why adding is not possible at all right now (no notice can lift it). */
  const blocked = gate === "limit" || gate === "plan" || gate === "owner" ? GATE_MESSAGES[gate] : null;

  /** A failed reload after a successful write is not reported as a failed write. */
  async function run(
    write: () => Promise<void>,
    success: string,
    undo?: () => void | Promise<void>,
    /** The server asked for the acknowledgement (409 BLOG_LIMIT_CONFIRM_REQUIRED): open the notice, never retry silently. */
    onConfirmRequired?: () => void,
  ) {
    if (busyRef.current) return false;
    setBusy(true);
    setError("");
    try {
      await write();
    } catch (e) {
      if (onConfirmRequired && e instanceof ApiError && e.code === CONFIRM_REQUIRED) {
        const fresh = await reloadUsage();
        if (!fresh) {
          // Without usage the notice cannot show its numbers: say so instead of opening nothing.
          setError(e.message);
          setBusy(false);
          return false;
        }
        usageRef.current = fresh;
        setBusy(false);
        onConfirmRequired();
        return false;
      }
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
      setBusy(false);
      return false;
    }
    await Promise.all([reload(), reloadUsage()]);
    if (undo) snackbar(success, { label: "실행 취소", onAction: undo });
    else toast(success);
    setBusy(false);
    return true;
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      parseBlog(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : "입력을 확인해주세요.");
      return;
    }
    if (editing) {
      const saved = await run(() => send("PATCH", { ...form, id: editing }), "블로그 계정을 수정했어요.");
      // What the operator typed stays in the form when the save failed.
      if (saved) {
        setForm(empty);
        setEditing(null);
      }
      return;
    }
    await activate({ type: "add", form: { ...form } }, false);
  }
  /** Adds or restores an account. Past the included number the notice comes first; the write then carries the acknowledgement. */
  async function activate(action: Pending, acknowledged: boolean) {
    if (busyRef.current) return;
    const current = usageRef.current;
    const gate = current ? addGate(current) : "ok";
    if (gate === "limit" || gate === "plan" || gate === "owner") {
      setError(GATE_MESSAGES[gate]);
      return;
    }
    if (gate === "confirm" && !acknowledged) {
      setError("");
      setPending(action);
      return;
    }
    const ack = acknowledged ? { acknowledgeOverage: true } : {};
    const saved =
      action.type === "add"
        ? await run(
            () => send("POST", { ...action.form, ...ack }),
            "블로그 계정을 추가했어요.",
            undefined,
            () => setPending(action),
          )
        : await run(
            () => send("PATCH", { id: action.id, status: "active", ...ack }),
            action.success,
            undefined,
            () => setPending(action),
          );
    if (!saved) return;
    setPending(null);
    if (action.type === "add") setForm(empty);
  }
  function edit(b: Blog) {
    setEditing(b.id);
    setForm({ displayName: blogName(b), platform: b.platform, domain: b.domain });
    setError("");
  }

  return (
    <>
      <p className="metric-note">
        글과 키워드를 계정별로 묶고 수익·성과 화면에서 나눠 볼 때 씁니다. 계정을 등록해도 해당 블로그와 자동으로 연동되지는 않습니다. 보관한 계정은
        새로 고를 수 없지만 연결된 글과 지난 데이터는 그대로 남습니다.
      </p>
      {usage && (
        <p className="usage-badge" role="status">
          <strong>
            활성 {usage.active} / 포함 {usage.included}
          </strong>
          <span>최대 {usage.max}개</span>
          {graceLabel(usage) && <span>{graceLabel(usage)}</span>}
          {usage.overageSlots > 0 && <span className="usage-badge-over">이번 달 초과 {usage.overageSlots}개 · 추가 요금 결제 준비 중, 금액 미정</span>}
        </p>
      )}
      {loadError && (
        <p role="alert" className="error-banner">
          {loadError}{" "}
          <button className="button secondary" onClick={reload}>
            다시 시도
          </button>
        </p>
      )}
      {loading ? (
        <p className="metric-note">불러오는 중…</p>
      ) : blogs.length === 0 ? (
        !loadError && (
          <div className="empty-state">
            <h3>아직 등록한 블로그 계정이 없어요</h3>
            <p>{canManage ? "아래에서 운영 중인 블로그를 추가해주세요." : "소유자·관리자가 추가하면 여기에 표시됩니다."}</p>
          </div>
        )
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">표시 이름</th>
                <th scope="col">플랫폼</th>
                <th scope="col">주소</th>
                <th scope="col">상태</th>
                {canManage && (
                  <th scope="col">
                    <span className="sr-only">작업</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {blogs.map((b) => (
                <tr key={b.id}>
                  <td>{blogName(b)}</td>
                  <td>{blogPlatformLabels[b.platform]}</td>
                  <td>{b.domain}</td>
                  <td>{b.status === "archived" ? "보관됨" : "사용 중"}</td>
                  {canManage && (
                    <td>
                      <div className="table-actions">
                        <button className="button secondary" disabled={busy} aria-label={`${blogName(b)} 수정`} onClick={() => edit(b)}>
                          <Pencil size={14} /> 수정
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          aria-label={`${blogName(b)} ${b.status === "archived" ? "복원" : "보관"}`}
                          onClick={() =>
                            b.status === "archived"
                              ? activate({ type: "restore", id: b.id, success: "블로그 계정을 복원했어요." }, false)
                              : run(
                                  () => send("PATCH", { id: b.id, status: "archived" }),
                                  "블로그 계정을 보관했어요.",
                                  // Same account, same id: restoring simply sets it back to active.
                                  async () => {
                                    // A save in progress finishes first; the undo is never dropped silently.
                                    while (busyRef.current) await new Promise((r) => setTimeout(r, 100));
                                    // Over the included number the undo opens the notice instead of retrying silently.
                                    await activate({ type: "restore", id: b.id, success: "되돌렸어요. 블로그 계정을 복원했어요." }, false);
                                  },
                                )
                          }
                        >
                          {b.status === "archived" ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          {b.status === "archived" ? "복원" : "보관"}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage ? (
        <form className="ledger-fields" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="blog-name">표시 이름</label>
            <input
              id="blog-name"
              maxLength={60}
              value={form.displayName}
              disabled={busy}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="blog-platform">플랫폼</label>
            <select
              id="blog-platform"
              value={form.platform}
              disabled={busy}
              onChange={(e) => setForm({ ...form, platform: e.target.value as BlogPlatform })}
            >
              {BLOG_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {blogPlatformLabels[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="blog-domain">블로그 주소</label>
            <input
              id="blog-domain"
              maxLength={220}
              placeholder="myblog.tistory.com"
              value={form.domain}
              disabled={busy}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
            />
          </div>
          <button className="button primary" type="submit" disabled={busy || (!editing && blocked !== null)} aria-describedby={!editing && blocked ? "blog-limit-note" : undefined}>
            {busy ? "저장 중…" : editing ? "수정 저장" : "계정 추가"}
          </button>
          {!editing && blocked && (
            <p id="blog-limit-note" className="metric-note usage-limit-note">
              {blocked}
            </p>
          )}
          {editing && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setForm(empty);
                setError("");
              }}
            >
              수정 취소
            </button>
          )}
        </form>
      ) : (
        !loading && <p className="metric-note">블로그 계정은 소유자·관리자만 관리할 수 있어요. 지금은 볼 수만 있어요.</p>
      )}
      {error && !pending && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {pending && usage && (
        <OverageDialog
          usage={usage}
          restore={pending.type === "restore"}
          busy={busy}
          error={error}
          onCancel={() => {
            setPending(null);
            setError("");
          }}
          onConfirm={() => activate(pending, true)}
        />
      )}
    </>
  );
}
