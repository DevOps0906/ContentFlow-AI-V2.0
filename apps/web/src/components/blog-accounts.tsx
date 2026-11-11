"use client";
import { useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { BLOG_PLATFORMS, blogName, blogPlatformLabels, parseBlog, type Blog, type BlogPlatform } from "@/lib/blogs";
import { useBlogs } from "./blog-filter";

async function send(method: "POST" | "PATCH", body: unknown) {
  const res = await fetch("/api/blogs", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `요청에 실패했습니다(${res.status}).`);
}

const empty = { displayName: "", platform: "naver" as BlogPlatform, domain: "" };

/** Add, edit and archive the blog accounts of the workspace (account mode). */
export function BlogAccounts({ account }: { account: boolean }) {
  const { blogs, canManage, loading, error: loadError, reload } = useBlogs(account);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  if (!account) return <p className="metric-note">블로그 계정 관리는 계정 모드에서 사용 가능합니다.</p>;

  /** A failed reload after a successful write is not reported as a failed write. */
  async function run(write: () => Promise<void>, success: string) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setDone("");
    try {
      await write();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
      setBusy(false);
      return false;
    }
    await reload();
    setDone(success);
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
    const saved = await run(
      () => send(editing ? "PATCH" : "POST", editing ? { ...form, id: editing } : form),
      editing ? "블로그 계정을 수정했어요." : "블로그 계정을 추가했어요.",
    );
    // What the operator typed stays in the form when the save failed.
    if (saved) {
      setForm(empty);
      setEditing(null);
    }
  }
  function edit(b: Blog) {
    setEditing(b.id);
    setForm({ displayName: blogName(b), platform: b.platform, domain: b.domain });
    setError("");
    setDone("");
  }

  return (
    <>
      <p className="metric-note">
        글과 키워드를 계정별로 묶고 수익·성과 화면에서 나눠 볼 때 씁니다. 계정을 등록해도 해당 블로그와 자동으로 연동되지는 않습니다. 보관한 계정은
        새로 고를 수 없지만 연결된 글과 지난 데이터는 그대로 남습니다.
      </p>
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
                            run(
                              () => send("PATCH", { id: b.id, status: b.status === "archived" ? "active" : "archived" }),
                              b.status === "archived" ? "블로그 계정을 복원했어요." : "블로그 계정을 보관했어요.",
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
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "저장 중…" : editing ? "수정 저장" : "계정 추가"}
          </button>
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
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="metric-note">
          {done}
        </p>
      )}
    </>
  );
}
