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
export const RENDERER_VERSION = "r1";

export type DeliveryBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
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

/** Blocks of the manuscript. Lines inside a code fence are never headings. */
export function deliveryBlocks(article: Pick<Article, "body" | "sourceUrl">): DeliveryBlock[] {
  const blocks: DeliveryBlock[] = [];
  let fenced = false;
  for (const line of article.body.split("\n")) {
    if ((fenced ? FENCE_CLOSE : FENCE_OPEN).test(line)) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) blocks.push({ kind: "heading", text: line.slice(3) });
    else if (!fenced && line.startsWith("# ")) blocks.push({ kind: "heading", text: line.slice(2) });
    else if (line.trim()) blocks.push({ kind: "paragraph", text: line });
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
      return `<h2>${escapeHtml(block.text)}</h2>`;
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
