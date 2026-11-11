// WordPress REST integration. Only ever creates or updates DRAFTS: the status sent on
// create is always "draft" and an update never sends a status, so an operator-published
// post can not be unpublished or republished by this app.
import { isApprovedContent, reviewErrors, type Article } from "./content";
import { DeliveryError } from "./delivery";
import { renderFragment } from "./render";

export type WpConfig = { baseUrl: string; username: string; appPassword: string };
export type WpResult = { postId: number; url: string; created: boolean };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("WordPress 주소는 https여야 합니다(로컬 테스트 제외).");
  if (url.username || url.password)
    throw new Error("WordPress 주소에 계정 정보를 넣지 마세요.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Escaped HTML fragment of the manuscript, the same one the HTML export contains. */
export const toWpContent = (article: Article): string => renderFragment(article);

export function assertSendable(article: Article) {
  if (!isApprovedContent(article))
    throw new DeliveryError("not_sendable", "승인된 콘텐츠만 WordPress로 보낼 수 있습니다.");
  const issues = reviewErrors(article);
  if (issues.length) throw new DeliveryError("not_sendable", issues[0]);
}

/** Stable identity of an article's remote post: found again even if the post id was never saved. */
export const remoteSlug = (articleId: string) => `cf-${articleId}`;

function authHeader(c: WpConfig) {
  return "Basic " + Buffer.from(`${c.username}:${c.appPassword}`).toString("base64");
}
const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";
const timeoutError = () => new DeliveryError("timeout", "WordPress 응답 시간이 초과되었습니다.");
const failureOf = (status: number) =>
  status === 401 || status === 403
    ? "auth"
    : status === 404
      ? "not_found"
      : status === 429
        ? "rate_limited"
        : status >= 500
          ? "server"
          : "rejected";

async function wpError(res: Response): Promise<DeliveryError> {
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string };
    detail = typeof j.message === "string" ? j.message.slice(0, 200) : "";
  } catch {}
  const hint =
    res.status === 401 || res.status === 403
      ? "계정 또는 애플리케이션 비밀번호/권한을 확인해주세요."
      : res.status === 404
        ? "REST API 주소 또는 글 ID를 확인해주세요."
        : "";
  return new DeliveryError(failureOf(res.status), `WordPress 응답 오류(${res.status}). ${hint} ${detail}`.trim());
}

async function parseBody<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw isTimeout(e) ? timeoutError() : new DeliveryError("invalid_response", "WordPress 응답 형식이 올바르지 않습니다.");
  }
}

/**
 * Creates a draft, or updates the existing one: `existingId` when known, otherwise the post
 * carrying this article's slug. The slug lookup runs before every create, so a retry after a
 * timeout or a failed save finds the draft the earlier attempt made. If it can not answer,
 * nothing is created. Updating is refused if the remote post is no longer a draft.
 */
export async function sendDraft(
  config: WpConfig,
  article: Article,
  existingId?: number,
  fetchImpl: FetchLike = fetch,
): Promise<WpResult> {
  assertSendable(article);
  let base: string;
  try {
    base = normalizeBaseUrl(config.baseUrl);
  } catch (e) {
    throw new DeliveryError("config", e instanceof Error ? e.message : "WordPress 주소를 확인해주세요.");
  }
  const headers = {
    Authorization: authHeader(config),
    "Content-Type": "application/json",
  };
  const request = async (url: string, init: RequestInit = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000), ...init });
    } catch (e) {
      throw isTimeout(e) ? timeoutError() : new DeliveryError("network", "WordPress 서버에 연결하지 못했습니다.");
    }
    if (!res.ok) throw await wpError(res);
    return res;
  };
  const slug = remoteSlug(article.id);
  const payload = { title: article.title, content: toWpContent(article) };

  let targetId = existingId;
  if (targetId === undefined) {
    const found = await parseBody<unknown>(
      await request(`${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=any&context=edit`),
    );
    if (!Array.isArray(found))
      throw new DeliveryError("invalid_response", "WordPress 응답 형식이 올바르지 않습니다.");
    const posts = found as { id: number; status: string }[];
    // A post that is no longer a draft wins, so the update below refuses instead of overwriting.
    targetId = (posts.find((p) => p.status !== "draft") ?? posts[0])?.id;
  }

  if (targetId !== undefined) {
    const url = `${base}/wp-json/wp/v2/posts/${targetId}`;
    const remote = await parseBody<{ status?: string }>(await request(`${url}?context=edit`));
    if (remote.status !== "draft")
      throw new DeliveryError(
        "remote_state",
        `원격 글이 초안이 아닙니다(상태: ${String(remote.status)}). 덮어쓰지 않았습니다.`,
      );
    const res = await request(url, { method: "POST", body: JSON.stringify(payload) });
    const j = await parseBody<{ id?: unknown; link?: unknown }>(res);
    if (typeof j.id !== "number" || typeof j.link !== "string")
      throw new DeliveryError("invalid_response", "WordPress 응답 형식이 올바르지 않습니다.");
    return { postId: j.id, url: j.link, created: false };
  }
  const res = await request(`${base}/wp-json/wp/v2/posts`, {
    method: "POST",
    body: JSON.stringify({ ...payload, slug, status: "draft" }),
  });
  const j = await parseBody<{ id?: unknown; link?: unknown; status?: unknown }>(res);
  if (typeof j.id !== "number" || typeof j.link !== "string")
    throw new DeliveryError("invalid_response", "WordPress 응답 형식이 올바르지 않습니다.");
  if (j.status !== "draft")
    throw new DeliveryError(
      "remote_state",
      `초안이 아닌 상태로 생성되었습니다(${String(j.status)}). WordPress에서 확인해주세요.`,
    );
  return { postId: j.id, url: j.link, created: true };
}
