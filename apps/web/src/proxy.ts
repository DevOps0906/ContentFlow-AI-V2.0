import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth";
import {
  DESKTOP_COOKIE,
  desktopHealthHmac,
  desktopHostOk,
  desktopPort,
  desktopMode,
  safeEqual,
} from "@/lib/desktop";
import { bearerAllowed, bearerToken, corsHeaders, isTokenPath } from "@/lib/mobile";
import { sessionCookieOptions, supabaseEnv } from "@/lib/supabase";

// Refreshes the Supabase session cookie and keeps anonymous visitors out. Without Supabase
// configured the app runs in local (browser-only) mode and this does nothing.
// API routes re-check the caller themselves; this is not the only gate.
const OPEN_PATHS = ["/login", "/auth/callback", "/api/health", "/api/session", "/api/auth/"];

// Static assets skip the Supabase session work (they used to be excluded by the matcher).
const STATIC = /^\/(?:_next\/static|_next\/image|favicon\.ico)|\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/;

const forbidden = () => NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });

// Desktop sidecar token check. Returns a response to stop, or null to continue.
function desktopGuard(req: NextRequest, path: string, token: string): NextResponse | null {
  if (!desktopHostOk(req.headers.get("host"))) return forbidden();
  if (req.method === "GET" && path === "/desktop-auth") {
    if (!safeEqual(req.nextUrl.searchParams.get("t"), token)) return forbidden();
    const res = NextResponse.redirect(`http://127.0.0.1:${desktopPort()}/`, 302);
    res.cookies.set(DESKTOP_COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/" });
    return res;
  }
  if (req.method === "GET" && path === "/api/health") {
    const nonce = req.nextUrl.searchParams.get("nonce");
    if (nonce) return NextResponse.json({ ok: true, hmac: desktopHealthHmac(token, nonce) });
    return null;
  }
  if (!safeEqual(req.cookies.get(DESKTOP_COOKIE)?.value, token)) return forbidden();
  return null;
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const dm = desktopMode();
  if (dm.mode === "invalid")
    return NextResponse.json({ error: "데스크톱 설정이 올바르지 않습니다." }, { status: 503 });
  if (dm.mode === "on") {
    const stop = desktopGuard(req, path, dm.token);
    if (stop) return stop;
  }
  if (STATIC.test(path)) return NextResponse.next();
  const cors = path.startsWith("/api/") ? corsHeaders(req.headers.get("origin")) : null;
  const res = await handle(req, path);
  if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

async function handle(req: NextRequest, path: string): Promise<NextResponse> {
  if (req.method === "OPTIONS" && path.startsWith("/api/")) {
    // Preflight: CORS headers (if the Origin is allowed) are added by proxy(). Nothing else.
    return new NextResponse(null, { status: 204 });
  }
  const env = supabaseEnv();
  if (!env) return NextResponse.next();

  // Mobile Bearer: no cookie is read. Only read-only routes pass; each route verifies the token.
  const token = bearerToken(req.headers);
  if (token !== null) {
    if (isTokenPath(path) || bearerAllowed(req.method, path)) return NextResponse.next();
    return NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });
  }

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list)
          res.cookies.set(name, value, { ...options, ...sessionCookieOptions() });
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const open = OPEN_PATHS.some((p) => path === p || (p.endsWith("/") && path.startsWith(p)));

  if (!data.user && !open) {
    if (path.startsWith("/api/"))
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (path !== "/") url.searchParams.set("next", path + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  if (data.user && path === "/login") {
    return NextResponse.redirect(
      new URL(safeNext(req.nextUrl.searchParams.get("next")), req.url),
    );
  }
  return res;
}

export const config = {
  matcher: ["/:path*"],
};
