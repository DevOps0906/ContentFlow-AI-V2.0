// C4 브랜드커넥트 링크 입력과 C6 제휴 저품질 경고 (AFFILIATE_COMMERCE.md §4.3). Pure functions only:
// no external call, and nothing here marks a link as "connected". BC links do not block approval (C1 is Coupang only).
import { AFFILIATE_HOST, disclosureWindow, hasDisclosure, NAVER_SHORT_HOST, type Article } from "./content";

export const BRAND_CONNECT_DISCLOSURE = "이 글은 네이버 쇼핑 커넥트 활동으로, 구매 시 판매 수수료를 받습니다.";
export const AFFILIATE_LINK_LIMIT = 3;
const LEAD_WINDOW = 300;
// The other C4 hosts: brandconnect.naver.com, or a naver.com host with "shoppingconnect" in it.
const BRAND_CONNECT_HOST =
  /(?<![a-z0-9.-])(brandconnect\.naver\.com|(?:[a-z0-9-]+\.)*[a-z0-9-]*shoppingconnect[a-z0-9-]*(?:\.[a-z0-9-]+)*\.naver\.com)(?![a-z0-9-]|\.[a-z0-9-])/i;
const COUNTED_HOSTS = [AFFILIATE_HOST, NAVER_SHORT_HOST, BRAND_CONNECT_HOST];

/** Start index (code units) of each host match. A match may begin with one consumed boundary character, which is
 *  never [a-z0-9], so the host starts at the first [a-z0-9]. Restarting one character later keeps a consumed
 *  boundary usable for the next link. */
function hostStarts(text: string): number[] {
  const starts: number[] = [];
  for (const pattern of COUNTED_HOSTS) {
    const re = new RegExp(pattern.source, "gi");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      starts.push(m.index + m[0].search(/[a-z0-9]/i));
      re.lastIndex = m.index + 1;
    }
  }
  return starts;
}

/** https only, host naver.me, brandconnect.naver.com or a naver.com host containing "shoppingconnect". */
export function brandConnectUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const naverHost = host === "naver.com" || host.endsWith(".naver.com");
  if (host !== "naver.me" && host !== "brandconnect.naver.com" && !(naverHost && host.includes("shoppingconnect")))
    return null;
  // Parentheses would end the markdown link early.
  return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** The disclosure window already mentions a fee, even if the wording does not pass `hasDisclosure`. */
export function hasDisclosureAttempt(article: Pick<Article, "title" | "body">): boolean {
  return /수수료|대가|원고료/.test(disclosureWindow(article));
}

/** Appends a `[name](link)` line and puts the BC disclosure first, unless the window already has a disclosure or
 *  an attempt at one (a vague one is left for the author to fix rather than stacked). */
export function insertBrandConnectLink(article: Pick<Article, "title" | "body">, name: string, link: string): string {
  const line = `[${name.replace(/[[\]\\]/g, "").trim()}](${link})`;
  const base = article.body.trimEnd();
  const body = base ? `${base}\n\n${line}\n` : `${line}\n`;
  const next = { title: article.title, body };
  return hasDisclosure(next) || hasDisclosureAttempt(next) ? body :`${BRAND_CONNECT_DISCLOSURE}\n\n${body}`;
}

export function affiliateLinkCount(article: Pick<Article, "title" | "body">): number {
  return hostStarts(`${article.title}\n${article.body}`).length;
}

/** An affiliate host starting within the first 300 code points of the body (CRLF→LF). Matched on the whole body,
 *  so a cut at 300 can not turn `naver.me.evil.com` into `naver.me`. */
export function affiliateLinkInLead(article: Pick<Article, "body">): boolean {
  const body = article.body.replace(/\r\n/g, "\n");
  return hostStarts(body).some((i) => Array.from(body.slice(0, i)).length < LEAD_WINDOW);
}

const headingShape = (body: string) =>
  body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) => line.trim())
    .join("\n");

/** Other affiliate articles whose `#` heading lines are exactly the same as this one's. */
export function sameShapeAffiliates(article: Article, others: Article[]): Article[] {
  const shape = headingShape(article.body);
  if (!shape || affiliateLinkCount(article) === 0) return [];
  return others.filter((o) => o.id !== article.id && affiliateLinkCount(o) > 0 && headingShape(o.body) === shape);
}
