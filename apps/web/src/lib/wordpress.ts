// WordPress REST integration. Only ever creates or updates DRAFTS: the status sent on
// create is always "draft" and an update never sends a status, so an operator-published
// post can not be unpublished or republished by this app.
import { escapeHtml, isApprovedContent, reviewErrors, type Article } from "./content";

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

/** Escaped HTML fragment of the manuscript; markdown headings become <h2>. */
export function toWpContent(article: Article): string {
  const body = article.body
    .split("\n")
    .map((line) =>
      line.startsWith("## ")
        ? `<h2>${escapeHtml(line.slice(3))}</h2>`
        : line.startsWith("# ")
          ? `<h2>${escapeHtml(line.slice(2))}</h2>`
          : line.trim()
            ? `<p>${escapeHtml(line)}</p>`
            : "",
    )
    .filter(Boolean)
    .join("\n");
  return `${body}\n<p>출처: ${escapeHtml(article.sourceUrl)}</p>`;
}

export function assertSendable(article: Article) {
  if (!isApprovedContent(article))
    throw new Error("승인된 콘텐츠만 WordPress로 보낼 수 있습니다.");
  const issues = reviewErrors(article);
  if (issues.length) throw new Error(issues[0]);
}

function authHeader(c: WpConfig) {
  return "Basic " + Buffer.from(`${c.username}:${c.appPassword}`).toString("base64");
}
async function wpError(res: Response): Promise<Error> {
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
  return new Error(`WordPress 응답 오류(${res.status}). ${hint} ${detail}`.trim());
}

/**
 * Creates a draft, or updates the previously created one when `existingId` is set.
 * Updating is refused if the remote post is no longer a draft.
 */
export async function sendDraft(
  config: WpConfig,
  article: Article,
  existingId?: number,
  fetchImpl: FetchLike = fetch,
): Promise<WpResult> {
  assertSendable(article);
  const base = normalizeBaseUrl(config.baseUrl);
  const headers = {
    Authorization: authHeader(config),
    "Content-Type": "application/json",
  };
  const signal = () => AbortSignal.timeout(15000);
  const payload = { title: article.title, content: toWpContent(article) };
  if (existingId !== undefined) {
    const url = `${base}/wp-json/wp/v2/posts/${existingId}`;
    const current = await fetchImpl(`${url}?context=edit`, { headers, signal: signal() });
    if (!current.ok) throw await wpError(current);
    const remote = (await current.json()) as { status?: string };
    if (remote.status !== "draft")
      throw new Error(
        `원격 글이 초안이 아닙니다(상태: ${String(remote.status)}). 덮어쓰지 않았습니다.`,
      );
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: signal(),
    });
    if (!res.ok) throw await wpError(res);
    const j = (await res.json()) as { id: number; link: string };
    return { postId: j.id, url: j.link, created: false };
  }
  const res = await fetchImpl(`${base}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, status: "draft" }),
    signal: signal(),
  });
  if (!res.ok) throw await wpError(res);
  const j = (await res.json()) as { id?: unknown; link?: unknown; status?: unknown };
  if (typeof j.id !== "number" || typeof j.link !== "string")
    throw new Error("WordPress 응답 형식이 올바르지 않습니다.");
  if (j.status !== "draft")
    throw new Error(`초안이 아닌 상태로 생성되었습니다(${String(j.status)}). WordPress에서 확인해주세요.`);
  return { postId: j.id, url: j.link, created: true };
}
