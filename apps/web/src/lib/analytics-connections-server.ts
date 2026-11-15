// Server side of the Google (GSC) connection: grant storage, property selection, disconnect + revoke.
// Everything goes through the session's own Supabase client and the 0023/0026 RPCs (no service role).
// The token is decrypted only inside these functions and never returned or logged.
import { randomUUID } from "node:crypto";
import type { Authed } from "./api";
import { ADSENSE_SCOPE, GSC_SCOPE, listAdsenseAccounts, listGscSites, refreshAccessToken, revokeToken, GoogleError, type AdsenseAccount, type GoogleConfig, type GscSite } from "./google-oauth";
import { decryptToken, encryptToken, reencryptToken, TokenCryptoError, type KeyRing } from "./token-crypto";

export class AnalyticsError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };

const RPC_ERRORS: [string, number, string, string][] = [
  ["ANALYTICS_FORBIDDEN", 403, "forbidden", "연결 관리는 소유자·관리자만 할 수 있습니다."],
  ["GRANT_OWNER_INACTIVE", 409, "grant_owner_inactive", "이 Google 연결을 만든 사람이 더 이상 관리자가 아닙니다. 다시 연결해주세요."],
  ["GRANT_IN_USE", 409, "grant_in_use", "아직 이 Google 연결을 쓰는 연결이 있습니다."],
  ["CONNECTION_NOT_ACTIVE", 409, "not_active", "다시 연결이 필요한 상태입니다."],
  ["CONNECTION_NOT_REVOKED", 409, "duplicate", "이미 연결된 속성입니다."],
];
function rpcFail(error: { message?: string } | null): AnalyticsError {
  const msg = error?.message ?? "";
  const hit = RPC_ERRORS.find(([k]) => msg.includes(k));
  return hit ? new AnalyticsError(hit[3], hit[1], hit[2]) : new AnalyticsError("연결 요청을 처리하지 못했습니다.", 500, "rpc_failed");
}
async function call<T>(db: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw rpcFail(error);
  return data as T;
}

type CredRow = { grant_id: string; ciphertext: string; key_version: number; workspace_id: string; google_sub: string };
const aadOfRow = (r: CredRow) => ({ grantId: r.grant_id, workspaceId: r.workspace_id, googleSub: r.google_sub });

/**
 * The ciphertext is bound to grant_id, so the app picks the id first. New grant: stored with that id.
 * Existing grant (same workspace, Google account, client): the database returns the existing id and keeps
 * its ciphertext; the token is then re-encrypted for that id and swapped with rotate_credential (compare-and-set).
 */
export async function storeGrant(account: Authed, ring: KeyRing, clientId: string, googleSub: string, refreshToken: string): Promise<string> {
  const ids = { workspaceId: account.workspaceId, googleSub };
  const mine = randomUUID();
  const first = encryptToken(ring, refreshToken, { ...ids, grantId: mine });
  const grantId = await call<string>(account.supabase, "store_credential", {
    p_workspace: account.workspaceId,
    p_grant_id: mine,
    p_google_sub: googleSub,
    p_client_id: clientId,
    p_ciphertext: first.ciphertext,
    p_key_version: first.keyVersion,
  });
  if (grantId === mine) return grantId;
  const rows = await call<CredRow[]>(account.supabase, "read_grant_credential", { p_grant: grantId });
  const row = rows?.[0];
  if (!row) throw new AnalyticsError("토큰을 저장하지 못했습니다. 다시 연결해주세요.", 500, "store_failed");
  const next = encryptToken(ring, refreshToken, { ...ids, grantId });
  const swapped = await call<boolean>(account.supabase, "rotate_credential", {
    p_grant: grantId,
    p_expected_version: row.key_version,
    p_ciphertext: next.ciphertext,
    p_new_version: next.keyVersion,
  });
  if (!swapped) throw new AnalyticsError("토큰을 저장하지 못했습니다. 다시 연결해주세요.", 409, "store_failed");
  return grantId;
}

/** The refresh token of a grant (owner/admin of its workspace only). */
export async function readRefreshToken(db: Rpc, ring: KeyRing, grantId: string, forRevoke = false): Promise<string> {
  // The revoke path works for any owner/admin and for a grant whose consenting admin is gone (no creator check).
  const rows = await call<CredRow[]>(db, forRevoke ? "read_grant_for_revoke" : "read_grant_credential", { p_grant: grantId });
  const row = rows?.[0];
  if (!row) throw new AnalyticsError("Google 연결을 찾을 수 없습니다.", 404, "grant_missing");
  try {
    return decryptToken(ring, row.ciphertext, row.key_version, aadOfRow(row)).token;
  } catch (e) {
    if (e instanceof TokenCryptoError) throw new AnalyticsError("저장된 Google 토큰을 읽지 못했습니다. 다시 연결해주세요.", 409, "token_unreadable");
    throw e;
  }
}

/** Key rotation: re-encrypts every grant of the workspace that is not on the newest key. Returns the count. */
export async function rotateGrants(db: Rpc, ring: KeyRing, workspaceId: string): Promise<{ rotated: number; skipped: number }> {
  const list = (await call<{ grant_id: string; key_version: number }[]>(db, "list_credential_versions", { p_workspace: workspaceId })) ?? [];
  let rotated = 0;
  let skipped = 0;
  for (const g of list) {
    if (g.key_version === ring.latest) continue;
    const rows = await call<CredRow[]>(db, "read_grant_credential", { p_grant: g.grant_id });
    const row = rows?.[0];
    const next = row && reencryptToken(ring, row.ciphertext, row.key_version, aadOfRow(row));
    if (!row || !next) {
      skipped++;
      continue;
    }
    const ok = await call<boolean>(db, "rotate_credential", { p_grant: g.grant_id, p_expected_version: row.key_version, p_ciphertext: next.ciphertext, p_new_version: next.keyVersion });
    if (ok) rotated++;
    else skipped++;
  }
  return { rotated, skipped };
}

async function accessFor(account: Authed, cfg: GoogleConfig, grantId: string): Promise<string> {
  const refresh = await readRefreshToken(account.supabase, cfg.ring, grantId);
  try {
    return await refreshAccessToken(cfg, refresh);
  } catch (e) {
    if (e instanceof GoogleError) {
      const status = e.code === "invalid_grant" ? 409 : 502;
      throw new AnalyticsError(e.message, status, e.code);
    }
    throw e;
  }
}

export async function sitesOfGrant(account: Authed, cfg: GoogleConfig, grantId: string): Promise<GscSite[]> {
  const access = await accessFor(account, cfg, grantId);
  try {
    return await listGscSites(cfg, access);
  } catch (e) {
    if (e instanceof GoogleError) throw new AnalyticsError(e.message, 502, e.code);
    throw e;
  }
}

export async function adsenseAccountsOfGrant(account: Authed, cfg: GoogleConfig, grantId: string): Promise<AdsenseAccount[]> {
  const access = await accessFor(account, cfg, grantId);
  try {
    return await listAdsenseAccounts(cfg, access);
  } catch (e) {
    if (e instanceof GoogleError) throw new AnalyticsError(e.message, 502, e.code);
    throw e;
  }
}

const COLUMNS = "id, blog_id, grant_id, provider, external_ref, status, last_attempt_at, last_success_at, last_error_code, created_at";
/** What the stored AdSense rows of a connection say: currency, time zone, and whether pages are available. */
export type AdsenseInfo = { currency: string | null; timezone: string | null; pageLevel: boolean | null };
export type ConnectionRow = {
  id: string;
  blog_id: string | null;
  grant_id: string | null;
  provider: string;
  external_ref: string;
  status: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  created_at: string;
  adsense?: AdsenseInfo;
};

/** Newest stored day of each AdSense connection: pageLevel false = Google refused PAGE_URL (per-article ROI is N/A). */
export async function adsenseInfos(account: Authed, connectionIds: string[]): Promise<Map<string, AdsenseInfo>> {
  const map = new Map<string, AdsenseInfo>();
  for (const id of connectionIds) {
    const { data } = await account.supabase
      .from("revenue_rows")
      .select("report_date, page, currency, timezone")
      .eq("workspace_id", account.workspaceId)
      .eq("connection_id", id)
      .eq("source", "adsense-api")
      .order("report_date", { ascending: false })
      .limit(500);
    const rows = (data ?? []) as { report_date: string; page: string; currency: string; timezone: string | null }[];
    if (!rows.length) {
      map.set(id, { currency: null, timezone: null, pageLevel: null });
      continue;
    }
    const day = rows.filter((r) => r.report_date === rows[0].report_date);
    map.set(id, { currency: rows[0].currency, timezone: rows[0].timezone, pageLevel: day.some((r) => r.page !== "") });
  }
  return map;
}

/** Connections (no token field) and the grants no connection uses: after a failed revoke those need a retry. */
export async function listConnections(account: Authed): Promise<{ connections: ConnectionRow[]; unusedGrants: string[] }> {
  const { data, error } = await account.supabase.from("analytics_connections").select(COLUMNS).eq("workspace_id", account.workspaceId).order("created_at");
  if (error) throw new AnalyticsError("연결 목록을 불러오지 못했습니다.", 500, "list_failed");
  const connections = (data ?? []) as ConnectionRow[];
  let unusedGrants: string[] = [];
  if (account.role === "owner" || account.role === "admin") {
    const grants = (await call<{ grant_id: string }[]>(account.supabase, "list_credential_versions", { p_workspace: account.workspaceId })) ?? [];
    const used = new Set(connections.map((c) => c.grant_id));
    unusedGrants = grants.map((g) => g.grant_id).filter((g) => !used.has(g));
  }
  return { connections, unusedGrants };
}

export async function createAdsenseConnection(account: Authed, cfg: GoogleConfig, input: { grantId: string; accountName: string }): Promise<ConnectionRow> {
  const accounts = await adsenseAccountsOfGrant(account, cfg, input.grantId);
  if (!accounts.some((a) => a.name === input.accountName)) throw new AnalyticsError("이 Google 계정에서 볼 수 없는 AdSense 계정입니다.", 400, "site_not_allowed");
  const { data: prior, error: priorError } = await account.supabase
    .from("analytics_connections")
    .select(COLUMNS)
    .eq("workspace_id", account.workspaceId)
    .eq("provider", "adsense")
    .eq("external_ref", input.accountName)
    .maybeSingle();
  if (priorError) throw new AnalyticsError("연결을 저장하지 못했습니다.", 500, "insert_failed");
  if ((prior as ConnectionRow | null)?.status === "revoked") return reconnectRevoked(account, prior as ConnectionRow, input.grantId, null);
  const { data, error } = await account.supabase
    .from("analytics_connections")
    .insert({ workspace_id: account.workspaceId, blog_id: null, grant_id: input.grantId, provider: "adsense", external_ref: input.accountName, scopes: [ADSENSE_SCOPE], connected_by: account.user.id })
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new AnalyticsError("이미 연결된 AdSense 계정이 있습니다. 워크스페이스당 AdSense 계정은 1개만 연결할 수 있습니다.", 409, "duplicate");
    if ((error.message ?? "").includes("GRANT_OWNER_INACTIVE")) throw rpcFail(error);
    if (error.code === "42501" || error.code === "PGRST116") throw new AnalyticsError("연결 관리는 소유자·관리자만 할 수 있습니다.", 403, "forbidden");
    throw new AnalyticsError("연결을 저장하지 못했습니다.", 500, "insert_failed");
  }
  return data as ConnectionRow;
}

export async function createGscConnection(account: Authed, cfg: GoogleConfig, input: { grantId: string; siteUrl: string; blogId: string | null }): Promise<ConnectionRow> {
  // The allow list is the sites the Google account can see with this grant (an app-side limit only).
  const sites = await sitesOfGrant(account, cfg, input.grantId);
  if (!sites.some((s) => s.siteUrl === input.siteUrl)) throw new AnalyticsError("이 Google 계정에서 볼 수 없는 속성입니다.", 400, "site_not_allowed");
  // A property disconnected earlier keeps its row (and imported data): bring that row back instead of inserting a duplicate.
  const { data: prior, error: priorError } = await account.supabase
    .from("analytics_connections")
    .select(COLUMNS)
    .eq("workspace_id", account.workspaceId)
    .eq("provider", "gsc")
    .eq("external_ref", input.siteUrl)
    .maybeSingle();
  if (priorError) throw new AnalyticsError("연결을 저장하지 못했습니다.", 500, "insert_failed");
  if ((prior as ConnectionRow | null)?.status === "revoked") return reconnectRevoked(account, prior as ConnectionRow, input.grantId, input.blogId);
  const { data, error } = await account.supabase
    .from("analytics_connections")
    .insert({
      workspace_id: account.workspaceId,
      blog_id: input.blogId,
      grant_id: input.grantId,
      provider: "gsc",
      external_ref: input.siteUrl,
      scopes: [GSC_SCOPE],
      connected_by: account.user.id,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new AnalyticsError("이미 연결된 속성이거나, 이 블로그에 이미 Search Console 연결이 있습니다.", 409, "duplicate");
    if (error.code === "23503") throw new AnalyticsError("이 워크스페이스의 블로그가 아닙니다.", 400, "blog_invalid");
    if ((error.message ?? "").includes("GRANT_OWNER_INACTIVE")) throw rpcFail(error);
    if (error.code === "42501" || error.code === "PGRST116") throw new AnalyticsError("연결 관리는 소유자·관리자만 할 수 있습니다.", 403, "forbidden");
    throw new AnalyticsError("연결을 저장하지 못했습니다.", 500, "insert_failed");
  }
  return data as ConnectionRow;
}

/**
 * Revived through reconnect_connection (rows and blog stay). Another blog is allowed only while no imported
 * rows are attached: the 0022 guard raises CONNECTION_HAS_DATA, shown as a hint to reuse the old blog or purge.
 */
export async function reconnectRevoked(account: Authed, prior: ConnectionRow, grantId: string, blogId: string | null): Promise<ConnectionRow> {
  if (blogId !== prior.blog_id) {
    const { error } = await account.supabase.from("analytics_connections").update({ blog_id: blogId }).eq("id", prior.id).eq("workspace_id", account.workspaceId);
    if (error) {
      if ((error.message ?? "").includes("CONNECTION_HAS_DATA") || error.code === "P0001") {
        let name = "다른 블로그";
        if (prior.blog_id) {
          const { data } = await account.supabase.from("blogs").select("display_name, domain").eq("id", prior.blog_id).maybeSingle();
          const b = data as { display_name: string | null; domain: string } | null;
          if (b) name = b.display_name || b.domain;
        } else name = "블로그 미지정 상태";
        throw new AnalyticsError(`이 속성은 이전에 ${name}에 연결되어 데이터가 남아 있습니다. 같은 블로그로 다시 연결하거나 해제 시 데이터 삭제를 선택하세요.`, 409, "has_data");
      }
      if (error.code === "23503") throw new AnalyticsError("이 워크스페이스의 블로그가 아닙니다.", 400, "blog_invalid");
      throw new AnalyticsError("연결을 저장하지 못했습니다.", 500, "insert_failed");
    }
  }
  await call<void>(account.supabase, "reconnect_connection", { p_connection: prior.id, p_grant: grantId });
  return { ...prior, blog_id: blogId, grant_id: grantId, status: "pending", last_error_code: null };
}

export type RevokeOutcome = "done" | "failed" | "kept";

/** Revokes at Google, then deletes the stored grant. A failure keeps the grant: nothing is deleted locally. */
export async function revokeGrant(account: Authed, cfg: GoogleConfig | null, grantId: string): Promise<RevokeOutcome> {
  if (!cfg) return "failed";
  let refresh: string;
  try {
    refresh = await readRefreshToken(account.supabase, cfg.ring, grantId, true);
  } catch (e) {
    if (e instanceof AnalyticsError && (e.code === "forbidden" || e.code === "grant_missing" || e.code === "grant_in_use")) throw e;
    return "failed";
  }
  if ((await revokeToken(cfg, refresh)) !== "ok") return "failed";
  await call<void>(account.supabase, "delete_credential", { p_grant: grantId });
  return "done";
}

export async function disconnect(account: Authed, cfg: GoogleConfig | null, connectionId: string, purge: boolean): Promise<{ revoke: RevokeOutcome; grantId: string | null; remaining: number }> {
  // disconnect_connection releases grant_id on a kept connection, so read it first.
  const { data, error } = await account.supabase.from("analytics_connections").select("grant_id").eq("id", connectionId).eq("workspace_id", account.workspaceId).maybeSingle();
  if (error) throw new AnalyticsError("연결을 찾지 못했습니다.", 500, "read_failed");
  if (!data) throw new AnalyticsError("연결을 찾을 수 없습니다.", 404, "not_found");
  const grantId = (data as { grant_id: string | null }).grant_id;
  const left = await call<number>(account.supabase, "disconnect_connection", { p_connection: connectionId, p_purge: purge });
  if (!grantId || left > 0) return { revoke: "kept", grantId, remaining: left ?? 0 };
  return { revoke: await revokeGrant(account, cfg, grantId), grantId, remaining: 0 };
}
