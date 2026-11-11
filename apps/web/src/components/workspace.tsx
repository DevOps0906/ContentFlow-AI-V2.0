"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Role } from "@/lib/team";
import type { ReviewDecision } from "@/lib/articles-db";
import {
  applyBriefRule,
  applyPublishedUrlRule,
  applyRendererRule,
  applyReviewRule,
  applyTemplateVersionRule,
  type Article,
  LEGACY_STORAGE_KEY,
  loadArticles,
  parseArticles,
  STORAGE_KEY,
} from "@/lib/content";

// Two storage back ends behind one interface:
//  - local:   no Supabase configured; articles live in this browser's localStorage.
//  - account: logged in; articles live in the database and every state change is
//             checked by the server (API routes + DB trigger), not trusted from the browser.
export type Mode = "local" | "account";

type Workspace = {
  articles: Article[];
  ready: boolean;
  /** Blocking storage problem (unreadable local data). API failures are thrown instead. */
  error: string;
  mode: Mode | null;
  email: string | null;
  /** Role in the active workspace. `null` in local mode (the browser owner can do everything). */
  role: Role | null;
  /** Stores the article and resolves to what was stored. Throws an Error with a user message. */
  save: (a: Article) => Promise<Article>;
  /** Stores a person's evidence and rights decision on the saved article. */
  saveReview: (a: Article, decision: ReviewDecision) => Promise<Article>;
  remove: (id: string) => Promise<boolean>;
  clear: () => boolean;
  /** WordPress draft. Local mode drives the state in the browser; account mode asks the server. */
  sendWordpress: (a: Article) => Promise<{ article: Article; created: boolean }>;
  importLocal: () => Promise<{ imported: number; skipped: number; invalid: number; failed: number }>;
  logout: () => Promise<void>;
};
const Context = createContext<Workspace | null>(null);

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign("/login");
    throw new ApiError("로그인이 필요합니다.", 401, data);
  }
  if (!res.ok)
    throw new ApiError(
      (data as { error?: string } | null)?.error ?? `요청에 실패했습니다(${res.status}).`,
      res.status,
      data,
    );
  return data as T;
}
/** Attaches the article as stored after a failed send, so the editor can show its real state. */
function withArticle(e: unknown, article?: Article) {
  const err = e instanceof Error ? e : new Error("WordPress 전송에 실패했습니다.");
  return Object.assign(err, { article });
}
const sortNewest = (list: Article[]) =>
  [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);

  const loadAccount = useCallback(async () => {
    const { articles: list } = await api<{ articles: Article[] }>("/api/articles");
    setArticles(list);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let session: { mode: Mode; user?: { email: string; role?: Role } | null } = { mode: "local" };
      try {
        const res = await fetch("/api/session");
        if (res.ok) session = await res.json();
      } catch {
        // Server unreachable: fall back to the browser's own data.
      }
      if (cancelled) return;
      setMode(session.mode);
      if (session.mode === "account") {
        setEmail(session.user?.email ?? null);
        setRole(session.user?.role ?? null);
        if (session.user) {
          try {
            await loadAccount();
          } catch (e) {
            setError(e instanceof Error ? e.message : "콘텐츠를 불러오지 못했습니다.");
          }
        }
      } else {
        try {
          setArticles(
            loadArticles(
              localStorage.getItem(STORAGE_KEY),
              localStorage.getItem(LEGACY_STORAGE_KEY),
            ),
          );
        } catch {
          setError(
            "브라우저 저장소를 읽을 수 없습니다. 원본 데이터는 덮어쓰지 않았습니다. 설정에서 백업 후 초기화할 수 있습니다.",
          );
        }
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAccount]);

  useEffect(() => {
    if (mode === "local") {
      const sync = (e: StorageEvent) => {
        if (e.key !== STORAGE_KEY) return;
        try {
          setArticles(parseArticles(e.newValue));
          setError("");
        } catch {
          setError("다른 탭에서 변경한 데이터를 읽을 수 없습니다. 저장 전에 확인해주세요.");
        }
      };
      window.addEventListener("storage", sync);
      return () => window.removeEventListener("storage", sync);
    }
    if (mode === "account" && email) {
      // Another device or tab may have changed things; refresh when coming back.
      const refresh = () => loadAccount().catch(() => {});
      window.addEventListener("focus", refresh);
      return () => window.removeEventListener("focus", refresh);
    }
  }, [mode, email, loadAccount]);

  function persistLocal(next: Article[]) {
    if (error) throw new Error(error);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setArticles(next);
    } catch {
      const msg = "저장 공간이 부족하거나 사용할 수 없습니다. 작성 내용을 복사해 보관해주세요.";
      setError(msg);
      throw new Error(msg);
    }
  }
  const upsert = (list: Article[], a: Article) => [a, ...list.filter((x) => x.id !== a.id)];

  async function save(a: Article): Promise<Article> {
    if (mode === "account") {
      const { article } = await api<{ article: Article }>(`/api/articles/${a.id}`, {
        method: "PUT",
        body: JSON.stringify(a),
      });
      setArticles((list) => upsert(list, article));
      return article;
    }
    const previous = articles.find((x) => x.id === a.id);
    const next = applyTemplateVersionRule(
      applyReviewRule(applyBriefRule(applyRendererRule(applyPublishedUrlRule(a, previous), previous), previous), previous),
      previous,
    );
    persistLocal(upsert(articles, next));
    return next;
  }
  async function saveReview(a: Article, decision: ReviewDecision) {
    if (mode === "account") {
      const { article } = await api<{ article: Article }>(`/api/articles/${a.id}/review`, {
        method: "PATCH",
        body: JSON.stringify(decision),
      });
      setArticles((list) => upsert(list, article));
      return article;
    }
    return save({ ...a, ...decision, updatedAt: new Date().toISOString() });
  }
  async function remove(id: string) {
    if (mode === "account") {
      await api(`/api/articles/${id}`, { method: "DELETE" });
      setArticles((list) => list.filter((x) => x.id !== id));
      return true;
    }
    persistLocal(articles.filter((x) => x.id !== id));
    return true;
  }
  function clear() {
    if (mode === "account") return false; // account data is never wiped from the browser
    try {
      localStorage.removeItem(STORAGE_KEY);
      // Explicit reset removes v1 too, otherwise it would be migrated again on reload.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setArticles([]);
      setError("");
      return true;
    } catch {
      setError("저장소를 초기화하지 못했습니다.");
      return false;
    }
  }
  async function sendWordpress(a: Article) {
    if (mode === "account") {
      try {
        const r = await api<{ article: Article; created: boolean }>("/api/wordpress/draft", {
          method: "POST",
          body: JSON.stringify({ id: a.id }),
        });
        setArticles((list) => upsert(list, r.article));
        return r;
      } catch (e) {
        // The server records `publish_failed`; pick that up before reporting the error.
        const failed = e instanceof ApiError ? (e.data as { article?: Article } | null)?.article : undefined;
        if (failed) setArticles((list) => upsert(list, failed));
        else await loadAccount().catch(() => {});
        throw withArticle(e, failed);
      }
    }
    // Local mode: persist "publishing" first so a closed tab can not silently lose an in-flight send.
    const { transition } = await import("@/lib/lifecycle");
    const publishing = await save({
      ...a,
      status: transition(a.status, "publishing"),
      updatedAt: new Date().toISOString(),
    });
    try {
      const r = await api<{ postId: number; url: string; created: boolean }>(
        "/api/wordpress/draft",
        { method: "POST", body: JSON.stringify(publishing) },
      );
      const done = await save({
        ...publishing,
        status: transition("publishing", "draft_created"),
        remote: { postId: r.postId, url: r.url, syncedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
      return { article: done, created: r.created };
    } catch (e) {
      const failed = await save({
        ...publishing,
        status: transition("publishing", "publish_failed"),
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw withArticle(e, failed);
    }
  }
  async function importLocal() {
    let local: Article[] = [];
    try {
      local = loadArticles(
        localStorage.getItem(STORAGE_KEY),
        localStorage.getItem(LEGACY_STORAGE_KEY),
      );
    } catch {
      throw new Error("브라우저 저장소를 읽을 수 없어 가져올 수 없습니다.");
    }
    const r = await api<{ imported: number; skipped: number; invalid: number; failed: number }>(
      "/api/articles/import",
      { method: "POST", body: JSON.stringify({ articles: local }) },
    );
    await loadAccount();
    return r;
  }
  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Context.Provider
      value={{
        articles: sortNewest(articles),
        ready,
        error,
        mode,
        email,
        role,
        save,
        saveReview,
        remove,
        clear,
        sendWordpress,
        importLocal,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const state = useContext(Context);
  if (!state) throw new Error("WorkspaceProvider is required");
  return state;
}
export function download(name: string, content: string | Uint8Array<ArrayBuffer>, type = "text/html") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
