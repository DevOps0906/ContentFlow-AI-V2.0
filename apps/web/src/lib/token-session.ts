// Shared by the mobile token routes: a stateless Supabase client and the response shape.
import type { Session } from "@supabase/supabase-js";

export type TokenBody = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { email: string };
};

export function tokenBody(s: Session): TokenBody {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in,
    user: { email: s.user.email ?? "" },
  };
}

/**
 * Rate-limit bucket for the token routes. Client-sent forwarding headers are spoofable, so they
 * are only used when TRUST_PROXY=true (the app runs behind a reverse proxy that appends the
 * peer address: the rightmost x-forwarded-for hop, else x-real-ip). Otherwise every caller shares
 * the "direct" bucket with a higher global limit; the per-email limit still applies.
 */
export function ipLimit(
  req: Request,
  perIp: number,
  direct: number,
  env: NodeJS.ProcessEnv = process.env,
): { key: string; max: number } {
  if (env.TRUST_PROXY?.trim().toLowerCase() === "true") {
    const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
    const ip = hops[hops.length - 1] || req.headers.get("x-real-ip")?.trim();
    if (ip) return { key: `ip:${ip}`, max: perIp };
  }
  return { key: "ip:direct", max: direct };
}
