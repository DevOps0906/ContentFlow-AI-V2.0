"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  type Article,
  LEGACY_STORAGE_KEY,
  loadArticles,
  parseArticles,
  STORAGE_KEY,
} from "@/lib/content";

type Workspace = {
  articles: Article[];
  ready: boolean;
  error: string;
  save: (a: Article) => boolean;
  remove: (id: string) => boolean;
  clear: () => boolean;
};
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      // v1 data is migrated in memory and written to v2 on the next save only.
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
    setReady(true);
    const sync = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      try {
        setArticles(parseArticles(e.newValue));
        setError("");
      } catch {
        setError(
          "다른 탭에서 변경한 데이터를 읽을 수 없습니다. 저장 전에 확인해주세요.",
        );
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function persist(next: Article[]) {
    if (error) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setArticles(next);
      return true;
    } catch {
      setError(
        "저장 공간이 부족하거나 사용할 수 없습니다. 작성 내용을 복사해 보관해주세요.",
      );
      return false;
    }
  }
  function clear() {
    try {
      // Explicit reset removes v1 too, otherwise it would be migrated again on reload.
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      setArticles([]);
      setError("");
      return true;
    } catch {
      setError("저장소를 초기화하지 못했습니다.");
      return false;
    }
  }
  return (
    <Context.Provider
      value={{
        articles,
        ready,
        error,
        save: (a) => persist([a, ...articles.filter((x) => x.id !== a.id)]),
        remove: (id) => persist(articles.filter((x) => x.id !== id)),
        clear,
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
export function download(name: string, content: string, type = "text/html") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
