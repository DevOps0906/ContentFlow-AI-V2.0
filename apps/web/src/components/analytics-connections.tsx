"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Unplug } from "lucide-react";
import { blogName, type Blog } from "@/lib/blogs";
import {
  adsenseLines,
  ga4Lines,
  connectionStatusClass,
  connectionStatusLabels,
  googleErrorMessage,
  isAutoSyncDue,
  parseConnections,
  runSummary,
  syncErrorMessage,
  type ConnectionView,
} from "@/lib/analytics-connections-view";
import { useBlogs } from "./blog-filter";
import { useFeedback } from "./feedback";

type Listing = { configured: boolean; canManage: boolean; connections: ConnectionView[]; unusedGrants: string[] };
type Site = { siteUrl: string; permissionLevel?: string; label?: string };
type Provider = "gsc" | "adsense" | "ga4";
const providerName = (p: string) => (p === "adsense" ? "AdSense" : p === "ga4" ? "Google Analytics 4" : "Search Console");
const asProvider = (p: string): Provider => (p === "adsense" || p === "ga4" ? p : "gsc");

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `요청에 실패했습니다(${res.status}).`);
  return data as T;
}

const when = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("ko-KR") : "없음");

/** Disconnect dialog: the imported rows stay by default (D4); deleting them is an explicit choice. */
function DisconnectDialog({ target, shared, busy, onCancel, onConfirm }: { target: ConnectionView; shared: boolean; busy: boolean; onCancel: () => void; onConfirm: (purge: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [purge, setPurge] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="disconnect-title"
        aria-describedby="disconnect-desc"
        className="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key !== "Tab") return;
          const els = ref.current?.querySelectorAll<HTMLElement>("button, input");
          if (!els?.length) return;
          const first = els[0];
          const last = els[els.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="disconnect-title">{providerName(target.provider)} 연결을 해제할까요?</h2>
        <p id="disconnect-desc">
          {target.external_ref} 연결만 끊습니다. 이 Google 계정으로 연결된 마지막 연결이면 Google 권한 철회까지 함께 진행합니다. 이미 가져온 데이터는 기본적으로 남고 &quot;연결 해제됨&quot;으로
          표시됩니다.
        </p>
        {shared && target.provider !== "gsc" && (
          <p className="metric-note">
            Google 쪽 {providerName(target.provider)} 읽기 권한은 같은 Google 계정의 다른 연결이 남아 있어 철회되지 않습니다. 완전히 철회하려면 Google 계정 권한 페이지에서 제거하세요.
          </p>
        )}
        <label className="conn-check">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          가져온 데이터도 삭제(이 연결의 API 데이터만, CSV·수동 입력은 유지)
        </label>
        <div className="editor-actions">
          <button ref={cancelRef} className="button secondary" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="button danger" onClick={() => onConfirm(purge)} disabled={busy}>
            {busy ? "해제 중…" : "연결 해제"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Search Console connection panel (settings, account mode). Members read; owner/admin connect, sync and disconnect. */
export function AnalyticsConnections({ account }: { account: boolean }) {
  const { blogs } = useBlogs(account);
  const { toast } = useFeedback();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<{ provider: Provider; grant: string; sites: Site[] | null; site: string; blog: string } | null>(null);
  const [removing, setRemoving] = useState<ConnectionView | null>(null);
  const [visible, setVisible] = useState(true);
  const tried = useRef(new Set<string>());
  const pickerRef = useRef<HTMLSelectElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await call<Partial<Listing>>("/api/analytics/connections");
      setData({
        configured: d.configured === true,
        canManage: d.canManage === true,
        connections: parseConnections(d.connections),
        unusedGrants: Array.isArray(d.unusedGrants) ? d.unusedGrants : [],
      });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결 목록을 불러오지 못했습니다.");
    }
  }, []);
  useEffect(() => {
    if (account) load();
  }, [account, load]);

  const openPicker = useCallback(async (grant: string, provider: Provider) => {
    setPicker({ provider, grant, sites: null, site: "", blog: "" });
    try {
      const q = `grant=${encodeURIComponent(grant)}${provider === "gsc" ? "" : `&provider=${provider}`}`;
      const r = await call<{ sites?: Site[]; accounts?: { name: string; displayName: string }[]; properties?: { name: string; displayName: string; account?: string }[] }>(`/api/integrations/google/sites?${q}`);
      const sites: Site[] =
        provider === "adsense"
          ? (r.accounts ?? []).map((a) => ({ siteUrl: a.name, label: a.displayName ? `${a.displayName} (${a.name})` : a.name }))
          : provider === "ga4"
            ? (r.properties ?? []).map((p) => ({ siteUrl: p.name, label: `${p.displayName || p.name}${p.account ? ` · ${p.account}` : ""} (${p.name})` }))
            : (r.sites ?? []);
      setPicker({ provider, grant, sites, site: sites[0]?.siteUrl ?? "", blog: "" });
    } catch (e) {
      setPicker(null);
      setError(e instanceof Error ? e.message : "속성 목록을 불러오지 못했습니다.");
    }
  }, []);

  // The consent callback returns to /settings?google=connected&grant=... or ?google=error&reason=...
  useEffect(() => {
    if (!account) return;
    const q = new URLSearchParams(window.location.search);
    const g = q.get("google");
    if (!g) return;
    const grant = q.get("grant");
    const reason = q.get("reason");
    const provider = asProvider(q.get("provider") ?? "");
    for (const k of ["google", "grant", "reason", "provider"]) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    if (g === "connected" && grant) void openPicker(grant, provider);
    else setError(googleErrorMessage(reason));
  }, [account, openPicker]);
  useEffect(() => {
    if (picker?.sites) pickerRef.current?.focus();
  }, [picker?.sites]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const sync = useCallback(
    async (c: ConnectionView, manual: boolean) => {
      setSyncing((s) => ({ ...s, [c.id]: true }));
      setNotes((n) => ({ ...n, [c.id]: "" }));
      try {
        const res = await fetch(`/api/analytics/connections/${c.id}/sync`, { method: "POST" });
        const body = (await res.json().catch(() => null)) as { status?: string; code?: string } | null;
        if (res.ok) {
          if (manual) toast(body?.status === "partial" ? "일부 데이터만 가져왔어요." : "동기화했어요.");
          await load();
        } else {
          // 403/409 are shown as state next to the connection, never as a page error.
          setNotes((n) => ({ ...n, [c.id]: syncErrorMessage(body?.code, res.status) }));
          if (res.status !== 403 || body?.code === "NEEDS_REAUTH") await load();
        }
      } catch {
        setNotes((n) => ({ ...n, [c.id]: "네트워크 오류로 동기화하지 못했습니다." }));
      } finally {
        setSyncing((s) => ({ ...s, [c.id]: false }));
      }
    },
    [load, toast],
  );

  // Session-based refresh: once per connection per page visit, only while the panel is visible.
  useEffect(() => {
    if (!data?.canManage || !visible) return;
    const now = Date.now();
    for (const c of data.connections) {
      if (tried.current.has(c.id) || !isAutoSyncDue(c, now)) continue;
      tried.current.add(c.id);
      void sync(c, false);
    }
  }, [data, visible, sync]);

  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const startConsent = (provider: Provider) =>
    act(async () => {
      const r = await call<{ url: string }>("/api/integrations/google/start", { method: "POST", body: JSON.stringify({ provider }) });
      window.location.assign(r.url);
    });

  if (!account)
    return (
      <p className="metric-note">
        로컬 모드에서는 Google 연결을 사용할 수 없습니다. 계정 모드(로그인)에서 Search Console·AdSense·GA4를 연결할 수 있습니다. 연결 전까지 광고·검색 성과는 N/A입니다.
      </p>
    );
  if (!data && !error) return <p className="metric-note">연결 정보를 불러오고 있어요.</p>;

  const manage = data?.canManage === true;
  const connections = data?.connections ?? [];
  const blogById = (id: string | null): Blog | undefined => (id ? blogs.find((b) => b.id === id) : undefined);
  const blogLabel = (id: string | null) => (id ? (blogById(id) ? blogName(blogById(id)!) : "알 수 없는 블로그") : "블로그 미지정");
  const adsenseConns = connections.filter((c) => c.provider === "adsense" && c.status !== "revoked");
  const ga4Conns = connections.filter((c) => c.provider === "ga4" && c.status !== "revoked");
  const usedBlogs = new Set(connections.filter((c) => c.provider === (picker?.provider ?? "gsc") && c.status !== "revoked").map((c) => c.blog_id));

  return (
    <>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <p className="metric-note">
        동기화는 이 화면이 열려 있을 때만 일어납니다(자동 수집 아님). Search Console은 전체 사이트 읽기 권한으로 연결되며, 앱에는 선택한 속성만 표시합니다. 같은 기간에 CSV와 API 데이터가 모두
        있습니다. 두 값은 합치지 않고 출처별로 보여줍니다.
      </p>
      <p className="metric-note">
        파일럿은 Google 동의 화면을 &quot;테스트&quot; 상태로 운영해 연결이 7일 뒤 만료될 수 있습니다. 만료되면 &quot;재연결 필요&quot;로 표시됩니다.
      </p>

      <div className="conn-grid">
        <section className="conn-card" aria-label="Google Search Console">
          <div className="conn-head">
            <b>Google Search Console</b>
            <span className={`status ${data?.configured && connections.some((c) => c.provider === "gsc") ? "approve" : "write"}`}>
              {data?.configured && connections.some((c) => c.provider === "gsc") ? "연결됨" : "연결 안 됨"}
            </span>
          </div>
          {!data?.configured && <p className="metric-note">서버에 Google 연결이 설정되지 않았습니다(GOOGLE_OAUTH_CLIENT_ID/SECRET 필요). 설정 전까지 성과는 N/A입니다.</p>}
          {data?.configured && !connections.some((c) => c.provider === "gsc") && !picker && <p className="metric-note">연결된 속성이 없습니다. 연결하면 페이지별 일 단위 성과를 가져옵니다.</p>}
          {manage ? (
            <div className="editor-actions">
              <button className="button primary" onClick={() => startConsent("gsc")} disabled={busy || !data?.configured}>
                Google 계정 연결
              </button>
            </div>
          ) : (
            <p className="metric-note">연결과 해제는 소유자·관리자만 할 수 있습니다.</p>
          )}
        </section>
        <section className="conn-card" aria-label="Google AdSense">
          <div className="conn-head">
            <b>Google AdSense</b>
            <span className={`status ${data?.configured && adsenseConns.length ? "approve" : "write"}`}>{data?.configured && adsenseConns.length ? "연결됨" : "연결 안 됨"}</span>
          </div>
          <p className="metric-note">
            AdSense 읽기 권한만 따로 동의합니다(Search Console 연결과 별개). 가져온 수익은 추정치이며 확정 수익으로 표시하지 않습니다. 연결 전까지 수익은 N/A입니다.
          </p>
          {manage ? (
            <div className="editor-actions">
              <button className="button primary" onClick={() => startConsent("adsense")} disabled={busy || !data?.configured || adsenseConns.length > 0}>
                AdSense 연결
              </button>
            </div>
          ) : (
            <p className="metric-note">연결과 해제는 소유자·관리자만 할 수 있습니다.</p>
          )}
        </section>
        <section className="conn-card" aria-label="Google Analytics 4">
          <div className="conn-head">
            <b>Google Analytics 4</b>
            <span className={`status ${data?.configured && ga4Conns.length ? "approve" : "write"}`}>{data?.configured && ga4Conns.length ? "연결됨" : "연결 안 됨"}</span>
          </div>
          <p className="metric-note">
            Analytics 읽기 권한만 따로 동의합니다(다른 연결과 별개). 조회수·세션·활성 사용자를 페이지·일 단위로 가져오며 RPM 계산에는 쓰지 않습니다. 연결 전까지 방문 지표는 N/A입니다.
          </p>
          {manage ? (
            <div className="editor-actions">
              <button className="button primary" onClick={() => startConsent("ga4")} disabled={busy || !data?.configured}>
                GA4 연결
              </button>
            </div>
          ) : (
            <p className="metric-note">연결과 해제는 소유자·관리자만 할 수 있습니다.</p>
          )}
        </section>
      </div>

      {picker && manage && (
        <form
          className="conn-picker"
          aria-label={picker.provider === "adsense" ? "AdSense 계정 선택" : picker.provider === "ga4" ? "GA4 속성 선택" : "Search Console 속성 선택"}
          onSubmit={(e) => {
            e.preventDefault();
            if (!picker.site) return;
            act(async () => {
              await call("/api/analytics/connections", {
                method: "POST",
                body: JSON.stringify(
                  picker.provider === "adsense"
                    ? { provider: "adsense", grantId: picker.grant, accountName: picker.site }
                    : picker.provider === "ga4"
                      ? { provider: "ga4", grantId: picker.grant, propertyName: picker.site, blogId: picker.blog || null }
                      : { grantId: picker.grant, siteUrl: picker.site, blogId: picker.blog || null },
                ),
              });
              setPicker(null);
              toast(`${providerName(picker.provider)} 연결을 저장했어요.`);
              await load();
            });
          }}
        >
          {picker.sites === null ? (
            <p className="metric-note" role="status">
              속성 목록을 불러오고 있어요.
            </p>
          ) : picker.sites.length === 0 ? (
            <>
              <p className="metric-note">이 Google 계정에서 볼 수 있는 {providerName(picker.provider)} {picker.provider === "adsense" ? "계정" : "속성"}이 없습니다.</p>
              <div className="editor-actions">
                <button type="button" className="button secondary" onClick={() => setPicker(null)}>
                  닫기
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="conn-site">{picker.provider === "adsense" ? "연결할 AdSense 계정" : "연결할 속성"}</label>
                <select id="conn-site" ref={pickerRef} value={picker.site} disabled={busy} onChange={(e) => setPicker({ ...picker, site: e.target.value })}>
                  {picker.sites.map((s) => (
                    <option key={s.siteUrl} value={s.siteUrl}>
                      {s.label ?? s.siteUrl}
                    </option>
                  ))}
                </select>
              </div>
              {picker.provider !== "adsense" && (
              <div className="field">
                <label htmlFor="conn-blog">블로그 계정(선택)</label>
                <select id="conn-blog" value={picker.blog} disabled={busy} onChange={(e) => setPicker({ ...picker, blog: e.target.value })}>
                  <option value="">미지정</option>
                  {blogs
                    .filter((b) => b.status === "active" && !usedBlogs.has(b.id))
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {blogName(b)}
                      </option>
                    ))}
                </select>
              </div>
              )}
              <div className="editor-actions">
                <button type="submit" className="button primary" disabled={busy || !picker.site}>
                  {busy ? "연결 중…" : picker.provider === "adsense" ? "계정 연결" : "속성 연결"}
                </button>
                <button type="button" className="button secondary" disabled={busy} onClick={() => setPicker(null)}>
                  취소
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {manage && (data?.unusedGrants.length ?? 0) > 0 && (
        <div className="invite-box" role="region" aria-label="Google 권한 철회 대기">
          <b>Google 권한 철회가 끝나지 않았습니다</b>
          {data!.unusedGrants.map((g) => (
            <div className="invite-row" key={g}>
              <span>연결 없이 보관 중인 Google 권한이 있습니다. 다시 철회하거나 Google 계정의 서드파티 연결에서 직접 철회해주세요.</span>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const r = await call<{ revoke: string; notice?: string }>(`/api/integrations/google/grants/${g}/revoke`, { method: "POST" });
                    if (r.revoke === "failed") setError(r.notice ?? "Google이 철회 요청을 받지 않았습니다. 다시 시도해주세요.");
                    else toast("Google 권한을 철회했어요.");
                    await load();
                  })
                }
              >
                철회 다시 시도
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className="team-heading">연결된 속성</h3>
      {connections.length === 0 ? (
        <p className="metric-note">연결된 속성이 없습니다.</p>
      ) : (
        <ul className="conn-list">
          {connections.map((c) => {
            const last = runSummary(c.lastRun);
            const isBusy = syncing[c.id] === true;
            const needsReauth = c.status === "needs_reauth";
            return (
              <li key={c.id} className="conn-item">
                <div className="conn-head">
                  <b className="conn-site">
                    {providerName(c.provider)} · {c.external_ref}
                  </b>
                  <span className={`status ${connectionStatusClass(c.status)}`}>{connectionStatusLabels[c.status] ?? c.status}</span>
                </div>
                <dl className="detail-list conn-detail">
                  <dt>블로그</dt>
                  <dd>{blogLabel(c.blog_id)}</dd>
                  <dt>마지막 동기화</dt>
                  <dd>{when(c.last_success_at)}</dd>
                  <dt>최근 실행</dt>
                  <dd>
                    {last.label}
                    {c.lastRun?.finishedAt ? ` · ${when(c.lastRun.finishedAt)}` : ""} · {last.rows}
                    {last.failed && c.lastRun?.errorCode ? ` · ${c.lastRun.errorCode}` : ""}
                  </dd>
                </dl>
                {c.provider === "adsense" &&
                  adsenseLines(c.adsense).map((line) => (
                    <p key={line} className="metric-note">
                      {line}
                    </p>
                  ))}
                {c.provider === "ga4" &&
                  ga4Lines().map((line) => (
                    <p key={line} className="metric-note">
                      {line}
                    </p>
                  ))}
                {last.partial && <p className="metric-note">일부 데이터만 가져왔습니다. 합계에서 완전한 데이터로 취급하지 않습니다.</p>}
                {c.status === "revoked" && <p className="metric-note">연결이 해제되었습니다. 이전에 가져온 데이터는 남아 있을 수 있습니다.</p>}
                {c.status === "error" && <p className="metric-note">마지막 동기화가 실패했습니다. 15분 뒤에 다시 동기화할 수 있습니다.</p>}
                {needsReauth && <p className="metric-note">Google 권한이 만료되었거나 취소되었습니다. 다시 연결하면 이어서 가져옵니다.</p>}
                {notes[c.id] && (
                  <p role="status" className="metric-note">
                    {notes[c.id]}
                  </p>
                )}
                {manage && c.status !== "revoked" && (
                  <div className="editor-actions">
                    {needsReauth ? (
                      <button className="button primary" onClick={() => startConsent(asProvider(c.provider))} disabled={busy || !data?.configured}>
                        다시 연결
                      </button>
                    ) : (
                      <button className="button secondary" onClick={() => sync(c, true)} disabled={isBusy}>
                        <RefreshCw size={14} />
                        {isBusy ? "동기화 중…" : "지금 동기화"}
                      </button>
                    )}
                    <button className="button secondary" onClick={() => setRemoving(c)} disabled={busy}>
                      <Unplug size={14} />
                      연결 해제
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <DisconnectDialog
          target={removing}
          shared={connections.some((o) => o.id !== removing.id && o.grant_id && o.grant_id === removing.grant_id && o.status !== "revoked")}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={(purge) =>
            act(async () => {
              const r = await call<{ revoke: string; remaining?: number; notice?: string }>(`/api/analytics/connections/${removing.id}`, {
                method: "DELETE",
                body: JSON.stringify({ purge }),
              });
              setRemoving(null);
              if (r.revoke === "failed") setError(r.notice ?? "연결은 해제했지만 Google 권한 철회에 실패했습니다. 다시 시도해주세요.");
              else if (r.revoke === "kept" && (r.remaining ?? 0) > 0 && removing.provider === "adsense")
                toast("연결을 해제했어요. Google 쪽 AdSense 읽기 권한은 다른 연결이 남아 있어 철회되지 않았습니다. Google 계정 권한 페이지에서 제거하세요.");
              else toast("연결을 해제했어요.");
              await load();
            })
          }
        />
      )}
    </>
  );
}
