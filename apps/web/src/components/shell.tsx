"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChartLine,
  ChevronRight,
  CircleHelp,
  FileText,
  LayoutDashboard,
  LogOut,
  LayoutTemplate,
  Menu,
  Plus,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { canEdit } from "@/lib/team";
import { useWorkspace } from "./workspace";

const nav = [
  { href: "/", label: "대시보드", icon: LayoutDashboard },
  { href: "/content", label: "콘텐츠", icon: FileText },
  { href: "/keywords", label: "키워드 · 제목 랩", icon: Search },
  { href: "/trends", label: "트렌드 분석", icon: ChartLine },
  { href: "/templates", label: "템플릿 라이브러리", icon: LayoutTemplate },
  { href: "/analytics", label: "수익 분석", icon: TrendingUp },
];
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { articles, error, mode, email, logout } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The login page has its own bare layout: no sidebar for visitors who are not signed in.
  if (path === "/login") return <>{children}</>;
  const initial = (email ?? "N").charAt(0).toUpperCase();
  const current =
    nav.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href)))
      ?.label ?? "설정";
  return (
    <div className="app-shell">
      {open && (
        <button
          className="sidebar-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <Link className="brand" href="/" onClick={() => setOpen(false)}>
          <span className="brand-symbol">
            <Sparkles size={20} />
          </span>
          <span>
            contentflow<span className="brand-dot">.</span>
          </span>
        </Link>
        <nav aria-label="주 메뉴">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              className={`nav-item ${(n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "active" : ""}`}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.href === "/content" && articles.length > 0 && (
                <span className="nav-count">{articles.length}</span>
              )}
              {n.href === "/templates" && <span className="nav-new">10</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon">
              <BookOpen size={19} />
            </div>
            <b>좋은 글의 시작, 템플릿</b>
            <p>
              구조는 맡기고,
              <br />
              나만의 이야기에 집중하세요.
            </p>
            <Link href="/templates">
              템플릿 둘러보기 <ArrowUpRight size={15} />
            </Link>
          </div>
          <Link
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
            href="/settings"
          >
            <Settings size={18} />
            환경설정
          </Link>
          <a
            className="nav-item"
            href="https://github.com/DevOps0906/ContentFlow-AI-V2.0"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={18} />
            프로젝트 가이드
            <ArrowUpRight size={14} />
          </a>
          <div className="user-profile">
            <span className="user-avatar">{initial}</span>
            <span>
              <b>나의 블로그 스튜디오</b>
              <small>{mode === null ? "확인 중…" : mode === "account" ? (email ?? "계정") : "로컬 워크스페이스"}</small>
            </span>
            {mode === "account" ? (
              <button
                className="icon-button"
                onClick={logout}
                aria-label="로그아웃"
                title="로그아웃"
              >
                <LogOut size={16} />
              </button>
            ) : (
              <span className="online-dot" />
            )}
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setOpen(!open)}
              aria-label={open ? "메뉴 닫기" : "메뉴 열기"}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span>워크스페이스</span>
            <ChevronRight size={14} />
            <b>{current}</b>
          </div>
          <div className="topbar-right">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/content?q=${encodeURIComponent(query)}`);
              }}
            >
              <Search size={16} />
              <input
                aria-label="콘텐츠 검색"
                placeholder="콘텐츠 검색..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <span className="local-badge">
              <span />
              {mode === null ? "확인 중…" : mode === "account" ? "계정 · DB 저장" : "로컬 모드"}
            </span>
            <span className="top-avatar">{initial}</span>
          </div>
        </header>
        <main id="main-content">
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          {children}
        </main>
        <footer>
          <span>작은 아이디어를, 오래 읽히는 콘텐츠로.</span>
          <span>
            ContentFlow AI <span className="footer-dot">·</span>{" "}
            {mode === null ? "" : mode === "account" ? "계정에 저장됩니다" : "로컬에 저장됩니다"}
          </span>
        </footer>
      </div>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function NewContentButton() {
  const { role } = useWorkspace();
  // Viewers and reviewers can not create content; the database would refuse it anyway.
  if (role !== null && !canEdit(role)) return null;
  return (
    <Link className="button primary" href="/content/new">
      <Plus size={17} />새 콘텐츠
    </Link>
  );
}
