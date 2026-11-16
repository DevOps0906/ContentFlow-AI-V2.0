// Browser e2e for /naver-homefeed (CF-25) and the editor affiliate panels (CF-26), local mode, no external keys.
//   node tests/e2e/naver-affiliate.mjs [outDir]     (APP default http://127.0.0.1:3410, dev server already running)
// Exit code 1 when any check fails. Screenshots of failures go to outDir (default: $TEMP/naver-affiliate-<stamp>).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchChrome, sleep } from "./cdp.mjs";

const APP = process.env.E2E_APP ?? "http://127.0.0.1:3410";
const stamp = Date.now().toString(36);
const WORK = resolve(process.env.TEMP ?? "/tmp", "naver-affiliate-" + stamp);
const OUT = resolve(process.argv[2] ?? WORK);
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const results = [];
let page;
async function rec(name, fn) {
  try {
    const d = (await fn()) ?? "";
    results.push({ name, pass: true });
    console.log("PASS", name, d);
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 300);
    results.push({ name, pass: false, msg });
    console.log("FAIL", name, "::", msg);
    try {
      const shot = resolve(OUT, `fail-${results.length}.png`);
      await page.screenshot(shot);
      console.log("     screenshot:", shot);
    } catch {}
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const bodyText = () => page.eval(`document.body.innerText`);
// textContent also sees the closed <details> content
const fullText = () => page.eval(`document.body.textContent`);
// ".approval-label" is shared with the affiliate checkbox; pick the review confirmation by its text
const CONFIRM_INPUT = `[...document.querySelectorAll(".approval-label")].find(l => l.innerText.includes("직접 확인"))?.querySelector("input")`;
const count = (s, sub) => s.split(sub).length - 1;

const STORAGE = "contentflow.articles.v2";
const COUPANG = "https://link.coupang.com/a/abc123";
function seedArticle(id, body, extra = {}) {
  return {
    id,
    title: "쿠팡 가습기 직접 써본 후기",
    keyword: "가습기",
    templateId: "T03",
    platform: "naver",
    body,
    sourceUrl: "https://example.org/spec",
    status: "drafting",
    updatedAt: new Date().toISOString(),
    briefPurpose: "가습기 고르는 법",
    briefAudience: "자취 입문자",
    ...extra,
  };
}
const seed = (articles) =>
  page.eval(`localStorage.setItem(${JSON.stringify(STORAGE)}, ${JSON.stringify(JSON.stringify(articles))}); true`);

async function openEditor(id) {
  await page.goto(`${APP}/content/${id}`, { settle: 1200 });
  await page.waitFor(`!!document.querySelector("#body")`, 30000, "editor body");
}
/** Tab through the page and collect a label for each focus stop. */
async function tabStops(max = 160) {
  await page.eval(`document.activeElement && document.activeElement.blur(); window.scrollTo(0,0); true`);
  const stops = [];
  for (let i = 0; i < max; i++) {
    await page.key("Tab");
    stops.push(await page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return "body"; return (e.id ? "#" + e.id : e.tagName.toLowerCase() + ":" + ((e.getAttribute("aria-label") || e.innerText || e.name || "").replace(/\\s+/g, " ").trim().slice(0, 40))); })()`));
  }
  return stops;
}

const browser = await launchChrome({ port: 9461, userDataDir: resolve(WORK, "profile") });
try {
  page = await browser.newPage({ width: 1440, height: 900 });
  await page.goto(`${APP}/naver-homefeed`, { settle: 1000 });

  // ---------------------------------------------------------------- 홈판: 빈 상태 / 기본 고지
  await rec("홈판 빈 상태 + 새 글 점검 버튼", async () => {
    await page.waitText("아직 점검 중인 글이 없어요");
    ok((await page.buttonState("새 글 점검")) === "enabled", "새 글 점검 버튼이 비활성");
    ok(await page.hasText("노출·수익을 보장하지 않으며"), "보장 안 함 안내 없음");
    ok(!(await page.hasText("저장하지 못했습니다")), "저장 오류가 처음부터 표시됨");
  });
  await rec("성과 비교 N/A (데이터 없음)", async () => {
    const t = await bodyText();
    ok(t.includes("성과 비교"), "성과 비교 섹션 없음");
    const cells = await page.eval(`[...document.querySelectorAll("section[aria-labelledby=hf-summary] tbody tr")].map(r => [...r.querySelectorAll("td")].slice(2).map(c => c.innerText.trim()).join("/"))`);
    ok(cells.length >= 4 && cells.every((c) => c.endsWith("N/A/N/A")), `평균이 N/A 아님: ${JSON.stringify(cells)}`);
    ok(/발견글: 0개 · N\/A/.test(t), "목적 비율 N/A 아님");
  });

  // ---------------------------------------------------------------- 홈판: 입력·점검·성과 N/A
  await rec("새 글 점검 → 6개 섹션 노출", async () => {
    await page.clickText("새 글 점검");
    await page.waitFor(`!!document.querySelector("#hf-main")`, 10000, "form");
    const t = await bodyText();
    for (const h of ["1. 글 목적", "2. 키워드 세트", "3. 제목 점검", "4. 썸네일", "5. 본문 점검", "6. 발행 후 기록"])
      ok(t.includes(h), `섹션 없음: ${h}`);
  });
  await rec("제목 점검 경고 (과장·보장·길이)", async () => {
    await page.fill("#hf-title-input", "무조건 100% 성공하는 가습기 후기 방법 총정리 완벽 가이드 지금 바로 확인 하세요 정말 놀라운 변화가 생깁니다 꼭 읽어보세요");
    await page.waitText("과장·보장 표현은 근거 없이 쓰지 마세요.");
    ok(await page.hasText("제목이 "), "길이 초과 경고 없음");
    await page.fill("#hf-title-input", "가습기 노출 보장 후기");
    await page.waitText("노출·수익 보장 표현은 쓰지 마세요.");
    ok(await page.eval(`document.querySelectorAll(".hf-check.warn").length > 0`), "체크리스트 경고 항목 없음");
  });
  await rec("성과 기록 비우면 N/A (0 아님)", async () => {
    const t = await bodyText();
    ok(/합계 조회수: N\/A/.test(t), "합계 조회수가 N/A 아님");
    const ph = await page.eval(`["hf-home","hf-search","hf-other","hf-comments","hf-neighbors","hf-clip-views"].every(i => { const e = document.getElementById(i); return e && e.value === "" && e.placeholder === "N/A"; })`);
    ok(ph, "성과 입력칸이 빈 값/N/A placeholder가 아님");
    await page.fill("#hf-home", "120");
    await page.waitText("일부 지면 미입력");
    ok(/합계 조회수: N\/A/.test(await bodyText()), "일부만 입력했는데 합계가 N/A 아님");
  });
  await rec("레퍼런스 분석: 키 없음 → '연결 안 됨' + 약관 고지", async () => {
    ok((await page.buttonState("레퍼런스 분석")) === "disabled", "메인 키워드 없이 분석 버튼 활성");
    ok(await page.hasText("메인 키워드를 먼저 입력하세요."), "메인 키워드 안내 없음");
    await page.fill("#hf-main", "가습기");
    await page.clickText("레퍼런스 분석");
    await page.waitText("연결 안 됨", 30000);
    const t = await bodyText();
    ok(!/(검색광고 API\):\s*연결됨)|(검색 API\):\s*연결됨)/.test(t), "키 없이 '연결됨' 표시");
    ok(count(t, "연결 안 됨") >= 2, `연결 안 됨 표시가 2곳 미만: ${count(t, "연결 안 됨")}`);
    const full = await fullText();
    ok(full.includes("출처: 네이버 검색 API"), "검색 API 출처 고지 없음");
    ok(full.includes("출처: 네이버 검색광고 API"), "검색광고 출처 고지 없음");
    ok(full.includes("네이버 검색결과"), "'네이버 검색결과' 표기 없음");
    ok(full.includes("네이버 API 약관 요약") && full.includes("AI 입력·학습·평가에 쓰지 않습니다"), "약관 요약 없음");
    const link = await page.eval(`(() => { const a = [...document.querySelectorAll("details.hf-terms a")][0]; return a ? a.getAttribute("href") + "|" + a.rel + "|" + a.target : ""; })()`);
    ok(/^https:\/\/developers\.naver\.com\/.*\|noopener noreferrer\|_blank$/.test(link), `약관 링크 속성: ${link}`);
  });
  await rec("입력 변경 시 이전 레퍼런스 결과 숨김", async () => {
    await page.fill("#hf-main", "가습기 추천");
    await page.waitText("이전 결과를 숨겼습니다");
  });
  await rec("목적 변경 → 발견글 문구, 새로고침 후 저장 유지", async () => {
    await page.clickText("발견글", { selector: "label.hf-purpose" });
    await page.waitText("발견글에는 상품 광고를 넣지 않습니다");
    await page.reload();
    await page.waitFor(`document.querySelector("#hf-main")?.value === "가습기 추천"`, 10000, "persisted main keyword");
    ok((await page.eval(`document.getElementById("hf-home").value`)) === "120", "성과 값 저장 안 됨");
  });

  // ---------------------------------------------------------------- 홈판: 저장 실패
  await rec("localStorage 저장 실패 → 경고 + 화면 값 유지", async () => {
    await page.eval(`Storage.prototype.setItem = function () { throw new DOMException("quota", "QuotaExceededError"); }; true`);
    await page.fill("#hf-subs", "저장실패테스트");
    await page.waitText("저장하지 못했습니다");
    ok(await page.eval(`!!document.querySelector('[role=alert]')`), "role=alert 없음");
    ok((await page.eval(`document.getElementById("hf-subs").value`)) === "저장실패테스트", "화면 값이 사라짐");
  });
  await rec("저장 데이터가 깨졌을 때 읽기 오류 + 입력 비활성", async () => {
    await page.reload(); // setItem override is gone after reload
    await page.eval(`localStorage.setItem("contentflow.naverHomefeed.v1", "{broken"); true`);
    await page.reload();
    await page.waitText("저장된 홈판 점검 데이터를 읽을 수 없습니다");
    ok((await page.buttonState("새 글 점검")) === "disabled", "읽기 오류인데 새 글 점검이 활성");
    ok((await page.eval(`localStorage.getItem("contentflow.naverHomefeed.v1")`)) === "{broken", "원본이 덮어써짐");
    await page.eval(`localStorage.removeItem("contentflow.naverHomefeed.v1"); true`);
  });

  // ---------------------------------------------------------------- 홈판: 키보드
  await rec("키보드만으로 홈판 주요 입력·버튼 도달 + Enter로 새 글 생성", async () => {
    await page.reload();
    await page.waitText("아직 점검 중인 글이 없어요");
    let stops = await tabStops(60);
    ok(stops.includes("button:새 글 점검"), `새 글 점검 버튼 도달 못함: ${stops.slice(0, 30).join(", ")}`);
    // activate it with the keyboard: focus by Tab, then Enter
    await page.eval(`[...document.querySelectorAll("button")].find(b => b.innerText.includes("새 글 점검")).focus(); true`);
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector("#hf-main")`, 10000, "post created by Enter");
    await page.fill("#hf-main", "키보드");
    stops = await tabStops(140);
    const want = ["#hf-formula", "#hf-main", "#hf-details", "#hf-subs", "#hf-title-input", "button:레퍼런스 분석", "summary:네이버 API 약관 요약", "#hf-thumb-text", "#hf-thumb-type", "#hf-body-input", "#hf-published", "#hf-home", "#hf-search", "#hf-other", "#hf-comments", "#hf-neighbors", "#hf-clip", "#hf-clip-views", "#hf-memo"];
    const missing = want.filter((w) => !stops.some((s) => s === w || s.startsWith(w)));
    ok(missing.length === 0, `Tab으로 도달 못함: ${missing.join(", ")}`);
    ok(stops.some((s) => s.startsWith("input:") ), "라디오/체크박스 도달 못함");
  });
  await rec("키보드: 목적 라디오를 방향키 없이 Space로 선택 가능 (체크박스 Space)", async () => {
    await page.eval(`document.querySelector("input[type=checkbox]").focus(); true`);
    const before = await page.eval(`document.activeElement.checked`);
    await page.key(" ");
    ok((await page.eval(`document.activeElement.checked`)) !== before, "Space로 체크박스가 바뀌지 않음");
  });

  // ---------------------------------------------------------------- 홈판: 3구간 넘침
  const checkHome = (label) => async () => {
    for (const w of [500, 768, 1000, 1440]) {
      await page.viewport(w, 900);
      await sleep(400);
      const o = await page.overflow();
      if (o.over) await page.screenshot(resolve(OUT, `homefeed-${label}-${w}.png`));
      ok(!o.over && !o.scrollable, `${w}px: scrollWidth ${o.sw} > ${o.w}: ${o.wide.join(", ")} (스크린샷 ${resolve(OUT, `homefeed-${label}-${w}.png`)})`);
    }
  };
  await page.fill("#hf-title-input", "가습기 추천 직접 써본 후기 5가지 기준과 고르는 법");
  await page.fill("#hf-main", "가습기");
  await rec("/naver-homefeed 4구간 가로 넘침 0 (정상 길이 제목 28자)", checkHome("normal"));
  await page.viewport(1440, 900);
  const longTitle = "아주 긴 제목 ".repeat(20);
  await page.fill("#hf-title-input", longTitle);
  await page.fill("#hf-details", "가".repeat(80) + ", " + "나".repeat(80));
  await page.fill("#hf-body-input", "https://example.com/" + "a".repeat(200) + "\n" + "긴본문".repeat(100));
  await page.fill("#hf-main", "가습기");
  await page.clickText("레퍼런스 분석");
  await page.waitText("연결 안 됨", 30000);
  for (const w of [500, 768, 1000, 1440]) {
    await rec(`/naver-homefeed ${w}px 가로 넘침 0`, async () => {
      await page.viewport(w, 900);
      await sleep(400);
      const o = await page.overflow();
      if (o.over) await page.screenshot(resolve(OUT, `homefeed-${w}.png`));
      ok(!o.over && !o.scrollable, `scrollWidth ${o.sw} > ${o.w}: ${o.wide.join(", ")} (스크린샷 ${resolve(OUT, `homefeed-${w}.png`)})`);
    });
  }
  await page.viewport(1440, 900);

  // ---------------------------------------------------------------- 편집기: 쿠팡 고지 → 승인 차단/통과
  const idA = "e2e-affiliate-a";
  const bodyA = `## 선택 기준\n\n직접 써 본 경험을 정리합니다. 습도와 소음을 같이 봤어요.\n\n[쿠팡 가습기](${COUPANG})\n`;
  await page.goto(`${APP}/content`, { settle: 800 });
  await seed([seedArticle(idA, bodyA)]);
  await openEditor(idA);

  await rec("편집기 모드는 로컬이고 쿠팡 패널은 '연결 안 됨' + 입력 비활성", async () => {
    ok(await page.hasText("쿠팡 상품"), "쿠팡 상품 패널 없음");
    await page.waitText("연결 안 됨: COUPANG_ACCESS_KEY", 15000);
    const st = await page.eval(`({ kw: document.getElementById("cp-keyword").disabled, url: document.getElementById("cp-url").disabled, search: [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "검색")?.disabled })`);
    ok(st.kw && st.url && st.search, `연결 안 됨인데 입력 활성: ${JSON.stringify(st)}`);
    ok(!/쿠팡[^\n]*연결됨/.test(await bodyText()), "쿠팡 연결됨 표시");
  });
  await rec("쿠팡 링크 본문 → 고지 안내 2곳(본문 아래·패널) + '고지 문구 넣기'", async () => {
    const t = await bodyText();
    ok(count(t, "대가를 받는다는 고지 문구가 글 앞부분에 있어야 해요") >= 2, `고지 안내 수: ${count(t, "대가를 받는다는 고지 문구가 글 앞부분에 있어야 해요")}`);
    ok((await page.eval(`[...document.querySelectorAll("button")].filter(b => b.innerText.includes("고지 문구 넣기")).length`)) >= 1, "고지 문구 넣기 버튼 없음");
  });
  await rec("검수 요청 → 승인 대기 (고지는 승인 때만 막음)", async () => {
    await page.clickText("검수 요청");
    await page.waitFor(`!!document.getElementById("evidenceStatus")`, 15000, "approval_pending panel");
  });
  await rec("고지 없이 승인 → 차단 + 상태 유지", async () => {
    await page.fill("#evidenceStatus", "ok");
    await page.waitFor(`document.getElementById("evidenceStatus").value === "ok"`, 10000, "evidence ok");
    await page.fill("#rightsStatus", "ok");
    await page.waitFor(`document.getElementById("rightsStatus").value === "ok"`, 10000, "rights ok");
    await page.eval(`${CONFIRM_INPUT}.click(); true`);
    await page.waitFor(async () => (await page.buttonState("검토 후 승인")) === "enabled", 10000, "approve enabled");
    await page.clickText("검토 후 승인");
    await page.waitFor(`!!document.querySelector("ul[role=alert]")`, 10000, "blocker list");
    const alert = await page.eval(`document.querySelector("ul[role=alert]").innerText`);
    ok(/고지|수수료|대가/.test(alert), `고지 차단 메시지 아님: ${alert}`);
    const stored = JSON.parse(await page.eval(`localStorage.getItem(${JSON.stringify(STORAGE)})`));
    ok(stored[0].status === "approval_pending", `상태가 바뀜: ${stored[0].status}`);
  });
  await rec("'고지 문구 넣기' → 본문 앞에 1회 삽입, 안내 사라짐", async () => {
    await page.clickText("고지 문구 넣기");
    const body = await page.eval(`document.getElementById("body").value`);
    ok(body.startsWith("이 게시물은 쿠팡 파트너스 활동의 일환으로"), `본문 맨 앞이 고지가 아님: ${body.slice(0, 40)}`);
    ok(count(body, "쿠팡 파트너스 활동의 일환") === 1, "고지가 1회가 아님");
    await page.waitFor(`![...document.querySelectorAll("button")].some(b => b.innerText.includes("고지 문구 넣기"))`, 5000, "notice gone");
  });
  await rec("고지 삽입 후 저장 → 재검수 → 승인 통과", async () => {
    await page.clickText("임시 저장");
    await sleep(800);
    // editing drops approval back to review: ask for review again if needed
    if (await page.eval(`[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "검수 요청" && !b.disabled)`)) {
      await page.clickText("검수 요청");
    }
    await page.waitFor(`!!document.getElementById("evidenceStatus")`, 15000, "approval_pending panel again");
    if ((await page.eval(`document.getElementById("evidenceStatus").value`)) !== "ok") {
      await page.fill("#evidenceStatus", "ok");
      await page.waitFor(`document.getElementById("evidenceStatus").value === "ok"`, 10000, "evidence ok");
    }
    if ((await page.eval(`document.getElementById("rightsStatus").value`)) !== "ok") {
      await page.fill("#rightsStatus", "ok");
      await page.waitFor(`document.getElementById("rightsStatus").value === "ok"`, 10000, "rights ok");
    }
    if (!(await page.eval(`${CONFIRM_INPUT}.checked`)))
      await page.eval(`${CONFIRM_INPUT}.click(); true`);
    await page.waitFor(async () => (await page.buttonState("검토 후 승인")) === "enabled", 10000, "approve enabled");
    await page.clickText("검토 후 승인");
    await page.waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE)}))[0].status === "approved"`, 15000, "status approved");
  });

  // ---------------------------------------------------------------- 편집기: 브랜드커넥트
  const idB = "e2e-affiliate-b";
  await seed([seedArticle(idB, "## 선택 기준\n\n직접 써 본 경험을 정리합니다.\n", { title: "브랜드커넥트 후기" })]);
  await openEditor(idB);
  const bodyVal = () => page.eval(`document.getElementById("body").value`);
  const BC = "이 글은 네이버 쇼핑 커넥트 활동으로, 구매 시 판매 수수료를 받습니다.";
  await rec("BC 링크 넣기 → 본문 끝 링크 + 맨 앞 고지 1회", async () => {
    ok(await page.hasText("브랜드커넥트 링크"), "BC 패널 없음");
    ok((await page.buttonState("링크 넣기")) === "disabled", "빈 입력인데 링크 넣기 활성");
    await page.fill("#bc-link", "https://naver.me/abcDEF");
    await page.fill("#bc-name", "가습기 A");
    await page.fill("#bc-share", "3%");
    await page.eval(`[...document.querySelectorAll("form.bc-form button")][0].click(); true`);
    await page.waitFor(`document.getElementById("body").value.includes("naver.me/abcDEF")`, 10000, "link inserted");
    const b = await bodyVal();
    ok(b.startsWith(BC), `맨 앞이 BC 고지가 아님: ${b.slice(0, 50)}`);
    ok(count(b, BC) === 1, "고지가 1회가 아님");
    ok(b.trimEnd().endsWith("[가습기 A](https://naver.me/abcDEF)"), "링크 줄이 본문 끝이 아님");
    await page.waitText("넣은 링크: 가습기 A · 수익분배율 3%");
    ok(!/브랜드커넥트[^\n]*연결됨/.test(await bodyText()), "BC 연결됨 표시");
  });
  await rec("BC 두 번째 링크 → 고지 중복 삽입 안 함", async () => {
    await page.fill("#bc-link", "https://brandconnect.naver.com/x/1");
    await page.fill("#bc-name", "가습기 B");
    await page.eval(`[...document.querySelectorAll("form.bc-form button")][0].click(); true`);
    await page.waitFor(`document.getElementById("body").value.includes("brandconnect.naver.com/x/1")`, 10000, "second link");
    ok(count(await bodyVal(), BC) === 1, "고지가 중복 삽입됨");
  });
  await rec("BC 잘못된 링크(http·타 도메인) → 오류, 본문 불변", async () => {
    const before = await bodyVal();
    for (const bad of ["http://naver.me/x", "https://evil.example.com/naver.me"]) {
      await page.fill("#bc-link", bad);
      await page.fill("#bc-name", "나쁜 링크");
      await page.eval(`[...document.querySelectorAll("form.bc-form button")][0].click(); true`);
      await page.waitText("네이버 브랜드커넥트 링크");
      ok((await bodyVal()) === before, `잘못된 링크가 본문에 들어감: ${bad}`);
      ok(await page.eval(`document.getElementById("bc-link").getAttribute("aria-invalid") === "true"`), "aria-invalid 아님");
    }
  });
  await rec("naver.me 링크 → 고지 없으면 QA 경고, 고지 있으면 경고 없음", async () => {
    await page.fill("#body", "## 선택 기준\n\n직접 써 본 경험입니다.\n\n[상품](https://naver.me/zzz)\n");
    await page.waitText("naver.me 링크가 있습니다. 브랜드커넥트 링크라면 대가를 받는다는 고지 문구가 글 앞부분에 필요합니다.");
    await page.fill("#body", `${BC}\n\n## 선택 기준\n\n직접 써 본 경험입니다.\n\n[상품](https://naver.me/zzz)\n`);
    await page.waitFor(`!document.body.innerText.includes("naver.me 링크가 있습니다")`, 10000, "warning gone");
  });
  await rec("모호한 기존 고지 → BC 패널 경고, 고지 중복 삽입 안 함", async () => {
    await page.fill("#body", "소정의 수수료를 제공받을 수 있습니다.\n\n본문입니다.\n");
    await page.waitText("기존 고지 문구가 모호합니다");
    await page.fill("#bc-link", "https://naver.me/q");
    await page.fill("#bc-name", "상품");
    await page.eval(`[...document.querySelectorAll("form.bc-form button")][0].click(); true`);
    await page.waitFor(`document.getElementById("body").value.includes("naver.me/q")`, 10000, "link inserted");
    ok(!(await bodyVal()).includes(BC), "모호한 고지가 있는데 BC 고지를 덧붙임");
  });

  // ---------------------------------------------------------------- 편집기: 제휴 저품질 경고 / 키보드 / 넘침
  await rec("C6 경고: 제휴 링크 4개·도입부 링크", async () => {
    const links = [1, 2, 3, 4].map((i) => `[상품${i}](${COUPANG}${i})`).join("\n");
    await page.fill("#body", `${links}\n\n## 선택 기준\n\n본문\n`);
    await page.waitText("제휴 링크가 4개입니다");
    await page.waitText("본문 앞 300자 안에 제휴 링크가 있습니다");
  });
  await rec("편집기 키보드: 쿠팡·BC 입력과 버튼 도달", async () => {
    await page.fill("#bc-link", "https://naver.me/tab");
    await page.fill("#bc-name", "탭 상품");
    const stops = await tabStops(160);
    const want = ["#bc-link", "#bc-name", "#bc-share", "button:링크 넣기", "#body"];
    const missing = want.filter((w) => !stops.some((s) => s === w || s.startsWith(w)));
    ok(missing.length === 0, `도달 못함: ${missing.join(", ")}`);
    // disabled Coupang inputs are intentionally skipped while "연결 안 됨"
    ok(!stops.includes("#cp-keyword"), "연결 안 됨인데 쿠팡 입력에 포커스됨");
  });
  await rec("BC 폼 키보드 제출 (Enter)", async () => {
    await page.fill("#bc-link", "https://naver.me/kbd");
    await page.fill("#bc-name", "키보드 상품");
    await page.eval(`document.getElementById("bc-name").focus(); true`);
    await page.key("Enter");
    await page.waitFor(`document.getElementById("body").value.includes("naver.me/kbd")`, 10000, "enter submit");
  });
  // wide content for overflow
  await page.fill("#body", `${COUPANG_LONG()}\n\n[${"긴상품명".repeat(15)}](${COUPANG})\n`);
  await page.eval(`true`);
  for (const w of [500, 768, 1000, 1440]) {
    await rec(`/content/[id] 편집기 ${w}px 가로 넘침 0`, async () => {
      await page.viewport(w, 900);
      await sleep(400);
      const o = await page.overflow();
      if (o.over) await page.screenshot(resolve(OUT, `editor-${w}.png`));
      ok(!o.over && !o.scrollable, `scrollWidth ${o.sw} > ${o.w}: ${o.wide.join(", ")} (스크린샷 ${resolve(OUT, `editor-${w}.png`)})`);
    });
  }
  await page.viewport(1440, 900);
  ok(page.errors.length === 0, `페이지 예외 ${page.errors.length}: ${page.errors[0]}`);
} catch (e) {
  console.log("FATAL", e?.message ?? e);
  results.push({ name: "스크립트 진행", pass: false, msg: String(e?.message ?? e) });
  try {
    await page.screenshot(resolve(OUT, "fatal.png"));
    console.log("     screenshot:", resolve(OUT, "fatal.png"));
  } catch {}
} finally {
  await browser.close();
}

function COUPANG_LONG() {
  return "https://link.coupang.com/a/" + "x".repeat(180);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n통과 ${results.length - failed.length} / 실패 ${failed.length} / 합계 ${results.length}  (산출물: ${OUT})`);
for (const f of failed) console.log(" -", f.name, "::", f.msg);
process.exit(failed.length ? 1 : 0);
