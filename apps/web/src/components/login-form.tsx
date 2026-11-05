"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { safeNext } from "@/lib/auth";

export function LoginForm() {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<{ signup: boolean } | "local" | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "link")
      setError("링크가 만료되었거나 이미 사용됐어요. 다시 요청해주세요.");
    fetch("/api/session")
      .then((r) => r.json())
      .then((s) => setAvailable(s.mode === "local" ? "local" : { signup: s.signup !== false }))
      .catch(() => setAvailable(null));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (mode === "forgot") {
        const r = await fetch("/api/auth/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) setError(d.error ?? "요청에 실패했습니다.");
        else setInfo("입력한 이메일로 가입된 계정이 있다면 비밀번호 재설정 메일을 보냈어요. 메일의 링크를 눌러주세요.");
        return;
      }
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        needsConfirmation?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? "요청에 실패했습니다.");
        return;
      }
      if (mode === "signup" && data.needsConfirmation) {
        setInfo("가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해주세요.");
        setMode("login");
        return;
      }
      // Full navigation so the workspace is reloaded for the new session.
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      window.location.assign(next);
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const signupOk = available !== "local" && available?.signup !== false;
  return (
    <div className="login-page">
      <main id="main-content" className="login-card panel">
        <div className="login-brand">
          <span className="brand-symbol">
            <Sparkles size={20} />
          </span>
          <span>
            contentflow<span className="brand-dot">.</span>
          </span>
        </div>
        <h1>{mode === "login" ? "로그인" : mode === "signup" ? "계정 만들기" : "비밀번호 재설정"}</h1>
        <p className="page-description">
          {mode === "login"
            ? "내 워크스페이스의 콘텐츠를 이어서 작업하세요."
            : mode === "signup"
              ? "이메일로 계정을 만들면 콘텐츠가 데이터베이스에 저장돼요."
              : "가입한 이메일을 입력하면 재설정 링크를 보내드려요."}
        </p>
        {available === "local" && (
          <p role="status" className="metric-note">
            로그인이 설정되지 않은 로컬 모드입니다. <a href="/">대시보드로 이동</a>
          </p>
        )}
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="email">이메일</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {mode !== "forgot" && (
          <div className="field">
            <label htmlFor="password">비밀번호</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "signup" && <small>8자 이상 72자 이하</small>}
          </div>
          )}
          {error && (
            <p role="alert" className="validation-list">
              {error}
            </p>
          )}
          {info && (
            <p role="status" className="success-message">
              {info}
            </p>
          )}
          <button
            className="button primary login-submit"
            type="submit"
            disabled={busy || available === "local"}
          >
            {busy ? "처리 중…" : mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : "재설정 메일 보내기"}
          </button>
        </form>
        {mode === "login" && (
          <button
            className="login-switch"
            type="button"
            onClick={() => {
              setMode("forgot");
              setError("");
              setInfo("");
            }}
          >
            비밀번호를 잊으셨나요?
          </button>
        )}
        {mode === "forgot" && (
          <button
            className="login-switch"
            type="button"
            onClick={() => {
              setMode("login");
              setError("");
              setInfo("");
            }}
          >
            로그인으로 돌아가기
          </button>
        )}
        {mode !== "forgot" && signupOk && (
          <button
            className="login-switch"
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError("");
              setInfo("");
            }}
          >
            {mode === "login" ? "계정이 없나요? 가입하기" : "이미 계정이 있어요. 로그인"}
          </button>
        )}
      </main>
    </div>
  );
}