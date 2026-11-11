// Pure helpers for the mobile app's Bearer session (read-only). No Next.js imports, so the
// proxy, the routes and the tests share them.
export const DEFAULT_MOBILE_ORIGINS = "https://localhost,capacitor://localhost";
export const WORKSPACE_HEADER = "x-workspace-id";

export function mobileOrigins(env = process.env): string[] {
  const raw = env.MOBILE_ALLOWED_ORIGINS?.trim() || DEFAULT_MOBILE_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** CORS headers for an allowed Origin only; null otherwise (no header at all). No credentials. */
export function corsHeaders(origin: string | null, env = process.env): Record<string, string> | null {
  if (!origin || !mobileOrigins(env).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Workspace-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** The access token of an `Authorization: Bearer` header, "" for a bearer header without a token, null if not Bearer. */
export function bearerToken(headers: Pick<Headers, "get">): string | null {
  const h = headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer(?:\s+(\S+))?\s*$/i.exec(h.trim());
  return m ? (m[1] ?? "") : null;
}

const ARTICLE_ID = /^\/api\/articles\/[0-9a-fA-F-]{36}$/;
/** W0 Bearer is read-only: session check, article list and one article. Everything else is refused. */
export function bearerAllowed(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return path === "/api/session" || path === "/api/articles" || ARTICLE_ID.test(path);
}

/** Token routes authenticate themselves (credentials / refresh token / the bearer to revoke). */
export function isTokenPath(path: string): boolean {
  return path === "/api/auth/token" || path.startsWith("/api/auth/token/");
}

/** Problems with the mobile origin list (names only). Cloud must not trust plain-http origins. */
export function mobileOriginIssues(env = process.env): string[] {
  return mobileOrigins(env).some((o) => o.toLowerCase().startsWith("http://"))
    ? ["MOBILE_ALLOWED_ORIGINS에 http Origin 포함(cloud는 https/capacitor만)"]
    : [];
}
