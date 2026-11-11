import { useCallback, useEffect, useState } from "react";
import { session } from "./app-context.ts";
import { AccountScreen } from "./screens/AccountScreen.tsx";
import { ArticleDetail } from "./screens/ArticleDetail.tsx";
import { ArticleList } from "./screens/ArticleList.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";

type Tab = "articles" | "approvals" | "account";
const tabs: { id: Tab; label: string }[] = [
  { id: "articles", label: "글" },
  { id: "approvals", label: "승인 대기" },
  { id: "account", label: "계정" },
];

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("articles");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    session
      .restore()
      .then(setEmail)
      .finally(() => setReady(true));
  }, []);

  const onSignedOut = useCallback(() => {
    setEmail(null);
    setOpenId(null);
    setTab("articles");
  }, []);

  if (!ready) return <main className="shell center">불러오는 중…</main>;
  if (!email) return <LoginScreen onLoggedIn={setEmail} />;

  return (
    <div className="shell">
      <main className="content">
        {openId ? (
          <ArticleDetail id={openId} onBack={() => setOpenId(null)} onExpired={onSignedOut} />
        ) : tab === "account" ? (
          <AccountScreen email={email} onSignedOut={onSignedOut} />
        ) : (
          <ArticleList
            key={tab}
            title={tab === "approvals" ? "승인 대기" : "글 목록"}
            fixedStatus={tab === "approvals" ? "approval_pending" : undefined}
            onOpen={setOpenId}
            onExpired={onSignedOut}
          />
        )}
      </main>
      <nav className="tabbar" aria-label="하단 메뉴">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === tab && !openId ? "tab active" : "tab"}
            aria-current={t.id === tab && !openId ? "page" : undefined}
            onClick={() => {
              setOpenId(null);
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
