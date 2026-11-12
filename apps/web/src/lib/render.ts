// The one renderer (P0-12). Preview, HTML export and WordPress all start from the blocks built here:
// the preview shows them as React text, delivery serializes them with HTML escaping.
import type { Article } from "./content";

// Keep the profile lists in sync with the checks in migration 0010 (a test compares them).
export const LAYOUT_PROFILES = ["L01", "L02"] as const;
export type LayoutProfile = (typeof LAYOUT_PROFILES)[number];
export const AD_PROFILES = ["A00", "A01"] as const;
export type AdProfile = (typeof AD_PROFILES)[number];

export const DEFAULT_LAYOUT: LayoutProfile = "L01";
export const DEFAULT_AD: AdProfile = "A00";

export const layoutLabels: Record<LayoutProfile, string> = { L01: "읽기 중심", L02: "비교 중심" };
export const adLabels: Record<AdProfile, string> = { A00: "광고 없음", A01: "본문 구간 후보" };

/**
 * Raise only when the delivered HTML really changes: an approval made under another version is
 * refused at delivery and the article has to be approved again.
 */
export const RENDERER_VERSION = "r2";

export type DeliveryBlock =
  | { kind: "heading"; text: string; /** `cf-s{n}`: set only when a table of contents links to it. */ id?: string }
  | { kind: "paragraph"; text: string }
  | { kind: "toc"; items: { id: string; text: string }[] }
  | { kind: "table"; header: true; rows: string[][] }
  | { kind: "source"; url: string };
/** Ad slots exist only in this type: the HTML serializer can not be handed one. */
export type PreviewBlock = DeliveryBlock | { kind: "ad-slot" };

export function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// A fence opens on backticks not closed on the same line, and closes on a line of backticks only.
const FENCE_OPEN = /^\s*`{3,}[^`]*$/;
const FENCE_CLOSE = /^\s*`{3,}\s*$/;

const isTableLine = (line: string) => line.trim().startsWith("|");
const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
function tableCells(line: string): string[] {
  let t = line.trim().slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
}
/** As in GFM, a table is a header row followed by a separator row (`|---|`); anything else is text. */
function tableBlock(lines: string[]): DeliveryBlock | undefined {
  const rows = lines.map(tableCells);
  if (rows.length < 2 || !isSeparatorRow(rows[1])) return undefined;
  return { kind: "table", header: true, rows: [rows[0], ...rows.slice(2)] };
}

/**
 * Blocks of the manuscript. Lines inside a code fence are never headings or tables. With two or
 * more headings a table of contents is put before the first one; anchors are numbered, never text.
 */
export function deliveryBlocks(article: Pick<Article, "body" | "sourceUrl">): DeliveryBlock[] {
  const blocks: DeliveryBlock[] = [];
  let fenced = false;
  let tableLines: string[] = [];
  const flushTable = () => {
    const table = tableBlock(tableLines);
    if (table) blocks.push(table);
    else for (const line of tableLines) blocks.push({ kind: "paragraph", text: line });
    tableLines = [];
  };
  for (const line of article.body.split("\n")) {
    if ((fenced ? FENCE_CLOSE : FENCE_OPEN).test(line)) fenced = !fenced;
    if (!fenced && isTableLine(line)) {
      tableLines.push(line);
      continue;
    }
    flushTable();
    if (!fenced && line.startsWith("## ")) blocks.push({ kind: "heading", text: line.slice(3) });
    else if (!fenced && line.startsWith("# ")) blocks.push({ kind: "heading", text: line.slice(2) });
    else if (line.trim()) blocks.push({ kind: "paragraph", text: line });
  }
  flushTable();
  const headings = blocks.flatMap((b) => (b.kind === "heading" ? [b] : []));
  if (headings.length >= 2) {
    headings.forEach((h, i) => (h.id = `cf-s${i + 1}`));
    const first = blocks.indexOf(headings[0]);
    blocks.splice(first, 0, { kind: "toc", items: headings.map((h) => ({ id: h.id ?? "", text: h.text })) });
  }
  blocks.push({ kind: "source", url: article.sourceUrl });
  return blocks;
}

/** A01 marks candidate positions between sections, never inside one. */
export function previewBlocks(article: Pick<Article, "body" | "sourceUrl" | "adProfile">): PreviewBlock[] {
  const blocks = deliveryBlocks(article);
  if (article.adProfile !== "A01") return blocks;
  return blocks.flatMap((block, i): PreviewBlock[] =>
    block.kind === "heading" && blocks[i - 1]?.kind === "paragraph" ? [{ kind: "ad-slot" }, block] : [block],
  );
}

function blockHtml(block: DeliveryBlock): string {
  switch (block.kind) {
    case "heading":
      return `<h2${block.id ? ` id="${block.id}"` : ""}>${escapeHtml(block.text)}</h2>`;
    case "toc":
      return `<nav class="cf-toc" aria-label="목차"><ol>${block.items
        .map((item) => `<li><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`)
        .join("")}</ol></nav>`;
    case "table": {
      const row = (cells: string[], tag: string) =>
        `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
      const [first, ...rest] = block.rows;
      const head = block.header ? `<thead>${row(first, "th")}</thead>` : "";
      const body = (block.header ? rest : block.rows).map((r) => row(r, "td")).join("");
      return `<div class="cf-table-wrap" style="overflow-x:auto"><table class="cf-table">${head}<tbody>${body}</tbody></table></div>`;
    }
    case "paragraph":
      return `<p>${escapeHtml(block.text)}</p>`;
    case "source":
      return `<p>출처: ${escapeHtml(block.url)}</p>`;
  }
}

/** Escaped HTML fragment that is delivered. The class is the theme's hook for the layout profile. */
export function renderFragment(article: Pick<Article, "body" | "sourceUrl" | "layoutProfile">): string {
  const layout = article.layoutProfile ?? DEFAULT_LAYOUT;
  const body = deliveryBlocks(article).map(blockHtml).join("\n");
  return `<div class="cf-layout cf-layout-${layout.toLowerCase()}">\n${body}\n</div>`;
}
