import { requireAccount } from "@/lib/api";
import { isUuid } from "@/lib/articles-db";
import { rpcDeliveryCheck } from "@/lib/delivery";
import { json } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Lets the browser ask before a download. The database and this deployment's renderer decide. */
export async function POST(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 콘텐츠 ID입니다." }, 400);
  try {
    return json(await rpcDeliveryCheck(account.supabase)(id));
  } catch {
    return json({ error: "전달 가능 여부를 확인하지 못했습니다." }, 500);
  }
}
