import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth";
import { bearerAllowed, bearerToken, corsHeaders, isTokenPath } from "@/lib/mobile";
import { sessionCookieOptions, supabaseEnv } from "@/lib/supabase";

// Refreshes the Supabase session cookie and keeps anonymous visitors out. Without Supabase
// configured the app runs in local (browser-only) mode and this does nothing.
// API routes re-check the caller themselves; this is not the only gate.
const OPEN_PATHS = ["/login", "/auth/callback", "/api/health", "/api/session", "/api/auth/"];

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)"],
};
