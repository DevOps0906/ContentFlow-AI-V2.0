// Browser e2e for the dashboard "mobile app" card and the apps/mobile screens.
// Prerequisites: container on 3410 (mounts ./mobile-dist read-only), `npm run dev -w apps/mobile` on 5173.
//   node tests/e2e/mobile-app.mjs <outDir>
// Writes fake mobile-dist/app.apk + app.json (removed at the end).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const WEB = "http://127.0.0.1:3410";
const MOB = "http://127.0.0.1:5173";
const OUT = resolve(process.argv[2] ?? resolve(root, ".nomad/e2e/mobile"));
mkdirSync(OUT, { recursive: true });
const DIST = resolve(root, "mobile-dist");
const stamp = Date.now().toString(36);
const email = `mob-${stamp}@example.test`;
const PW = "mob-Passw0rd-A!";
const results = [];
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
async function step(group, name, fn) {
  try {
    const d = await fn();
    results.push({ group, name, status: "PASS", detail: d ?? "" });
    console.log(`PASS ${group} | ${name}`);
  } catch (e) {
    results.push({ group, name, status: "FAIL", detail: String(e?.message ?? e).slice(0, 300) });
    console.log(`FAIL ${group} | ${name} :: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
const cleanDist = () => {
  for (const f of ["app.apk", "app.json"]) rmSync(resolve(DIST, f), { force: true });
};
const apk = randomBytes(300 * 1024);
const goodHash = createHash("sha256").update(apk).digest("hex");
const putDist = (hash) => {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(resolve(DIST, "app.apk"), apk);
  writeFileSync(
    resolve(DIST, "app.json"),
    JSON.stringify({ version: "9.9.9", versionCode: 99, channel: "dev", sha256: hash, builtAt: "2026-11-12T00:00:00Z" }),
  );
};
const cardText = (p) => p.eval(`document.querySelector(".mobile-app-card")?.innerText ?? ""`);
const loadCard = async (p) => {
  await p.goto(`${WEB}/`, { settle: 1000 });
  await p.waitFor(`!!document.querySelector(".mobile-app-card") && !document.querySelector(".mobile-app-card").innerText.includes("불러오는 중")`, 20000, "card loaded");
};

cleanDist();
const browser = await launchChrome({ port: 9335, userDataDir: resolve(process.env.TEMP ?? "/tmp", "mob-profile-" + stamp) });
let P, M;
try {
  P = await browser.newPage({ width: 1280 });

  // ===== (1) 대시보드 카드 =====
  await step("카드", "가입 → 대시보드", async () => {
    await P.goto(`${WEB}/login`);
    await P.clickText("계정이 없나요? 가입하기");
    await P.fill("#email", email);
    await P.fill("#password", PW);
    await P.clickText("가입하기", { selector: "button[type=submit]" });
    await P.waitFor(`location.pathname === "/"`, 30000, "redirect after signup");
  });
  await step("카드", "파일 없음: 안내·버튼 없음·iOS 미지원", async () => {
    await loadCard(P);
    const t = await cardText(P);
    ok(t.includes("아직 배포된 앱 없음"), t);
    ok(t.includes("iOS") && t.includes("미지원"), "iOS 문구 없음: " + t);
    ok((await P.eval(`document.querySelectorAll('.mobile-app-card a, .mobile-app-card button').length`)) === 0, "버튼/링크가 있음");
    const r = await P.api("GET", "/api/mobile/app/download");
    ok(r.status >= 400, "다운로드 상태 " + r.status);
    return `download ${r.status}`;
  });
  await step("카드", "정상 파일: 버전·개발용·크기·SHA-256·링크", async () => {
    putDist(goodHash);
    await loadCard(P);
    const t = await cardText(P);
    ok(t.includes("9.9.9") && t.includes("(99)"), "버전: " + t);
    ok(t.includes("개발용"), "개발용 배지 없음");
    ok(/300(\.0)? KB|0\.3 MB|\b3\d\d KB/.test(t), "크기: " + t);
    ok(t.includes(goodHash), "SHA-256 불일치 표시");
    const href = await P.eval(`document.querySelector('.mobile-app-card a[download]')?.getAttribute('href')`);
    ok(href === "/api/mobile/app/download", "링크 " + href);
    return t.replace(/\s+/g, " ").slice(0, 120);
  });
  await step("카드", "다운로드 바이트 해시 = SHA-256", async () => {
    const r = await P.eval(`fetch("/api/mobile/app/download").then(async (r) => {
      const b = await r.arrayBuffer();
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      return { status: r.status, len: b.byteLength, hash: h, type: r.headers.get("content-type"), cd: r.headers.get("content-disposition") };
    })`);
    ok(r.status === 200, "status " + r.status);
    ok(r.len === apk.length, `len ${r.len} != ${apk.length}`);
    ok(r.hash === goodHash, "해시 불일치");
    return `${r.type} | ${r.cd}`;
  });
  await step("카드", "키보드로 다운로드 링크 도달", async () => {
    await loadCard(P);
    await P.eval(`document.activeElement?.blur(); window.scrollTo(0,0)`);
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
      await P.key("Tab");
      found = await P.eval(`document.activeElement?.getAttribute?.("href") === "/api/mobile/app/download"`);
    }
    ok(found, "80회 Tab 안에 도달 못함");
  });
  await step("카드", "3구간 스크린샷·가로 넘침 0", async () => {
    const out = [];
    for (const w of [500, 768, 1440]) {
      await P.viewport(w, 900);
      await loadCard(P);
      const o = await P.overflow();
      await P.screenshot(resolve(OUT, `mobile-card-${w}.png`));
      out.push(`${w}:${o.over || o.scrollable ? "OVER " + o.wide.join(",") : "ok"}`);
      ok(!o.over && !o.scrollable, `넘침 ${w}: ${JSON.stringify(o)}`);
    }
    return out.join(" ");
  });
  await P.viewport(1280, 900);
  await step("카드", "해시 틀림: 카드 사용 불가·다운로드 503", async () => {
    putDist("0".repeat(64));
    await loadCard(P);
    const t = await cardText(P);
    ok(t.includes("검증에 실패"), "카드: " + t);
    ok((await P.eval(`document.querySelectorAll('.mobile-app-card a').length`)) === 0, "링크가 남아 있음");
    const r = await P.api("GET", "/api/mobile/app/download");
    ok(r.status === 503, "status " + r.status);
    await P.screenshot(resolve(OUT, "mobile-card-invalid-1280.png"));
  });

  // ===== (2) 모바일 화면 =====
  const title = `모바일 확인 ${stamp}`;
  const bodyText = "모바일 본문 첫 줄 " + stamp + "\n두 번째 줄입니다.";
  let articleId;
  await step("글 준비", "웹에서 키워드→글 1건 생성 후 본문 저장", async () => {
    await P.goto(`${WEB}/keywords`, { settle: 1200 });
    await P.waitFor(`!document.body.innerText.includes("불러오는 중")`, 20000, "keywords");
    const csv = resolve(OUT, "kw.csv");
    writeFileSync(csv, `키워드,검색의도,우선순위,메모\n${title},문제 해결,1,e2e\n`);
    await P.upload("#keyword-csv", [csv]);
    await P.waitText("1개 추가");
    await P.clickText(`${title} 글 만들기`);
    await P.waitText("아이디어 단계로 만들었어요");
    const href = await P.eval(`document.querySelector('.keywords-created a').getAttribute('href')`);
    articleId = href.split("/").pop();
    const a = (await P.api("GET", `/api/articles/${articleId}`)).data.article;
    const r = await P.api("PUT", `/api/articles/${articleId}`, { ...a, body: bodyText, updatedAt: new Date().toISOString() });
    ok(r.status === 200, `PUT ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
    return articleId;
  });

  for (const w of [390, 768]) {
    M = await browser.newPage({ width: w, height: 844 });
    await step(`모바일 ${w}`, "로그인", async () => {
      await M.goto(MOB, { settle: 1000 });
      await M.waitFor(`!!document.querySelector("input[type=email]")`, 20000, "login form");
      await M.fill("input[type=email]", email);
      await M.fill("input[type=password]", PW);
      await M.clickText("로그인", { selector: "button[type=submit]" });
      await M.waitFor(`!!document.querySelector(".tabbar")`, 30000, "tabbar after login");
      await M.screenshot(resolve(OUT, `mobile-app-list-${w}.png`));
    });
    await step(`모바일 ${w}`, "글 목록·상태 필터", async () => {
      await M.waitText(title);
      await M.eval(`(() => { const s = document.querySelector(".filter select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "approved"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await sleep(300);
      ok(await M.hasText("해당하는 글이 없습니다"), "approved 필터에 글이 남음");
      ok(!(await M.hasText(title)), "필터 후에도 제목 표시");
      await M.eval(`(() => { const s = document.querySelector(".filter select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "idea"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await M.waitText(title, 5000);
    });
    await step(`모바일 ${w}`, "상세: 본문 텍스트", async () => {
      await M.clickText(title, { selector: "button.row" });
      await M.waitText("모바일 본문 첫 줄 " + stamp);
      ok(await M.hasText("두 번째 줄입니다"), "본문 2줄째 없음");
      ok((await M.eval(`document.querySelectorAll(".body script, .body img").length`)) === 0, "본문에 script/img");
      await M.screenshot(resolve(OUT, `mobile-app-detail-${w}.png`));
    });
    await step(`모바일 ${w}`, "승인 대기 탭", async () => {
      await M.clickText("승인 대기", { selector: ".tabbar button" });
      await M.waitFor(`document.querySelector("h1")?.innerText === "승인 대기"`, 5000, "heading");
      ok((await M.eval(`!!document.querySelector(".filter")`)) === false, "필터가 보임");
      await M.waitText("승인을 기다리는 글이 없습니다", 10000);
      await M.screenshot(resolve(OUT, `mobile-app-approvals-${w}.png`));
    });
    await step(`모바일 ${w}`, "하단 탭 키보드 조작", async () => {
      await M.clickText("글", { selector: ".tabbar button", exact: true });
      await M.eval(`[...document.querySelectorAll(".tabbar button")][0].focus()`);
      await M.key("Tab"); // -> 승인 대기
      ok((await M.focused()).includes("승인 대기"), "포커스 " + (await M.focused()));
      await M.key("Enter");
      await M.waitFor(`document.querySelector("h1")?.innerText === "승인 대기"`, 5000, "approvals via keyboard");
      await M.key("Tab"); // -> 계정
      await M.key(" ");
      await M.waitFor(`document.querySelector("h1")?.innerText === "계정"`, 5000, "account via keyboard");
      const cur = await M.eval(`document.querySelector('.tabbar [aria-current=page]')?.innerText`);
      ok(cur === "계정", "aria-current " + cur);
    });
    await step(`모바일 ${w}`, "저장소에 토큰 없음", async () => {
      const s = await M.eval(`JSON.stringify({ l: Object.entries(localStorage), s: Object.entries(sessionStorage), c: document.cookie })`);
      ok(!/eyJ|token|refresh|access/i.test(s), "의심 값: " + s.slice(0, 200));
      return s.slice(0, 80);
    });
    await step(`모바일 ${w}`, "계정 탭 로그아웃", async () => {
      await M.screenshot(resolve(OUT, `mobile-app-account-${w}.png`));
      ok(await M.hasText(email), "이메일 미표시");
      await M.clickText("로그아웃");
      await M.waitFor(`!!document.querySelector("input[type=email]") && !document.querySelector(".tabbar")`, 10000, "login screen");
      const o = await M.overflow();
      ok(!o.over, "가로 넘침 " + JSON.stringify(o));
    });
    await M.close?.();
  }
} finally {
  cleanDist();
  const md = ["# 모바일 앱 카드·화면 e2e 결과", "", "| 그룹 | 항목 | 결과 | 상세 |", "|---|---|---|---|"];
  for (const r of results) md.push(`| ${r.group} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  writeFileSync(resolve(OUT, "mobile-results.md"), md.join("\n") + "\n");
  const f = results.filter((r) => r.status === "FAIL").length;
  console.log(`\nPASS ${results.length - f} FAIL ${f}`);
  await browser.close?.();
  process.exit(f ? 1 : 0);
}
