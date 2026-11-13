import { requireAccount } from "@/lib/api";
import { isUuid } from "@/lib/articles-db";
import { cancelJob, QueueError } from "@/lib/publish-queue-server";
import { json } from "@/lib/server";
import { canEdit } from "@/lib/team";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Only a job that has not started can be cancelled; the article keeps its state. */
export async function POST(req: Request, ctx: Ctx) {
  const account = await requireAccount(req);
  if (account instanceof Response) return account;
  if (!canEdit(account.role)) return json({ error: "발행 큐는 편집 권한이 있는 멤버만 사용할 수 있습니다." }, 403);
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "잘못된 작업 ID입니다." }, 400);
  try {
    return json({ job: await cancelJob(account, id) });
  } catch (e) {
    return e instanceof QueueError
      ? json({ error: e.message, code: e.code }, e.status)
      : json({ error: "취소하지 못했습니다." }, 500);
  }
}
