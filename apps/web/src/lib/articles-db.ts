// Mapping between the app's Article and the `articles` table (migration 0002).
import { isArticle, type Article } from "./content";
import type { LifecycleState } from "./lifecycle";
import { afterEdit } from "./lifecycle";

export const ARTICLE_COLUMNS =
  "id,title,keyword,template_id,platform,body,source_url,state,updated_at,remote";

export type ArticleRow = {
  id: string;
  title: string;
  keyword: string;
  template_id: string;
  platform: Article["platform"];
  body: string;
  source_url: string;
  state: LifecycleState;
  updated_at: string;
  remote: Article["remote"] | null;
};

export function rowToArticle(r: ArticleRow): Article {
  const a: Article = {
    id: r.id,
    title: r.title,
    keyword: r.keyword,
    templateId: r.template_id,
    platform: r.platform,
    body: r.body,
    sourceUrl: r.source_url,
    status: r.state,
    updatedAt: r.updated_at,
  };
  if (r.remote) a.remote = r.remote;
  return a;
}

/** Editable columns. `remote` is deliberately absent: only the WordPress route sets it. */
export function articleToFields(a: Article) {
  return {
    title: a.title,
    keyword: a.keyword,
    template_id: a.templateId,
    platform: a.platform,
    body: a.body,
    source_url: a.sourceUrl,
    state: a.status,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

export function parseIncomingArticle(body: unknown): Article {
  if (!isArticle(body)) throw new Error("콘텐츠 형식이 올바르지 않습니다.");
  return body;
}

/**
 * Local data has no approval snapshots, so anything reviewed or later is imported as
 * `drafting` and has to be reviewed and approved again. Invalid ids are replaced.
 */
export function toImportable(a: Article): Article {
  const { remote: _remote, ...rest } = a;
  void _remote;
  return {
    ...rest,
    id: isUuid(a.id) ? a.id : crypto.randomUUID(),
    status: afterEdit(a.status),
  };
}

/** Maps a PostgREST/trigger error to a user-facing status and message. */
export function dbError(error: { code?: string; message?: string }): {
  status: number;
  message: string;
} {
  if (error.code === "42501")
    return { status: 403, message: "이 작업을 할 권한이 없습니다." };
  if (error.code === "P0001")
    return {
      status: 409,
      message: `상태 규칙에 맞지 않아 저장하지 못했습니다. (${error.message ?? ""})`.trim(),
    };
  if (error.code === "23514")
    return { status: 422, message: "입력 값이 허용 범위를 벗어났습니다." };
  return { status: 500, message: "저장소 처리 중 오류가 발생했습니다." };
}
