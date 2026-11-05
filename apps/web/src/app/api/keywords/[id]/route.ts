import { isUuid } from "@/lib/articles-db";
import { json, sameOrigin } from "@/lib/server";
import { getAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "허용되지 않은 요청입니다." }, 403);
  const account = await getAccount();
  if (account.mode === "local") return json({ error: "로컬 모드입니다." }, 404);
  if (account.mode === "anonymous") return json({ error: "로그인이 필요합니다." }, 401);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 키워드 ID입니다." }, 400);
  const { data, error } = await account.supabase
    .from("keywords")
    .delete()
    .eq("id", id)
    .eq("workspace_id", account.workspaceId)
    .select("id");
  if (error) return json({ error: "삭제하지 못했습니다." }, 500);
  if (!data?.length) return json({ error: "삭제할 수 없거나 이미 삭제된 키워드입니다." }, 404);
  return json({ ok: true });
}