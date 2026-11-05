// Server-only Supabase access. The browser never talks to Supabase: it only calls this
// app's API routes, so no Supabase URL or key is ever shipped to the client, and the
// session cookies can be httpOnly.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export type SupabaseEnv = { url: string; key: string };

export function supabaseEnv(env = process.env): SupabaseEnv | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

/** Session cookie flags. `Secure` must stay off for http://localhost, on behind https. */
export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE === "true",
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
  | { mode: "account"; supabase: SupabaseClient; user: User; workspaceId: string };

/**
 * Resolves who is calling. `local` means no Supabase is configured (browser-only mode);
 * `anonymous` means configured but not logged in. The user is verified with the Auth
 * server (getUser), never trusted from the cookie alone.
 */
export async function getAccount(): Promise<Account> {
  const supabase = await serverClient();
  if (!supabase) return { mode: "local" };
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { mode: "anonymous" };
  const workspaceId = await ensureWorkspace(supabase, data.user);
  return { mode: "account", supabase, user: data.user, workspaceId };
}

/** First workspace of the user; created on first login (the DB trigger adds the owner membership). */
export async function ensureWorkspace(supabase: SupabaseClient, user: User): Promise<string> {
  const found = await supabase
    .from("memberships")
    .select("workspace_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (found.error) throw new Error("워크스페이스를 확인하지 못했습니다.");
  if (found.data?.[0]) return found.data[0].workspace_id as string;
  // The id is generated here: INSERT ... RETURNING would be filtered by the SELECT policy
  // before the membership trigger has made the user a member.
  const id = crypto.randomUUID();
  const created = await supabase
    .from("workspaces")
    .insert({ id, name: "나의 워크스페이스", owner_id: user.id });
  if (created.error) throw new Error("워크스페이스를 만들지 못했습니다.");
  return id;
}
