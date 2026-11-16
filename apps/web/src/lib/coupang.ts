// Server-only: Coupang Partners product search (C2) and deeplink (C3), AFFILIATE_COMMERCE.md §4.2.
// One owner's env keys only (r2 ①): local mode, or the account workspace COUPANG_OWNER_WORKSPACE_ID.
// Nothing is called unless COUPANG_ENABLED=1 (r2 ②). Keys are never returned; external error bodies
// are never passed on or logged, only mapped from their status code. Only affiliate links on
// link.coupang.com / coupa.ng are accepted from either API (r2 ⑤).
import { createHmac } from "node:crypto";
import { readCapped } from "./agent-runs";
import { cleanText } from "./naver-research";

export const COUPANG_HOST = "https://api-gateway.coupang.com";
export const SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";
export const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
export const COUPANG_LIMITS = {
  timeoutMs: 8_000,
  responseBytes: 256 * 1024,
  results: 10,
  keywordChars: 50,
  urlChars: 2_000,
  cacheMs: 30 * 60_000,
  cacheEntries: 200,
  /** r2 ③: per user per minute, and per key (all instances) per hour. */
  userPerMinute: 5,
  globalPerHour: 10,
} as const;
const DEFAULT_SUB_ID = "contentflow";

// ---------- 환경·소유자 ----------
export type CoupangConfig = {
  accessKey: string;
  secretKey: string;
  enabled: boolean;
  subId: string | null;
  ownerWorkspaceId: string;
};
export function coupangConfig(env = process.env): CoupangConfig {
  const v = (k: string) => env[k]?.trim() || "";
  const subId = v("COUPANG_SUB_ID") || DEFAULT_SUB_ID;
  return {
    accessKey: v("COUPANG_ACCESS_KEY"),
    secretKey: v("COUPANG_SECRET_KEY"),
    enabled: v("COUPANG_ENABLED") === "1",
    subId: /^[A-Za-z0-9]{1,50}$/.test(subId) ? subId : null,
    ownerWorkspaceId: v("COUPANG_OWNER_WORKSPACE_ID"),
  };
}

/** Who is asking: local mode (this machine) or a signed-in workspace. */
export type CoupangCaller = { mode: "local" } | { mode: "account"; workspaceId: string };
export type Availability =
  | { state: "ready" }
  | { state: "not_configured" | "disabled" | "not_owner"; message: string };
export function coupangAvailability(caller: CoupangCaller, env = process.env): Availability {
  const cfg = coupangConfig(env);
  if (!cfg.accessKey || !cfg.secretKey)
    return { state: "not_configured", message: "연결 안 됨: COUPANG_ACCESS_KEY·COUPANG_SECRET_KEY를 설정해주세요." };
  if (!cfg.subId) return { state: "not_configured", message: "COUPANG_SUB_ID는 영숫자만 쓸 수 있습니다." };
  if (caller.mode === "account" && (!cfg.ownerWorkspaceId || caller.workspaceId !== cfg.ownerWorkspaceId))
    return { state: "not_owner", message: "이 워크스페이스에서는 사용할 수 없습니다." };
  if (!cfg.enabled) return { state: "disabled", message: "쿠팡 연동이 꺼져 있습니다(COUPANG_ENABLED=1로 켜주세요)." };
  return { state: "ready" };
}

// ---------- CEA 서명 ----------
/** yyMMdd'T'HHmmss'Z' in GMT. */
export function signedDate(now: number): string {
  return new Date(now).toISOString().replace(/^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/, "$1$2$3T$4$5$6Z");
}
/** Message = signed-date + method + path + query (without "?"), HMAC-SHA256 hex. */
export function coupangSignature(date: string, method: string, path: string, query: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(`${date}${method}${path}${query}`).digest("hex");
}
export function coupangAuthorization(
  cfg: Pick<CoupangConfig, "accessKey" | "secretKey">,
  method: string,
  path: string,
  query: string,
  now: number,
): string {
  const date = signedDate(now);
  const signature = coupangSignature(date, method, path, query, cfg.secretKey);
  return `CEA algorithm=HmacSHA256, access-key=${cfg.accessKey}, signed-date=${date}, signature=${signature}`;
}

// ---------- 입력·출력 검증 ----------
export function validateKeyword(body: unknown): string {
  const k = (body as { keyword?: unknown } | null)?.keyword;
  if (typeof k !== "string" || k.length > 200) throw new Error("검색어 형식이 올바르지 않습니다.");
  const keyword = k.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!keyword) throw new Error("검색어를 입력해주세요.");
  if (Array.from(keyword).length > COUPANG_LIMITS.keywordChars)
    throw new Error(`검색어는 ${COUPANG_LIMITS.keywordChars}자 이하로 입력해주세요.`);
  return keyword;
}
const PRODUCT_HOSTS = ["coupang.com", "www.coupang.com", "m.coupang.com"];
/** C3 input: an https coupang.com product page only (no credentials, no port). */
export function validateProductUrl(body: unknown): string {
  const raw = (body as { url?: unknown } | null)?.url;
  if (typeof raw !== "string" || !raw.trim() || raw.length > COUPANG_LIMITS.urlChars)
    throw new Error("쿠팡 상품 URL을 입력해주세요.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL 형식이 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !PRODUCT_HOSTS.includes(url.hostname))
    throw new Error("https://www.coupang.com 상품 주소만 변환할 수 있습니다.");
  return url.href;
}
const AFFILIATE_HOSTS = ["link.coupang.com", "coupa.ng"];
/** r2 ⑤: an https link on an affiliate host, or null (the item is dropped). */
export function affiliateLink(s: unknown): string | null {
  if (typeof s !== "string") return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && AFFILIATE_HOSTS.includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export type Product = { name: string; price: number | null; rocket: boolean; url: string };
function payload(json: unknown): unknown {
  const r = (json ?? {}) as { rCode?: unknown; data?: unknown };
  if (r.rCode !== undefined && String(r.rCode) !== "0") throw new CallError("format");
  return r.data;
}
export function parseSearch(json: unknown): Product[] {
  const products = (payload(json) as { productData?: unknown } | null)?.productData;
  if (!Array.isArray(products)) throw new CallError("format");
  const out: Product[] = [];
  for (const raw of products.slice(0, COUPANG_LIMITS.results)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const url = affiliateLink(r.productUrl);
    const name = cleanText(r.productName, 200);
    if (!url || !name) continue;
    const price = typeof r.productPrice === "number" && Number.isFinite(r.productPrice) && r.productPrice >= 0 ? r.productPrice : null;
    out.push({ name, price, rocket: r.isRocket === true, url });
  }
  return out;
}
export function parseDeeplink(json: unknown): string {
  const list = payload(json);
  const first = Array.isArray(list) ? ((list[0] ?? {}) as Record<string, unknown>) : null;
  const link = affiliateLink(first?.shortenUrl);
  if (!link) throw new CallError("format");
  return link;
}

// ---------- 외부 호출 ----------
class CallError extends Error {
  constructor(readonly kind: "http" | "size" | "format", readonly httpStatus = 0) {
    super(kind);
  }
}
/** Only the status code is used; the external body never reaches the browser or the log. */
export function coupangFailure(e: unknown): string {
  if (e instanceof CallError) {
    if (e.kind === "size") return "응답이 너무 큽니다.";
    if (e.kind === "format") return "쿠팡 응답을 읽을 수 없습니다.";
    if (e.httpStatus === 401 || e.httpStatus === 403) return `키·서명 확인이 필요합니다(${e.httpStatus}).`;
    if (e.httpStatus === 429) return "쿠팡 호출 한도를 초과했습니다(429).";
    return `쿠팡 응답 오류(${e.httpStatus}).`;
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "응답 시간이 초과되었습니다(8초).";
  return "쿠팡에 연결하지 못했습니다.";
}
async function call(
  fetchImpl: typeof fetch,
  cfg: CoupangConfig,
  method: "GET" | "POST",
  path: string,
  query: string,
  now: number,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: coupangAuthorization(cfg, method, path, query, now) };
  if (body !== undefined) headers["Content-Type"] = "application/json;charset=UTF-8";
  const res = await fetchImpl(`${COUPANG_HOST}${path}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(COUPANG_LIMITS.timeoutMs),
    cache: "no-store",
    redirect: "error",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CallError("http", res.status);
  }
  const text = await readCapped(res, COUPANG_LIMITS.responseBytes);
  if (text === null) throw new CallError("size");
  try {
    return JSON.parse(text);
  } catch {
    throw new CallError("format");
  }
}

export type CoupangResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
export type CoupangOptions = {
  caller: CoupangCaller;
  /** Shared hourly limit for the one key (`sharedLimited(…, "coupang:global", 10, 1h)`); true = limited. */
  globalLimited: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: number;
};
const AVAILABILITY_STATUS = { not_configured: 503, disabled: 503, not_owner: 403 } as const;
async function run<T>(opts: CoupangOptions, cached: T | undefined, exec: (cfg: CoupangConfig, now: number) => Promise<T>): Promise<CoupangResult<T>> {
  const env = opts.env ?? process.env;
  const available = coupangAvailability(opts.caller, env);
  if (available.state !== "ready") return { ok: false, status: AVAILABILITY_STATUS[available.state], error: available.message };
  if (cached !== undefined) return { ok: true, value: cached };
  if (await opts.globalLimited())
    return { ok: false, status: 429, error: "쿠팡 호출이 이번 시간 한도에 도달했습니다. 잠시 후 다시 시도해주세요." };
  try {
    return { ok: true, value: await exec(coupangConfig(env), opts.now ?? Date.now()) };
  } catch (e) {
    return { ok: false, status: 502, error: coupangFailure(e) };
  }
}

const searchCache = new Map<string, { at: number; items: Product[] }>();
export function resetCoupangCache() {
  searchCache.clear();
}
/** C2: up to 10 products; a successful search is cached for 30 minutes per keyword. */
export async function searchProducts(keyword: string, opts: CoupangOptions): Promise<CoupangResult<Product[]>> {
  const now = opts.now ?? Date.now();
  const key = keyword.toLowerCase();
  const hit = searchCache.get(key);
  const cached = hit && now - hit.at < COUPANG_LIMITS.cacheMs ? hit.items : undefined;
  const result = await run(opts, cached, (cfg, at) => {
    const query = `keyword=${encodeURIComponent(keyword)}&limit=${COUPANG_LIMITS.results}&subId=${cfg.subId}`;
    return call(opts.fetchImpl ?? fetch, cfg, "GET", SEARCH_PATH, query, at).then(parseSearch);
  });
  if (result.ok && !cached) {
    if (searchCache.size >= COUPANG_LIMITS.cacheEntries) searchCache.delete(searchCache.keys().next().value as string);
    searchCache.set(key, { at: now, items: result.value });
  }
  return result;
}
/** C3: one coupang.com URL → its affiliate short link. Not cached. */
export function deeplink(url: string, opts: CoupangOptions): Promise<CoupangResult<string>> {
  return run<string>(opts, undefined, (cfg, at) =>
    call(opts.fetchImpl ?? fetch, cfg, "POST", DEEPLINK_PATH, "", at, { coupangUrls: [url] }).then(parseDeeplink),
  );
}
