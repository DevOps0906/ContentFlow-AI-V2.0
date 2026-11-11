import { requireAccount } from "@/lib/api";
import { apkStream, readMobileApp } from "@/lib/mobile-app";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Streams app.apk after checking it against the sha256 in app.json. Cookie login only. */
export async function GET(req: Request) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const app = await readMobileApp();
  if (app.status === "none") return json({ error: "배포된 앱이 없습니다." }, 404);
  if (app.status === "invalid") return json({ error: "배포 파일 검증에 실패했습니다." }, 503);
  return new Response(apkStream(app.apkPath), {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="contentflow-${app.info.version.replace(/[^\w.-]/g, "_")}.apk"`,
      "Content-Length": String(app.info.size),
      "X-Content-SHA256": app.info.sha256,
      "Cache-Control": "no-store",
    },
  });
}
