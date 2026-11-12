import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Desktop sidecar guard. The desktop shell passes DESKTOP_TOKEN (random hex) and DESKTOP_PORT to
// this process. When the token is set, every request must come from 127.0.0.1:<port> and carry
// the cf_desktop cookie. Without the token (web, Docker) nothing here applies.
export const DESKTOP_COOKIE = "cf_desktop";

export type DesktopMode = { mode: "off" } | { mode: "invalid" } | { mode: "on"; token: string };

/** Fail closed: a defined but malformed DESKTOP_TOKEN (not 64 hex) or DESKTOP_PORT is "invalid". */
export function desktopMode(env: NodeJS.ProcessEnv = process.env): DesktopMode {
  const t = env.DESKTOP_TOKEN;
  if (t === undefined) return { mode: "off" };
  if (!/^[0-9a-fA-F]{64}$/.test(t)) return { mode: "invalid" };
  const p = env.DESKTOP_PORT;
  if (p !== undefined && !/^\d{1,5}$/.test(p)) return { mode: "invalid" };
  return { mode: "on", token: t };
}

export function desktopPort(env: NodeJS.ProcessEnv = process.env): string {
  return env.DESKTOP_PORT || "34110";
}

/** Constant-time string comparison (hashes first so lengths do not leak). */
export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function desktopHostOk(host: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return host === `127.0.0.1:${desktopPort(env)}`;
}

export function desktopHealthHmac(token: string, nonce: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}
