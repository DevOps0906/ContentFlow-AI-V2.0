import { useState, type FormEvent } from "react";
import { session } from "../app-context.ts";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await session.login(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell center">
      <form className="card login" onSubmit={submit}>
        <h1>ContentFlow</h1>
        <label>
          이메일
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "로그인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
