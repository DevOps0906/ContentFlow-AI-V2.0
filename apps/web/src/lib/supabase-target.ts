import { mobileOriginIssues } from "./mobile";

// Pure classification of which Supabase the app points at. No Next.js imports, so it is
// testable and safe to use from route handlers. Never returns values, only names.
export type SupabaseTarget = "none" | "local" | "cloud";

export const SUPABASE_TARGET_LABEL: Record<SupabaseTarget, string> = {
  none: "로컬 모드",
  local: "Docker 로컬 Supabase",
  cloud: "Supabase Cloud",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function supabaseTarget(env = process.env): SupabaseTarget {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return "none";
  const host = hostOf(url);
  return host && LOCAL_HOSTS.has(host) ? "local" : "cloud";
}

function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

/** COOKIE_SECURE: "true"/"1" (any case) on, other values off, unset = on for cloud. */
export function cookieSecure(env = process.env): boolean {
  const flag = env.COOKIE_SECURE?.trim().toLowerCase();
  if (!flag) return supabaseTarget(env) === "cloud";
  return flag === "true" || flag === "1";
}

/** Names of the problems (never the values). Empty list = nothing to fix. */
export function supabaseConfigIssues(env = process.env): string[] {
  const issues: string[] = [];
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (key && isSecretKey(key)) issues.push("SUPABASE_PUBLISHABLE_KEY에 secret/service_role 키 사용 금지");
  if (supabaseTarget(env) !== "cloud") return issues;
  const url = env.SUPABASE_URL?.trim() ?? "";
  if (!url.startsWith("https://")) issues.push("SUPABASE_URL은 https여야 함(계정 모드 비활성)");
  const app = env.APP_URL?.trim();
  if (!app) issues.push("APP_URL 필요");
  else if (!app.startsWith("https://")) issues.push("APP_URL은 https여야 함");
  if (!cookieSecure(env)) issues.push("COOKIE_SECURE가 꺼져 있음(cloud는 true 필요)");
  issues.push(...mobileOriginIssues(env));
  return issues;
}
