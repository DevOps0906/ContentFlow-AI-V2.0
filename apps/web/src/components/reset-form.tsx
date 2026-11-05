"use client";
import { useState, type FormEvent } from "react";
import { PageHeading } from "./shell";

export function ResetForm() {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (password !== again) return setError("두 비밀번호가 같지 않습니다.");
    if (password.length < 8 || password.length > 72)
      return setError("비밀번호는 8자 이상 72자 이하로 입력해주세요.");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(data.error ?? "비밀번호를 바꾸지 못했습니다.");
      setDone(true);
      setPassword("");
      setAgain("");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="ACCOUNT"
        title="비밀번호 변경"
        description="새 비밀번호를 정하세요. 이 계정의 다른 기기 로그인은 유지됩니다."
      />
      <section className="panel settings-panel">
        <form onSubmit={submit} noValidate style={{ maxWidth: 380 }}>
          <div className="field">
            <label htmlFor="new-password">새 비밀번호</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <small>8자 이상 72자 이하</small>
          </div>
          <div className="field">
            <label htmlFor="new-password-again">새 비밀번호 확인</label>
            <input
              id="new-password-again"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="validation-list">
              {error}
            </p>
          )}
          {done && (
            <p role="status" className="success-message">
              비밀번호를 바꿨어요.
            </p>
          )}
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "처리 중…" : "비밀번호 변경"}
          </button>
        </form>
      </section>
    </>
  );
}