import { research, validateResearchInput } from "@/lib/naver-research";
import { json, readJson } from "@/lib/server";
import { naverGuard } from "../guard";

export const dynamic = "force-dynamic";

/** R1: related keywords + "네이버 검색결과" (10 blog posts in API order). Nothing is stored. */
export async function POST(req: Request) {
  const guard = await naverGuard(req);
  if (!guard.ok) return guard.res;
  let input;
  try {
    input = validateResearchInput(await readJson(req, 4_000));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "잘못된 요청입니다." }, 400);
  }
  // Single owner only (§11.2): local mode or the NAVER_OWNER_WORKSPACE_ID workspace.
  const result = await research(input, { caller: guard.log ? { mode: "account", workspaceId: guard.log.workspaceId } : { mode: "local" } });
  return result.ok ? json(result.value) : json({ error: result.error }, result.status);
}
