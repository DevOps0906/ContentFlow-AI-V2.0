import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COUPANG_LIMITS,
  affiliateLink,
  coupangAuthorization,
  coupangAvailability,
  coupangSignature,
  deeplink,
  parseSearch,
  searchProducts,
  signedDate,
  validateKeyword,
  validateProductUrl,
  type CoupangOptions,
} from "../src/lib/coupang";
import { resetRateLimits, sharedLimited } from "../src/lib/server";

const NOW = 1700000000000; // 2023-11-14T22:13:20Z
const ENV = {
  COUPANG_ACCESS_KEY: "test-access",
  COUPANG_SECRET_KEY: "test-secret",
  COUPANG_ENABLED: "1",
  COUPANG_OWNER_WORKSPACE_ID: "ws-owner",
} as unknown as NodeJS.ProcessEnv;
const SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function mockFetch(respond: (url: string) => Response, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string });
    return respond(url);
  }) as typeof fetch;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const searchJson = {
  rCode: "0",
  data: {
    productData: [
      { productName: "<b>노트북</b> 거치대", productPrice: 15900, isRocket: true, productUrl: "https://link.coupang.com/re/AFFSDP?x=1" },
      { productName: "가짜", productPrice: 1000, isRocket: false, productUrl: "https://evil.example/re" },
      { productName: "http 링크", productPrice: 1000, isRocket: false, productUrl: "http://link.coupang.com/re" },
      { productName: "가격 없음", productPrice: "abc", isRocket: "yes", productUrl: "https://coupa.ng/abc" },
    ],
  },
};
function opts(over: Partial<CoupangOptions> = {}): CoupangOptions {
  return { caller: { mode: "local" }, globalLimited: async () => false, env: ENV, now: NOW, ...over };
}

test("서명: 고정 입력 벡터와 Authorization 형식", () => {
  assert.equal(signedDate(NOW), "231114T221320Z");
  const query = `keyword=${encodeURIComponent("노트북")}&limit=10&subId=contentflow`;
  assert.equal(
    coupangSignature("231114T221320Z", "GET", SEARCH_PATH, query, "test-secret"),
    "015e270765fbb0e68497bfa444b91c2e6c0dfde21041ae16d876362b0c5ba74b",
  );
  assert.equal(
    coupangAuthorization({ accessKey: "test-access", secretKey: "test-secret" }, "GET", SEARCH_PATH, query, NOW),
    "CEA algorithm=HmacSHA256, access-key=test-access, signed-date=231114T221320Z, signature=015e270765fbb0e68497bfa444b91c2e6c0dfde21041ae16d876362b0c5ba74b",
  );
});

test("단일 소유자: 로컬·소유 워크스페이스만 ready", () => {
  assert.equal(coupangAvailability({ mode: "local" }, ENV).state, "ready");
  assert.equal(coupangAvailability({ mode: "account", workspaceId: "ws-owner" }, ENV).state, "ready");
  assert.deepEqual(coupangAvailability({ mode: "account", workspaceId: "ws-other" }, ENV), {
    state: "not_owner",
    message: "이 워크스페이스에서는 사용할 수 없습니다.",
  });
  const noOwner = { ...ENV, COUPANG_OWNER_WORKSPACE_ID: "" } as NodeJS.ProcessEnv;
  assert.equal(coupangAvailability({ mode: "account", workspaceId: "ws-owner" }, noOwner).state, "not_owner");
  assert.equal(coupangAvailability({ mode: "local" }, {} as NodeJS.ProcessEnv).state, "not_configured");
  assert.equal(coupangAvailability({ mode: "local" }, { ...ENV, COUPANG_SUB_ID: "a-b" } as NodeJS.ProcessEnv).state, "not_configured");
});

test("COUPANG_ENABLED 미설정·키 없음·다른 워크스페이스: 외부 호출 없음", async () => {
  const calls: Call[] = [];
  const f = mockFetch(() => ok(searchJson), calls);
  const off = await searchProducts("노트북", opts({ fetchImpl: f, env: { ...ENV, COUPANG_ENABLED: "" } as NodeJS.ProcessEnv }));
  assert.deepEqual(off, { ok: false, status: 503, error: "쿠팡 연동이 꺼져 있습니다(COUPANG_ENABLED=1로 켜주세요)." });
  const none = await deeplink("https://www.coupang.com/vp/products/1", opts({ fetchImpl: f, env: {} as NodeJS.ProcessEnv }));
  assert.equal(none.ok, false);
  const other = await searchProducts("노트북", opts({ fetchImpl: f, caller: { mode: "account", workspaceId: "x" } }));
  assert.equal(!other.ok && other.status, 403);
  assert.equal(calls.length, 0);
});

test("검색: 요청 형식, 허용 호스트만, 캐시 없음", async () => {
  const calls: Call[] = [];
  const r = await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => ok(searchJson), calls) }));
  assert.ok(r.ok);
  assert.deepEqual(r.value, [
    { name: "노트북 거치대", price: 15900, rocket: true, url: "https://link.coupang.com/re/AFFSDP?x=1" },
    { name: "가격 없음", price: null, rocket: false, url: "https://coupa.ng/abc" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api-gateway.coupang.com${SEARCH_PATH}?keyword=${encodeURIComponent("노트북")}&limit=10&subId=contentflow`);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].headers.Authorization.endsWith("signature=015e270765fbb0e68497bfa444b91c2e6c0dfde21041ae16d876362b0c5ba74b"));

  await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => ok(searchJson), calls) }));
  assert.equal(calls.length, 2, "같은 검색어도 매번 조회");
});

test("오류: 상태 코드만 매핑하고 외부 본문은 비노출, 실패 뒤에도 매번 조회", async () => {
  const secret = "SECRET-BODY access-key=test-access";
  for (const [status, message] of [
    [401, "키·서명 확인이 필요합니다(401)."],
    [403, "키·서명 확인이 필요합니다(403)."],
    [429, "쿠팡 호출 한도를 초과했습니다(429)."],
    [500, "쿠팡 응답 오류(500)."],
  ] as const) {
    const r = await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => new Response(secret, { status })) }));
    assert.deepEqual(r, { ok: false, status: 502, error: message });
  }
  const bad = await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => ok({ rCode: "400", rMessage: secret })) }));
  assert.deepEqual(bad, { ok: false, status: 502, error: "쿠팡 응답을 읽을 수 없습니다." });
  const big = await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => new Response("x".repeat(COUPANG_LIMITS.responseBytes + 10))) }));
  assert.deepEqual(big, { ok: false, status: 502, error: "응답이 너무 큽니다." });
  const timeout = await searchProducts("노트북", opts({
    fetchImpl: (async () => {
      throw Object.assign(new Error(secret), { name: "TimeoutError" });
    }) as unknown as typeof fetch,
  }));
  assert.deepEqual(timeout, { ok: false, status: 502, error: "응답 시간이 초과되었습니다(8초)." });
  const calls: Call[] = [];
  assert.ok((await searchProducts("노트북", opts({ fetchImpl: mockFetch(() => ok(searchJson), calls) }))).ok);
  assert.equal(calls.length, 1, "실패 뒤 재조회");
});

test("딥링크: 요청 본문과 단축 링크 호스트 허용 목록", async () => {
  const calls: Call[] = [];
  const good = await deeplink(
    "https://www.coupang.com/vp/products/1",
    opts({ fetchImpl: mockFetch(() => ok({ rCode: "0", data: [{ shortenUrl: "https://link.coupang.com/a/abc" }] }), calls) }),
  );
  assert.deepEqual(good, { ok: true, value: "https://link.coupang.com/a/abc" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink");
  assert.deepEqual(JSON.parse(calls[0].body!), { coupangUrls: ["https://www.coupang.com/vp/products/1"] });
  const evil = await deeplink(
    "https://www.coupang.com/vp/products/1",
    opts({ fetchImpl: mockFetch(() => ok({ rCode: "0", data: [{ shortenUrl: "https://evil.example/a" }] })) }),
  );
  assert.equal(evil.ok, false);
  assert.equal(affiliateLink("https://coupa.ng/x"), "https://coupa.ng/x");
  assert.equal(affiliateLink("https://link.coupang.com.evil.com/x"), null);
  assert.equal(affiliateLink("https://user@link.coupang.com/x"), null);
  assert.equal(affiliateLink("javascript:alert(1)"), null);
  assert.deepEqual(parseSearch({ rCode: "0", data: { productData: [] } }), []);
});

test("전역 한도 분리(검색 분당 40·딥링크 시간당 10)와 사용자 한도(분당 5)", async () => {
  resetRateLimits();
  assert.equal(COUPANG_LIMITS.searchGlobalPerMinute, 40);
  assert.equal(COUPANG_LIMITS.deeplinkGlobalPerHour, 10);
  const calls: Call[] = [];
  const search = () => sharedLimited(null, "coupang:global:search", COUPANG_LIMITS.searchGlobalPerMinute, 60_000);
  const link = () => sharedLimited(null, "coupang:global:deeplink", COUPANG_LIMITS.deeplinkGlobalPerHour, 3_600_000);
  for (let i = 0; i < 40; i++) {
    const r = await searchProducts("노트북", opts({ globalLimited: search, fetchImpl: mockFetch(() => ok(searchJson), calls) }));
    assert.ok(r.ok);
  }
  const over = await searchProducts("노트북", opts({ globalLimited: search, fetchImpl: mockFetch(() => ok(searchJson), calls) }));
  assert.deepEqual(over, { ok: false, status: 429, error: "쿠팡 호출이 한도에 도달했습니다. 잠시 후 다시 시도해주세요." });
  assert.equal(calls.length, 40, "같은 검색어 40회 모두 외부 호출(캐시 없음)");
  // The search budget does not consume the deeplink budget.
  const dl = JSON.stringify({ rCode: "0", data: [{ shortenUrl: "https://link.coupang.com/a/abc" }] });
  for (let i = 0; i < 10; i++) {
    const r = await deeplink("https://www.coupang.com/vp/products/1", opts({ globalLimited: link, fetchImpl: mockFetch(() => ok(JSON.parse(dl)), calls) }));
    assert.ok(r.ok);
  }
  const dlOver = await deeplink("https://www.coupang.com/vp/products/1", opts({ globalLimited: link, fetchImpl: mockFetch(() => ok(JSON.parse(dl)), calls) }));
  assert.equal(!dlOver.ok && dlOver.status, 429);
  assert.equal(calls.length, 50);

  resetRateLimits();
  const user = () => sharedLimited(null, "coupang:user-1", COUPANG_LIMITS.userPerMinute, 60_000);
  for (let i = 0; i < 5; i++) assert.equal(await user(), false);
  assert.equal(await user(), true);
  resetRateLimits();
});

test("입력 검증: 검색어와 쿠팡 상품 URL", () => {
  assert.equal(validateKeyword({ keyword: "  노트북   거치대 " }), "노트북 거치대");
  assert.throws(() => validateKeyword({ keyword: " " }));
  assert.throws(() => validateKeyword({ keyword: 1 }));
  assert.throws(() => validateKeyword({ keyword: "가".repeat(51) }));
  assert.equal(validateProductUrl({ url: "https://www.coupang.com/vp/products/1?itemId=2" }), "https://www.coupang.com/vp/products/1?itemId=2");
  assert.equal(validateProductUrl({ url: "https://m.coupang.com/vm/products/1" }), "https://m.coupang.com/vm/products/1");
  assert.equal(validateProductUrl({ url: "https://coupang.com/vp/products/1" }), "https://coupang.com/vp/products/1");
  for (const url of [
    "http://www.coupang.com/vp/products/1",
    "https://evil.com/?coupang.com",
    "https://www.coupang.com.evil.com/x",
    "https://user:pw@www.coupang.com/x",
    "https://www.coupang.com:8443/x",
    "https://link.coupang.com/a/abc",
    "javascript:alert(1)",
    "",
  ])
    assert.throws(() => validateProductUrl({ url }), url);
  assert.throws(() => validateProductUrl({ url: `https://www.coupang.com/${"a".repeat(2000)}` }));
});
