import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth";
import { sessionCookieOptions, supabaseEnv } from "@/lib/supabase";

// Refreshes the Supabase session cookie and keeps anonymous visitors out. Without Supabase
// configured the app runs in local (browser-only) mode and this does nothing.
// API routes re-check the caller themselves; this is not the only gate.
const OPEN_PATHS = ["/login", "/api/health", "/api/session", "/api/auth/"];

export async function proxy(req: NextRequest) {
  const env = supabaseEnv();
  if (!env) return NextResponse.next();

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
  const path = req.nextUrl.pathname;
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
