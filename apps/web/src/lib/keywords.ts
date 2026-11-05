import { findTemplate, templateBody } from "./templates";
import type { Article } from "./content";
export type Keyword = {
  id: string;
  phrase: string;
  intent: string;
  priority: number;
  note: string;
  importedAt: string;
};
export const KEYWORD_STORAGE_KEY = "contentflow.keywords.v1";
export const MAX_KEYWORDS = 5000;
export const MAX_CSV_BYTES = 1_000_000;

/** RFC 4180-style parser: quotes, escaped quotes, commas/newlines in quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("CSV의 따옴표가 닫히지 않았습니다.");
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function normalizePhrase(phrase: string) {
  return phrase.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

const headerAliases: Record<string, string> = {
  keyword: "phrase",
  phrase: "phrase",
  키워드: "phrase",
  intent: "intent",
  검색의도: "intent",
  의도: "intent",
  priority: "priority",
  우선순위: "priority",
  note: "note",
  memo: "note",
  메모: "note",
};

export type ImportResult = {
  keywords: Keyword[];
  added: number;
  duplicates: number;
  invalid: { line: number; reason: string }[];
};

/**
 * Parses CSV into keywords and merges into `existing`. Duplicates (case/space/width
 * insensitive) against existing rows and within the file are skipped, never overwritten.
 * Header row is optional; without one, the first column is the phrase.
 */
export function importKeywords(
  csv: string,
  existing: Keyword[],
  now = new Date().toISOString(),
): ImportResult {
  if (csv.length > MAX_CSV_BYTES) throw new Error("CSV 파일이 너무 큽니다. (최대 1MB)");
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error("가져올 행이 없습니다.");
  const first = rows[0].map((h) => headerAliases[h.normalize("NFKC").trim().toLowerCase()]);
  const hasHeader = first.includes("phrase");
  const cols: Record<string, number> = {};
  if (hasHeader) first.forEach((k, i) => k && !(k in cols) && (cols[k] = i));
  else cols.phrase = 0;
  const seen = new Set(existing.map((k) => normalizePhrase(k.phrase)));
  const result: ImportResult = { keywords: [...existing], added: 0, duplicates: 0, invalid: [] };
  const body = hasHeader ? rows.slice(1) : rows;
  body.forEach((r, idx) => {
    const line = idx + 1 + (hasHeader ? 1 : 0);
    const phrase = (r[cols.phrase] ?? "").trim();
    if (!phrase) return void result.invalid.push({ line, reason: "키워드가 비어 있습니다." });
    if (phrase.length > 120)
      return void result.invalid.push({ line, reason: "키워드가 120자를 넘습니다." });
    const key = normalizePhrase(phrase);
    if (seen.has(key)) return void result.duplicates++;
    if (result.keywords.length >= MAX_KEYWORDS)
      return void result.invalid.push({ line, reason: `최대 ${MAX_KEYWORDS}개까지 저장할 수 있습니다.` });
    const rawPriority = cols.priority === undefined ? "" : (r[cols.priority] ?? "").trim();
    const priority = rawPriority === "" ? 3 : Number(rawPriority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5)
      return void result.invalid.push({ line, reason: "우선순위는 1~5 정수여야 합니다." });
    seen.add(key);
    result.keywords.push({
      id: crypto.randomUUID(),
      phrase,
      intent: cols.intent === undefined ? "" : (r[cols.intent] ?? "").trim(),
      priority,
      note: cols.note === undefined ? "" : (r[cols.note] ?? "").trim(),
      importedAt: now,
    });
    result.added++;
  });
  return result;
}

export function isKeyword(v: unknown): v is Keyword {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return (
    ["id", "phrase", "intent", "note", "importedAt"].every((f) => typeof k[f] === "string") &&
    Number.isInteger(k.priority) &&
    !Number.isNaN(Date.parse(String(k.importedAt)))
  );
}
export function parseKeywords(raw: string | null): Keyword[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isKeyword))
    throw new Error("저장된 키워드 형식을 읽을 수 없습니다.");
  return parsed;
}

/**
 * Articles that came from (or share) a keyword. The link is the normalized phrase stored in
 * `Article.keyword`, so it works in local and account mode without a schema change.
 */
export function linkedArticles(phrase: string, articles: Article[]): Article[] {
  const key = normalizePhrase(phrase);
  return articles
    .filter((a) => normalizePhrase(a.keyword) === key)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * A new article at the `idea` stage. It carries no body text of its own (only the template
 * skeleton) and no source, so it can not skip research, briefing or review.
 */
export function ideaFromKeyword(
  phrase: string,
  opts: { title?: string; templateId?: string; id?: string; now?: string } = {},
): Article {
  const keyword = phrase.trim();
  if (!keyword) throw new Error("키워드가 비어 있습니다.");
  if (keyword.length > 120) throw new Error("키워드가 120자를 넘습니다.");
  const templateId = findTemplate(opts.templateId ?? "T01").id;
  return {
    id: opts.id ?? crypto.randomUUID(),
    title: (opts.title ?? "").trim().slice(0, 200),
    keyword,
    templateId,
    platform: "wordpress",
    body: templateBody(templateId),
    sourceUrl: "",
    status: "idea",
    updatedAt: opts.now ?? new Date().toISOString(),
  };
}
