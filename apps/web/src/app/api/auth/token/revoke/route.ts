import { bearerToken } from "@/lib/mobile";
import { json } from "@/lib/server";
import { supabaseEnv } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Mobile sign-out: ends this session only (scope local), so its refresh token stops working.
 * The access token stays valid until it expires (default 1 hour). */
export async function POST(req: Request) {
  const env = supabaseEnv();
  if (!env) return json({ error: "로그인 기능이 설정되지 않았습니다." }, 503);
  const token = bearerToken(req.headers);
  if (!token) return json({ error: "로그인이 필요합니다." }, 401);
  let res: Response;
  try {
    res = await fetch(`${env.url.replace(/\/+$/, "")}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: env.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return json({ error: "로그아웃하지 못했습니다." }, 502);
  }
  if (res.status === 401 || res.status === 403) return json({ error: "로그인이 필요합니다." }, 401);
  if (!res.ok) return json({ error: "로그아웃하지 못했습니다." }, 502);
  return json({ ok: true });
}
