import { deeplink, validateProductUrl } from "@/lib/coupang";
import { json, readJson } from "@/lib/server";
import { badRequest, coupangGuard } from "../guard";

export const dynamic = "force-dynamic";

/** C3: one coupang.com product URL → its affiliate short link. Nothing is stored. */
export async function POST(req: Request) {
  const guard = await coupangGuard(req);
  if (!guard.ok) return guard.res;
  let url;
  try {
    url = validateProductUrl(await readJson(req, 4_000));
  } catch (e) {
    return badRequest(e);
  }
  const result = await deeplink(url, guard.opts);
  return result.ok ? json({ link: result.value }) : json({ error: result.error }, result.status);
}
