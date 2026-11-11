// Template example dialog + GNB e2e against the Docker web container.
//   node tests/e2e/template-examples.mjs [outDir]   (APP default http://127.0.0.1:3410)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? resolve(here, "../../../../.nomad/e2e"));
const APP = process.env.E2E_APP ?? "http://127.0.0.1:3410";
const WORK = resolve(process.env.TEMP ?? "/tmp", "tplex-" + Date.now().toString(36));
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });
const email = `tplex-${Date.now().toString(36)}@example.test`;
const PW = "tplex-Passw0rd-1!";
const res = [];
const rec = (n, pass, d = "") => { res.push({ n, pass, d }); console.log(pass ? "PASS" : "FAIL", n, d); };
const DLG = `document.querySelector('[role=dialog]')`;
const BTN = (i) => `(() => { const b=[...document.querySelectorAll("button")].filter(b=>b.innerText.includes("예시 보기"))[${i}]; b.scrollIntoView({block:"center"}); `;

const browser = await launchChrome({ port: 9455, userDataDir: resolve(WORK, "profile") });
try {
  const page = await browser.newPage({ width: 1440, height: 900 });
  const cons = [];
  browser.on((m) => {
    if (m.sessionId !== page.s || m.method !== "Runtime.consoleAPICalled") return;
    const t = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (["error", "warning"].includes(m.params.type)) cons.push(t.slice(0, 160));
  });
  await page.goto(`${APP}/login`);
  await page.clickText("계정이 없나요? 가입하기");
  await page.fill("#email", email);
  await page.fill("#password", PW);
  await page.clickText("가입하기", { selector: "button[type=submit]" });
  await page.waitFor(`location.pathname === "/"`, 30000, "signup redirect");

  // hydration / badge on dashboard and /content
  for (const path of ["/", "/content"]) {
    const e0 = page.errors.length, c0 = cons.length;
    await page.goto(`${APP}${path}`, { settle: 1500 });
    await page.waitFor(`!document.querySelector(".topbar")?.innerText.includes("확인 중")`, 15000, "mode loaded").catch(() => {});
    const badge = await page.eval(`document.querySelector(".topbar")?.innerText.replace(/\\s+/g," ")`);
    const hyd = cons.slice(c0).filter((t) => /hydrat|418|423|425|did not match/i.test(t)).length;
    rec(`${path} 예외 0·하이드레이션 경고 0`, page.errors.length === e0 && hyd === 0, `exceptions=${page.errors.length - e0} consoleErrWarn=${cons.length - c0} hydration=${hyd} ${cons.slice(c0).join(" | ").slice(0, 200)}`);
    if (path === "/") rec("상단 배지 '계정 · DB 저장'", /계정 · DB 저장/.test(badge), badge.slice(0, 80));
  }
  // (1) GNB
  const nav = await page.eval(`({
    first: document.querySelector('nav[aria-label="주 메뉴"] a')?.innerText.trim(),
    items: [...document.querySelectorAll('nav[aria-label="주 메뉴"] a')].map(a=>a.innerText.replace(/\\s+/g," ").trim()),
    sidebarText: document.querySelector('aside, .sidebar')?.innerText ?? "",
    topbar: document.querySelector('.topbar')?.innerText.replace(/\\s+/g," ") ?? ""
  })`);
  rec("GNB 첫 메뉴 = 대시보드", nav.first === "대시보드", JSON.stringify(nav.items));
  rec("GNB(사이드바)에 '나의 워크스페이스' 없음", !nav.sidebarText.includes("나의 워크스페이스") && !(await page.hasText("나의 워크스페이스")), `topbar="${nav.topbar.slice(0, 40)}"`);
  await page.clickText("환경설정", { selector: "a.nav-item" });
  await page.waitFor(`location.pathname === "/settings"`, 15000, "settings nav");
  const h1 = await page.eval(`document.querySelector("h1")?.innerText.trim()`);
  rec("하단 환경설정 링크 → 설정 화면 제목 '환경설정'", h1 === "환경설정", `h1=${h1}`);

  // (2)(3) per-template
  await page.goto(`${APP}/templates`, { settle: 1000 });
  const cardCount = await page.eval(`[...document.querySelectorAll("button")].filter(b=>b.innerText.includes("예시 보기")).length`);
  rec("/templates '예시 보기' 버튼 10개", cardCount === 10, `count=${cardCount}`);
  const info = [];
  for (let i = 0; i < cardCount; i++) {
    await page.eval(`${BTN(i)} b.focus(); })()`);
    const f0 = await page.focused();
    await page.key("Enter");
    await page.waitFor(`!!${DLG}`, 5000, `dialog ${i}`).catch(() => {});
    const d = await page.eval(`(() => { const d=${DLG}; if(!d) return null; const t=d.innerText;
      return { title: d.querySelector("h2")?.innerText, meta: d.querySelector(".example-meta")?.innerText,
        notice: t.includes("예시 글 — 가상 정보"), h3: d.querySelectorAll("h3").length, paras: d.querySelectorAll("p").length,
        placeholder: t.includes("예시 이미지 준비 중"), imgs: d.querySelectorAll("img").length, len: t.length,
        focus: document.activeElement.getAttribute("aria-label") }})()`);
    if (!d) { info.push({ i, ok: false, why: "no dialog" }); continue; }
    const ok = !!d.title && d.notice && d.h3 > 0 && d.paras > 0 && (d.placeholder || d.imgs > 0);
    const row = { i, ok, ...d, trigger: f0 };
    info.push(row);
    await page.key("Escape");
    await sleep(300);
    const closed = await page.eval(`!${DLG}`);
    const f1 = await page.focused();
    row.esc = closed && f1.includes("예시 보기");
    row.focusBack = f1;
  }
  rec("10개 대화상자: 제목/가상정보 문구/블록 본문/이미지(자리표시자 또는 img)", info.length === 10 && info.every((x) => x.ok), info.map((x) => `${x.meta ?? x.i}:${x.ok ? "ok" : "NG"}${x.placeholder ? "P" : ""}${x.imgs ? "I" + x.imgs : ""}`).join(" "));
  rec("10개 모두 Enter로 열림 + Esc 닫힘 + 버튼 포커스 복귀", info.every((x) => x.esc), info.filter((x) => !x.esc).map((x) => `${x.i}:${x.focusBack}`).join(" "));
  rec("자리표시자 '예시 이미지 준비 중' 표시 확인", info.some((x) => x.placeholder), `표시=${info.filter((x) => x.placeholder).length}/10, 미표시(실제 이미지)=${info.filter((x) => !x.placeholder).map((x) => x.meta).join(",")}`);

  // focus trap
  await page.eval(`${BTN(0)} b.focus(); })()`);
  await page.key("Enter");
  await page.waitFor(`!!${DLG}`, 5000, "dialog trap");
  const trail = [];
  for (let i = 0; i < 8; i++) {
    await page.key("Tab");
    trail.push(await page.eval(`(${DLG}?.contains(document.activeElement)) ? "in" : "OUT"`));
  }
  for (let i = 0; i < 4; i++) {
    await page.key("Tab", { shift: true });
    trail.push(await page.eval(`(${DLG}?.contains(document.activeElement)) ? "in" : "OUT"`));
  }
  rec("Tab/Shift+Tab 포커스가 대화상자 안에 갇힘", !trail.includes("OUT"), trail.join(","));
  await page.key("Escape"); await sleep(300);

  // (6) viewports with dialog
  for (const w of [500, 768, 1000, 1440]) {
    await page.viewport(w, 900); await sleep(400);
    await page.goto(`${APP}/templates`, { settle: 600 });
    const o1 = await page.overflow();
    await page.screenshot(resolve(OUT, `tplex-templates-${w}.png`), { full: false });
    await page.eval(`${BTN(0)} b.click(); })()`);
    await page.waitFor(`!!${DLG}`, 5000, "dlg vp");
    await sleep(400);
    const dm = await page.eval(`(() => { const d=${DLG}, b=d.querySelector(".example-body"), r=d.getBoundingClientRect();
      const before=b.scrollTop; b.scrollTop=99999; const after=b.scrollTop; const act=d.querySelector(".editor-actions").getBoundingClientRect();
      b.scrollTop=0;
      return { scrollable: b.scrollHeight>b.clientHeight, scrolled: after>before, dlgH: Math.round(r.height), vh: innerHeight, dlgW: Math.round(r.width), vw: innerWidth,
        fits: r.top>=0 && r.bottom<=innerHeight+1 && r.left>=0 && r.right<=innerWidth+1, actionsVisible: act.bottom<=innerHeight+1 && act.top>=0 } })()`);
    await page.screenshot(resolve(OUT, `tplex-dialog-${w}.png`), { full: false });
    const o2 = await page.overflow();
    rec(`${w}px 문서 가로 넘침 0(목록·대화상자)`, !o1.over && !o2.over, `list sw=${o1.sw}/${o1.w} dialog sw=${o2.sw}/${o2.w}`);
    rec(`${w}px 대화상자 내부 스크롤/뷰포트 수용/버튼 가시`, dm.fits && dm.actionsVisible && (!dm.scrollable || dm.scrolled), JSON.stringify(dm));
    await page.key("Escape"); await sleep(200);
  }
  await page.viewport(1440, 900);

  // (4) card dialog -> use
  await page.goto(`${APP}/templates`, { settle: 800 });
  await page.eval(`${BTN(3)} b.click(); })()`);
  await page.waitFor(`!!${DLG}`, 5000, "dlg use");
  const meta = await page.eval(`${DLG}.querySelector(".example-meta").innerText`);
  const tid = meta.split(" ")[0];
  await page.clickText("이 템플릿으로 작성", { selector: "[role=dialog] a" });
  await page.waitFor(`location.pathname === "/content/new"`, 15000, "to editor");
  await page.waitFor(`!!document.querySelector("#template")`, 20000, "editor");
  await sleep(500);
  const sel = await page.eval(`({ v: document.querySelector("#template").value, url: location.search })`);
  rec("카드 대화상자 '이 템플릿으로 작성' → 편집기 템플릿 적용", sel.v === tid, `meta=${meta} select=${sel.v} ${sel.url}`);

  // (5) editor example button
  const other = tid === "T02" ? "T03" : "T02";
  await page.eval(`(() => { const s=document.querySelector("#template"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(s,"${other}"); s.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  await sleep(600);
  await page.eval(`(() => { const b=[...document.querySelectorAll("button")].find(b=>b.innerText.includes("예시 보기")); b.scrollIntoView({block:"center"}); b.focus(); })()`);
  await page.key("Enter");
  await page.waitFor(`!!${DLG}`, 5000, "editor dlg").catch(() => {});
  const ed = await page.eval(`(() => { const d=${DLG}; return d ? { meta: d.querySelector(".example-meta")?.innerText, title: d.querySelector("h2")?.innerText, notice: d.innerText.includes("예시 글 — 가상 정보") } : null })()`);
  rec("편집기 '예시 보기' → 선택 템플릿 예시 대화상자", !!ed && ed.meta?.startsWith(other) && ed.notice, JSON.stringify(ed));
  await page.screenshot(resolve(OUT, "tplex-editor-dialog-1440.png"), { full: false });
  await page.clickText("이 템플릿으로 작성", { selector: "[role=dialog] button" });
  await sleep(500);
  const closed = await page.eval(`!${DLG}`);
  const f = await page.focused();
  rec("편집기 대화상자 '이 템플릿으로 작성' → 닫힘·포커스 복귀·템플릿 유지", closed && f.includes("예시 보기") && (await page.eval(`document.querySelector("#template").value`)) === other, `focus=${f}`);
  for (const w of [500, 768, 1000, 1440]) {
    await page.viewport(w, 900); await sleep(400);
    const o = await page.overflow();
    await page.screenshot(resolve(OUT, `tplex-editor-${w}.png`), { full: false });
    rec(`편집기 ${w}px 문서 가로 넘침 0`, !o.over, `sw=${o.sw}/${o.w} ${o.wide.join(",")}`);
  }
  rec("페이지 런타임 예외 없음", page.errors.length === 0, page.errors.slice(0, 2).join(" | "));
  writeFileSync(resolve(OUT, "tplex-results.json"), JSON.stringify({ res, info }, null, 1));
} catch (e) {
  rec("스크립트 오류", false, e.stack?.slice(0, 400));
} finally {
  await browser.close();
}
console.log(`\n${res.filter((r) => r.pass).length}/${res.length} PASS`);
process.exit(res.every((r) => r.pass) ? 0 : 1);
