import { useState } from "react";
import { session } from "../app-context.ts";

export function AccountScreen({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await session.logout();
    onSignedOut();
  }

  return (
    <section>
      <header className="bar">
        <h1>계정</h1>
      </header>
      <div className="card">
        <p>{email}</p>
        <p className="muted">이 앱은 읽기 전용입니다. 편집·승인·발행은 웹에서 합니다.</p>
        <button type="button" onClick={() => void logout()} disabled={busy}>
          로그아웃
        </button>
      </div>
    </section>
  );
}
