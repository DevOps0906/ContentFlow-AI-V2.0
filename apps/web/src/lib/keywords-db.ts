// Mapping and validation for the `keywords` table (migration 0003).
import type { Keyword } from "./keywords";

export const KEYWORD_COLUMNS = "id,phrase,intent,priority,note,created_at";
export const MAX_PER_REQUEST = 500;

export type KeywordRow = {
  id: string;
  phrase: string;
  intent: string;
  priority: number;
  note: string;
  created_at: string;
};
export const rowToKeyword = (r: KeywordRow): Keyword => ({
  id: r.id,
  phrase: r.phrase,
  intent: r.intent,
  priority: r.priority,
  note: r.note,
  importedAt: r.created_at,
});

export type NewKeyword = { phrase: string; intent: string; priority: number; note: string };

/** Validates a list from the browser. Throws with a user-facing message on the first problem. */
export function parseNewKeywords(input: unknown): NewKeyword[] {
  const list = (input as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(list) || list.length === 0) throw new Error("추가할 키워드가 없습니다.");
  if (list.length > MAX_PER_REQUEST) throw new Error(`한 번에 ${MAX_PER_REQUEST}개까지 저장할 수 있습니다.`);
  return list.map((v, i) => {
    const k = (v ?? {}) as Record<string, unknown>;
    const phrase = typeof k.phrase === "string" ? k.phrase.trim() : "";
    if (!phrase || phrase.length > 120) throw new Error(`${i + 1}번째 키워드는 1~120자여야 합니다.`);
    const intent = typeof k.intent === "string" ? k.intent.trim() : "";
    const note = typeof k.note === "string" ? k.note.trim() : "";
    if (intent.length > 200 || note.length > 500) throw new Error(`${i + 1}번째 키워드의 검색의도/메모가 너무 깁니다.`);
    const priority = k.priority === undefined ? 3 : Number(k.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5)
      throw new Error(`${i + 1}번째 키워드의 우선순위는 1~5 정수여야 합니다.`);
    return { phrase, intent, priority, note };
  });
}