import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth";
import { serverClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Target of the links in Supabase e-mails (sign-up confirmation, password reset). Exchanges the
 * one-time code for a session, then continues to a same-site page only.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  const supabase = await serverClient();
  if (supabase && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}