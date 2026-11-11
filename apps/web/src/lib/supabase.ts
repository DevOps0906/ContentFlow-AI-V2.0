// Server-only Supabase access. The browser never talks to Supabase: it only calls this
// app's API routes, so no Supabase URL or key is ever shipped to the client, and the
// session cookies can be httpOnly.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, mobileOriginIssues, WORKSPACE_HEADER } from "./mobile";
import { WORKSPACE_COOKIE_NAME, type Role } from "./team";
import { cookieSecure, supabaseTarget } from "./supabase-target";

export type SupabaseEnv = { url: string; key: string };

export function supabaseEnv(env = process.env): SupabaseEnv | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return null;
  // A cloud Supabase over plain http would send keys and sessions in the clear: stay in local mode.
  if (supabaseTarget(env) === "cloud" && !url.startsWith("https://")) return null;
  // Cloud must not trust plain-http mobile origins: refuse account mode until fixed.
  if (supabaseTarget(env) === "cloud" && mobileOriginIssues(env).length) return null;
  return { url, key };
}

/**
 * Session cookie flags. `Secure` must stay off for http://localhost, on behind https.
 * COOKIE_SECURE wins when set; unset defaults to true for a cloud Supabase.
 */
export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure(env),
    path: "/",
  };
}

export async function serverClient(): Promise<SupabaseClient | null> {
  const env = supabaseEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list)
            store.set(name, value, { ...options, ...sessionCookieOptions() });
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}


export type Account =
  | { mode: "local" }
  | { mode: "anonymous" }
  | { mode: "account"; supabase: SupabaseClient; user: User; workspaceId: string; role: Role };

/**
 * Resolves who is calling. `local` means no Supabase is configured (browser-only mode);
 * `anonymous` means configured but not logged in. The user is verified with the Auth
 * server (getUser), never trusted from the cookie alone. The active workspace comes from a
 * cookie but is only honoured if the user is really a member of it.
 */
export async function getAccount(opts: { bearer?: boolean } = {}): Promise<Account> {
  const env = supabaseEnv();
  if (!env) return { mode: "local" };
  const token = bearerToken(await headers());
  if (token !== null) {
    // A Bearer header means the mobile app: cookies are never read, and a bad or disallowed
    // token is anonymous (no cookie fallback).
    if (!opts.bearer || !token) return { mode: "anonymous" };
    const client = bearerClient(env, token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return { mode: "anonymous" };
    const wanted = (await headers()).get(WORKSPACE_HEADER)?.trim() || null;
    const ws = await activeWorkspace(client, data.user, { wanted });
    return { mode: "account", supabase: client, user: data.user, workspaceId: ws.id, role: ws.role };
  }
  const supabase = await serverClient();
  if (!supabase) return { mode: "local" };
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { mode: "anonymous" };
  const ws = await activeWorkspace(supabase, data.user);
  return { mode: "account", supabase, user: data.user, workspaceId: ws.id, role: ws.role };
}

/** Stateless client without a cookie adapter: RLS sees the caller through the Authorization header. */
export function bearerClient(env: SupabaseEnv, token?: string): SupabaseClient {
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}

/** Bearer workspace problem with the HTTP status to answer (409 none yet, 403 not a member). */
export class WorkspaceError extends Error {
  constructor(
    readonly status: 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type MembershipRow = { workspace_id: string; role: Role };

export async function activeWorkspace(supabase: SupabaseClient, user: User, bearer?: { wanted: string | null }): Promise<{ id: string; role: Role }> {
  const found = await supabase
    .from("memberships")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (found.error) throw new Error("워크스페이스를 확인하지 못했습니다.");
  const list = (found.data ?? []) as MembershipRow[];
  if (bearer) {
    // Mobile: the cookie is never read, a workspace is never created, and a named workspace the
    // caller is not a member of is refused instead of silently replaced.
    if (!list.length) throw new WorkspaceError(409, "웹에서 먼저 로그인해 워크스페이스를 만드세요");
    const hit = bearer.wanted ? list.find((m) => m.workspace_id === bearer.wanted) : list[0];
    if (!hit) throw new WorkspaceError(403, "접근할 수 없는 워크스페이스입니다.");
    return { id: hit.workspace_id, role: hit.role };
  }
  const wanted = (await cookies()).get(WORKSPACE_COOKIE_NAME)?.value;
  const hit = list.find((m) => m.workspace_id === wanted) ?? list[0];
  if (hit) return { id: hit.workspace_id, role: hit.role };
  // First login: the id is generated here because INSERT ... RETURNING would be filtered by
  // the SELECT policy before the membership trigger has made the user a member.
  const id = crypto.randomUUID();
  const created = await supabase
    .from("workspaces")
    .insert({ id, name: "나의 워크스페이스", owner_id: user.id });
  if (created.error) throw new Error("워크스페이스를 만들지 못했습니다.");
  return { id, role: "owner" };
}