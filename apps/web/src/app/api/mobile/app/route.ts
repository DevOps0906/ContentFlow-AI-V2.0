import { requireAccount } from "@/lib/api";
import { readMobileApp } from "@/lib/mobile-app";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** What the dashboard card shows. Cookie login only: a Bearer caller is refused (403). */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const app = await readMobileApp();
  if (app.status === "none") return json({ available: false });
  if (app.status === "invalid") return json({ available: false, invalid: true });
  return json({ available: true, ...app.info });
}
