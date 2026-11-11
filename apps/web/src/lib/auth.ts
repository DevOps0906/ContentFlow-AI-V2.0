// Credential validation shared by the login and signup routes.
export type Credentials = { email: string; password: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseCredentials(input: unknown, opts: { strict: boolean }): Credentials {
  if (!input || typeof input !== "object") throw new Error("요청 형식이 올바르지 않습니다.");
  const { email, password } = input as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string")
    throw new Error("이메일과 비밀번호를 입력해주세요.");
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 254) throw new Error("이메일 형식이 올바르지 않습니다.");
  // Signup enforces the policy; login only bounds the input (bcrypt truncates at 72 bytes).
  if (opts.strict && (password.length < 8 || password.length > 72))
    throw new Error("비밀번호는 8자 이상 72자 이하로 입력해주세요.");
  if (!opts.strict && (!password || password.length > 72))
    throw new Error("이메일 또는 비밀번호를 확인해주세요.");
  return { email: e, password };
}

/** Only same-site relative paths are accepted as a post-login target. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}
export function parseEmail(input: unknown): string {
  const email = (input as { email?: unknown } | null)?.email;
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL.test(e) || e.length > 254) throw new Error("이메일 형식이 올바르지 않습니다.");
  return e;
}
export function parseNewPassword(input: unknown): string {
  const p = (input as { password?: unknown } | null)?.password;
  if (typeof p !== "string" || p.length < 8 || p.length > 72)
    throw new Error("비밀번호는 8자 이상 72자 이하로 입력해주세요.");
  return p;
}

/**
 * Origin used in e-mail links. APP_URL wins when set (behind a proxy the Host header can be
 * wrong); otherwise the caller's origin, which the same-origin check has already matched.
 */
export function appOrigin(req: Request, env = process.env): string {
  const configured = env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(req.headers.get("origin") ?? req.url).origin;
}

/** Redirect target after a callback: always on the app origin, `next` only as a same-site path. */
export function redirectTarget(req: Request, next: string | null | undefined, env = process.env): URL {
  const origin = appOrigin(req, env);
  return new URL(safeNext(next), origin);
}
