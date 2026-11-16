import { test } from "node:test";
import assert from "node:assert/strict";
import {
  affiliateLinkCount,
  affiliateLinkInLead,
  BRAND_CONNECT_DISCLOSURE,
  brandConnectUrl,
  hasDisclosureAttempt,
  insertBrandConnectLink,
  sameShapeAffiliates,
} from "../src/lib/affiliate";
import { COUPANG_DISCLOSURE, disclosureErrors, hasDisclosure, type Article } from "../src/lib/content";
import { runQa } from "../src/lib/qa";

const intro = "포트 사용 여부를 확인하고 충돌하는 프로세스를 종료합니다. ".repeat(12);
const article: Article = {
  id: "a",
  title: "캠핑 의자 비교 후기",
  keyword: "캠핑 의자",
  templateId: "T03",
  platform: "wordpress",
  body: `## 고르는 기준\n${intro}\n## 추천\n[의자](https://coupa.ng/abc)`,
  sourceUrl: "https://nextjs.org/docs",
  status: "drafting",
  updatedAt: "2026-11-16T00:00:00Z",
};
const codes = (a: Article, others: Article[] = []) => runQa(a, others).warnings.map((w) => w.code);

test("C4: only https Naver Brand Connect hosts are accepted", () => {
  assert.equal(brandConnectUrl(" https://naver.me/xYz "), "https://naver.me/xYz");
  assert.equal(brandConnectUrl("https://BrandConnect.naver.com/p/1"), "https://brandconnect.naver.com/p/1");
  assert.ok(brandConnectUrl("https://shoppingconnect.naver.com/a"));
  assert.ok(brandConnectUrl("https://m.shoppingconnect.naver.com/a"));
  for (const bad of [
    "",
    "naver.me/x",
    "http://naver.me/x",
    "https://naver.me.evil.com/x",
    "https://shoppingconnect.evil.com/a",
    "https://evilnaver.com/shoppingconnect",
    "https://blog.naver.com/x",
    "https://user:pw@naver.me/x",
    "https://naver.me:8443/x",
    "javascript:alert(1)",
  ])
    assert.equal(brandConnectUrl(bad), null, bad);
  assert.equal(brandConnectUrl("https://naver.me/a(b)"), "https://naver.me/a%28b%29");
});

test("C4: inserting a link adds the BC disclosure first only when none is present", () => {
  const body = insertBrandConnectLink({ title: "제목", body: "## 소개\n본문" }, "캠핑 [의자]", "https://naver.me/x");
  assert.equal(body, `${BRAND_CONNECT_DISCLOSURE}\n\n## 소개\n본문\n\n[캠핑 의자](https://naver.me/x)\n`);
  assert.ok(hasDisclosure({ title: "제목", body }));

  const disclosed = `${COUPANG_DISCLOSURE}\n\n본문`;
  assert.equal(
    insertBrandConnectLink({ title: "제목", body: disclosed }, "의자", "https://naver.me/x"),
    `${disclosed}\n\n[의자](https://naver.me/x)\n`,
  );
  assert.equal(
    insertBrandConnectLink({ title: "제목", body: "" }, "의자", "https://naver.me/x"),
    `${BRAND_CONNECT_DISCLOSURE}\n\n[의자](https://naver.me/x)\n`,
  );
});

test("C4: repeated inserts add the disclosure once, and a vague one is left alone", () => {
  let doc = { title: "제목", body: "## 소개\n본문" };
  for (const n of ["의자", "텐트", "랜턴"]) doc = { ...doc, body: insertBrandConnectLink(doc, n, `https://naver.me/${n}`) };
  assert.equal(doc.body.split(BRAND_CONNECT_DISCLOSURE).length - 1, 1);

  const vague = { title: "제목", body: "소정의 수수료를 제공받을 수 있습니다.\n본문" };
  assert.ok(hasDisclosureAttempt(vague) && !hasDisclosure(vague));
  const next = insertBrandConnectLink(vague, "의자", "https://naver.me/x");
  assert.ok(!next.includes(BRAND_CONNECT_DISCLOSURE));
  assert.ok(next.startsWith("소정의 수수료"));
  assert.ok(!hasDisclosureAttempt({ title: "제목", body: "본문" }));
});

test("C4: a BC link is not an approval blocker", () => {
  assert.deepEqual(disclosureErrors({ title: "제목", body: "[의자](https://brandconnect.naver.com/p/1)" }), []);
});

test("C6: four or more affiliate links warn, three do not", () => {
  const links = (n: number) => Array.from({ length: n }, (_, i) => `[상품${i}](https://${i % 2 ? "naver.me" : "link.coupang.com"}/${i})`);
  const three = { ...article, body: `${article.body}\n${links(2).join("\n")}` };
  assert.equal(affiliateLinkCount(three), 3);
  assert.ok(!codes(three).includes("affiliate-link-count"));
  const four = { ...article, body: `${article.body}\n${links(3).join("\n")}` };
  assert.equal(affiliateLinkCount(four), 4);
  assert.ok(codes(four).includes("affiliate-link-count"));
  assert.equal(affiliateLinkCount({ title: "", body: "https://naver.me.evil.com https://xcoupa.ng https://smartnaver.me" }), 0);
  // C4 hosts count too, and links one space apart are each counted.
  assert.equal(
    affiliateLinkCount({
      title: "",
      body: "https://brandconnect.naver.com/p/1 https://m.shoppingconnect.naver.com/a coupa.ng naver.me",
    }),
    4,
  );
  assert.equal(
    affiliateLinkCount({ title: "", body: "https://brandconnect.naver.com.evil.com https://shoppingconnect.evil.com https://blog.naver.com" }),
    0,
  );
});

test("C6: an affiliate link in the first 300 code points of the body warns", () => {
  assert.ok(!affiliateLinkInLead(article));
  assert.ok(!codes(article).includes("affiliate-link-lead"));
  const lead = { ...article, body: `[의자](https://coupa.ng/a)\n${article.body}` };
  assert.ok(affiliateLinkInLead(lead));
  assert.ok(codes(lead).includes("affiliate-link-lead"));
  assert.ok(affiliateLinkInLead({ body: `${"😀".repeat(270)} https://naver.me/a` }));
  assert.ok(!affiliateLinkInLead({ body: `${"😀".repeat(300)} https://naver.me/a` }));
  // Matched on the whole body: a cut at 300 must not turn a lookalike host into naver.me.
  assert.ok(!affiliateLinkInLead({ body: "x".repeat(283) + " https://naver.me.evil.com/a" }));
  assert.ok(affiliateLinkInLead({ body: "x".repeat(283) + " https://naver.me/a" }));
  assert.ok(affiliateLinkInLead({ body: "[의자](https://shoppingconnect.naver.com/a)\n본문" }));
  assert.ok(affiliateLinkInLead({ body: "[의자](https://brandconnect.naver.com/p/1)\n본문" }));
});

test("C6: another affiliate article with the same heading lines warns", () => {
  const twin = { ...article, id: "b", body: `## 고르는 기준\r\n다른 내용\r\n## 추천\r\nhttps://naver.me/q` };
  assert.deepEqual(sameShapeAffiliates(article, [article, twin]).map((a) => a.id), ["b"]);
  assert.ok(codes(article, [twin]).includes("affiliate-same-shape"));
  const plain = { ...twin, body: "## 고르는 기준\n다른 내용\n## 추천\n링크 없음" };
  assert.ok(!codes(article, [plain]).includes("affiliate-same-shape"));
  const different = { ...twin, body: "## 고르는 기준\n## 후기\nhttps://naver.me/q" };
  assert.ok(!codes(article, [different]).includes("affiliate-same-shape"));
  const noLinks = { ...article, body: "## 고르는 기준\n## 추천\n본문" };
  assert.deepEqual(sameShapeAffiliates(noLinks, [twin]), []);
});
