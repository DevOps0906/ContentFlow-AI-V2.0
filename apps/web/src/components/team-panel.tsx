"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Mail, Trash2, UserPlus } from "lucide-react";
import {
  canManageMember,
  roleHelp,
  roleLabels,
  type Role,
} from "@/lib/team";
import { ConfirmDialog } from "./dialog";
import { useFeedback } from "./feedback";

type Member = { userId: string; email: string; role: Role; joinedAt: string };
type Invitation = { id: string; email: string; role: Role; created_at: string };
type Team = { role: Role; me: string; grantable: Role[]; members: Member[]; invitations: Invitation[] };
type Mine = { id: string; workspaceName: string; role: Role; invitedBy: string };
type Workspace = { id: string; name: string; role: Role };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `요청에 실패했습니다(${res.status}).`);
  return data as T;
}

/** Members, invitations and workspace switching for the active workspace (account mode). */
export function TeamPanel() {
  const [team, setTeam] = useState<Team | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [spaces, setSpaces] = useState<{ active: string; workspaces: Workspace[] } | null>(null);
  const [message, setMessage] = useState("");
  const { toast } = useFeedback();
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m, w] = await Promise.all([
        call<Team>("/api/team"),
        call<{ invitations: Mine[] }>("/api/invitations"),
        call<{ active: string; workspaces: Workspace[] }>("/api/workspaces"),
      ]);
      setTeam(t);
      setMine(m.invitations);
      setSpaces(w);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "팀 정보를 불러오지 못했습니다.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  /** A returned string is a plain success (toast). `{ inline }` is a note the operator must be able to re-read. */
  async function run(fn: () => Promise<string | { inline: string } | void>, reload = true) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const done = await fn();
      if (typeof done === "string") toast(done);
      else if (done) setMessage(done.inline);
      if (reload) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const switchTo = (id: string) =>
    run(async () => {
      await call("/api/workspaces/active", { method: "POST", body: JSON.stringify({ id }) });
      window.location.assign("/settings");
    }, false);

  if (!team && !error) return <p className="metric-note">팀 정보를 불러오고 있어요.</p>;
  const manage = team ? team.grantable.length > 0 : false;

  return (
    <>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success-message">
          {message}
        </p>
      )}

      {mine.length > 0 && (
        <div className="invite-box" role="region" aria-label="받은 초대">
          <b>
            <Mail size={14} /> 받은 초대
          </b>
          {mine.map((i) => (
            <div className="invite-row" key={i.id}>
              <span>
                <b>{i.workspaceName}</b> · {roleLabels[i.role]} 역할 · {i.invitedBy} 님이 초대
              </span>
              <span className="table-actions">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await call(`/api/team/invitations/${i.id}/accept`, { method: "POST" });
                      window.location.assign("/settings");
                    }, false)
                  }
                >
                  수락
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await call(`/api/team/invitations/${i.id}`, { method: "DELETE" });
                      return "초대를 거절했어요.";
                    })
                  }
                >
                  거절
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {spaces && spaces.workspaces.length > 1 && (
        <div className="field">
          <label htmlFor="ws-switch">워크스페이스 전환</label>
          <select id="ws-switch" value={spaces.active} disabled={busy} onChange={(e) => switchTo(e.target.value)}>
            {spaces.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {roleLabels[w.role]}
              </option>
            ))}
          </select>
        </div>
      )}

      {team && (
        <>
          <p className="metric-note">
            내 역할: <b>{roleLabels[team.role]}</b> — {roleHelp[team.role]}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">멤버</th>
                  <th scope="col">역할</th>
                  <th scope="col">
                    <span className="sr-only">작업</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.members.map((m) => {
                  const editable = manage && canManageMember(team.role, m.role) && m.userId !== team.me;
                  const leaving = m.userId === team.me && m.role !== "owner";
                  return (
                    <tr key={m.userId}>
                      <td>
                        {m.email}
                        {m.userId === team.me && <small> (나)</small>}
                      </td>
                      <td>
                        {editable ? (
                          <select
                            aria-label={`${m.email} 역할`}
                            value={m.role}
                            disabled={busy}
                            onChange={(e) =>
                              run(async () => {
                                await call(`/api/team/members/${m.userId}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ role: e.target.value }),
                                });
                                return `${m.email}의 역할을 ${roleLabels[e.target.value as Role]}(으)로 바꿨어요.`;
                              })
                            }
                          >
                            {[m.role, ...team.grantable.filter((r) => r !== m.role)].map((r) => (
                              <option key={r} value={r}>
                                {roleLabels[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          roleLabels[m.role]
                        )}
                      </td>
                      <td>
                        {(editable || leaving) && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            aria-label={leaving ? "이 워크스페이스에서 나가기" : `${m.email} 내보내기`}
                            onClick={() => setRemoving(m)}
                          >
                            <Trash2 size={14} /> {leaving ? "나가기" : "내보내기"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {manage && (
            <>
              <h3 className="team-heading">멤버 초대</h3>
              <form
                className="revenue-form"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  run(async () => {
                    await call("/api/team/invite", { method: "POST", body: JSON.stringify({ email, role }) });
                    setEmail("");
                    return { inline: `${email.trim()} 님을 초대했어요. 이 이메일로 가입하거나 로그인하면 초대가 보여요(이메일은 발송되지 않아요).` };
                  });
                }}
              >
                <div className="field">
                  <label htmlFor="invite-email">이메일</label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="invite-role">역할</label>
                  <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {team.grantable.map((r) => (
                      <option key={r} value={r}>
                        {roleLabels[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="sr-only" htmlFor="invite-go">
                    초대 보내기
                  </label>
                  <button id="invite-go" className="button primary" type="submit" disabled={busy || !email.trim()}>
                    <UserPlus size={15} /> 초대
                  </button>
                </div>
              </form>
              <p className="metric-note">{roleHelp[role]}</p>
              {team.invitations.length > 0 && (
                <ul className="invite-list">
                  {team.invitations.map((i) => (
                    <li key={i.id}>
                      {i.email} · {roleLabels[i.role]} · 대기 중
                      <button
                        className="button secondary"
                        disabled={busy}
                        aria-label={`${i.email} 초대 취소`}
                        onClick={() =>
                          run(async () => {
                            await call(`/api/team/invitations/${i.id}`, { method: "DELETE" });
                            return "초대를 취소했어요.";
                          })
                        }
                      >
                        취소
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      {removing && team && (
        <ConfirmDialog
          title={removing.userId === team.me ? "이 워크스페이스에서 나갈까요?" : `${removing.email} 님을 내보낼까요?`}
          description={
            removing.userId === team.me
              ? "나가면 이 워크스페이스의 콘텐츠에 접근할 수 없습니다. 다시 참여하려면 새 초대가 필요해요."
              : "내보내면 이 멤버는 즉시 이 워크스페이스에 접근할 수 없습니다. 작성한 콘텐츠는 남습니다."
          }
          danger
          confirmLabel={removing.userId === team.me ? "나가기" : "내보내기"}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const m = removing;
            setRemoving(null);
            run(async () => {
              await call(`/api/team/members/${m.userId}`, { method: "DELETE" });
              if (m.userId === team.me) window.location.assign("/");
              return `${m.email}님을 내보냈어요.`;
            });
          }}
        />
      )}
    </>
  );
}