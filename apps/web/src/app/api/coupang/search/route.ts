import { searchProducts, validateKeyword } from "@/lib/coupang";
import { json, readJson } from "@/lib/server";
import { badRequest, coupangGuard } from "../guard";

export const dynamic = "force-dynamic";

/** C2: products for a keyword (name, price, rocket, affiliate link). Nothing is stored. */
export async function POST(req: Request) {
  const guard = await coupangGuard(req);
  if (!guard.ok) return guard.res;
  let keyword;
  try {
    keyword = validateKeyword(await readJson(req, 2_000));
  } catch (e) {
    return badRequest(e);
  }
  const result = await searchProducts(keyword, guard.opts);
  return result.ok ? json({ items: result.value }) : json({ error: result.error }, result.status);
}
