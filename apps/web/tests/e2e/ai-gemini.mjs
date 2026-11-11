// AI API tab + real Gemini draft e2e against the Docker web container.
//   node tests/e2e/ai-gemini.mjs [outDir]   (APP default http://127.0.0.1:3410)
import { mkdirSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FINAL = resolve(process.argv[2] ?? resolve(here, "../../../../.nomad/e2e"));
const APP = process.env.E2E_APP ?? "http://127.0.0.1:3410";
const WORK = resolve(process.env.TEMP ?? "/tmp", "ai-gemini-" + Date.now().toString(36));
mkdirSync(WORK, { recursive: true });
const email = `aigem-${Date.now().toString(36)}@example.test`;
const PW = "aigem-Passw0rd-1!";
const res = [];
const rec = (n, pass, d = "") => { res.push({ n, pass, d }); console.log(pass ? "PASS" : "FAIL", n, d); };
const KEY = /AIza/;

const browser = await launchChrome({ port: 9444, userDataDir: resolve(WORK, "profile") });
const bodies = [];
try {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.send("Network.enable");
  const reqs = new Map();
  browser.on((m) => {
    if (m.sessionId !== page.s) return;
    if (m.method === "Network.responseReceived") reqs.set(m.params.requestId, m.params.response.url);
    if (m.method === "Network.loadingFinished" && reqs.has(m.params.requestId)) {
      const id = m.params.requestId, url = reqs.get(id);
      page.send("Network.getResponseBody", { requestId: id }).then((r) => bodies.push({ url, body: r.body })).catch(() => {});
    }
  });

  // signup
  await page.goto(`${APP}/login`);
  await page.clickText("계정이 없나요? 가입하기");
  await page.fill("#email", email);
  await page.fill("#password", PW);
  await page.clickText("가입하기", { selector: "button[type=submit]" });
  await page.waitFor(`location.pathname === "/"`, 30000, "signup redirect");

  // (1)(2) settings AI tab via keyboard
  await page.goto(`${APP}/settings`, { settle: 1500 });
  await page.eval(`[...document.querySelectorAll('[role=tab]')].find((e)=>e.innerText.trim()==="일반").focus()`);
  await page.key("Tab");
  const f = await page.focused();
  await page.key("Enter");
  await page.waitText("설정됨", 20000).catch(() => {});
  const tabSel = await page.eval(`[...document.querySelectorAll('[role=tab]')].find((e)=>e.getAttribute("aria-selected")==="true").innerText.trim()`);
  rec("키보드 탭 전환(Tab→Enter)", /AI API/.test(f) && tabSel === "AI API", `focus="${f}" selected=${tabSel}`);
  const gem = await page.eval(`(() => { const dt=[...document.querySelectorAll("dt")].find((e)=>e.innerText.includes("Gemini")); return dt ? dt.nextElementSibling.innerText : null })()`);
  rec("Gemini 설정됨", !!gem && gem.includes("설정됨"), String(gem));
  const modelDefault = await page.waitFor(`(() => { const s=document.querySelector("#ai-model"); return s && s.options[0].text.includes("gemini") && s.options.length>1 ? s.options[0].text : false })()`, 20000, "model options").catch((e) => e.message);
  rec("초안 모델 기본 gemini-3.5-flash", /gemini-3\.5-flash/.test(modelDefault), modelDefault);
  await page.screenshot(resolve(WORK, "ai-tab-1440.png"));
  await page.clickText("연결 테스트");
  const conn = await page.waitFor(`(() => { const t=[...document.querySelectorAll("[role=status]")].map(e=>e.innerText).join(" "); return (t.includes("연결됨") || t.includes("연결하지") || t.includes("잦습니다")) ? t : false })()`, 30000, "test result").catch(async (e) => e.message + " | status=" + (await page.eval(`[...document.querySelectorAll("[role=status],[role=alert]")].map(e=>e.innerText).join(" / ")+" btn="+[...document.querySelectorAll("button")].filter(b=>b.innerText.includes("연결")).map(b=>b.innerText+b.disabled).join()`)));
  rec("연결 테스트(모델 수 표시)", /연결됨 · 사용 가능한 모델 \d+개/.test(conn), conn);

  // (4) breakpoints on AI tab
  const ov = {};
  for (const w of [500, 1440]) {
    await page.viewport(w, 900); await sleep(500);
    await page.screenshot(resolve(WORK, `ai-tab-${w}.png`));
    ov[`ai-${w}`] = await page.overflow();
  }
  await page.viewport(1440, 900);

  // (3) editor draft
  await page.goto(`${APP}/content/new`, { settle: 1500 });
  await page.waitFor(`!!document.querySelector("#keyword")`, 30000, "editor");
  await page.fill("#title", "Docker 포트 충돌 해결").catch(() => {});
  await page.fill("#keyword", "docker 포트 충돌 해결");
  await page.waitFor(`[...document.querySelectorAll("button")].some(b=>b.innerText.includes("AI 초안 생성") && !b.disabled)`, 20000, "AI button enabled");
  const t0 = Date.now();
  await page.clickText("AI 초안 생성");
  const out = await page.waitFor(`(() => { const t=[...document.querySelectorAll("[role=status],[role=alert]")].map(e=>e.innerText).join(" | "); return /AI 초안을 채웠어요|만들지 못했|실패|오류/.test(t) ? t : false })()`, 120000, "draft result").catch((e) => e.message);
  const ms = Date.now() - t0;
  const body = await page.eval(`(document.querySelector("textarea#body")||document.querySelector("textarea[name=body]")||[...document.querySelectorAll("textarea")].sort((a,b)=>b.value.length-a.value.length)[0]||{}).value||""`);
  rec("AI 초안 생성 1회(실제 Gemini)", /AI 초안을 채웠어요/.test(out) && body.length > 100, `${ms}ms, ${body.length}자, msg="${out.slice(0, 160)}", 본문="${body.replace(/\s+/g, " ").slice(0, 160)}"`);
  for (const w of [500, 1440]) {
    await page.viewport(w, 900); await sleep(500);
    await page.screenshot(resolve(WORK, `editor-${w}.png`));
    ov[`editor-${w}`] = await page.overflow();
  }
  const over = Object.entries(ov).filter(([, v]) => v.over || v.scrollable);
  rec("가로 넘침 0 (500/1440, AI탭·편집기)", over.length === 0, JSON.stringify(Object.fromEntries(Object.entries(ov).map(([k, v]) => [k, `${v.sw}/${v.w}`]))) + (over.length ? " " + JSON.stringify(over) : ""));

  // (5) key leak
  await sleep(500);
  const html = [];
  for (const p of ["/settings", "/content/new"]) { await page.goto(`${APP}${p}`, { settle: 800 }); html.push(await page.eval("document.documentElement.outerHTML")); }
  const ls = await page.eval("JSON.stringify([localStorage, sessionStorage])");
  const leaks = [...html.map((h, i) => KEY.test(h) && `html${i}`), KEY.test(ls) && "storage", ...bodies.map((b) => KEY.test(b.body) && b.url)].filter(Boolean);
  rec("키 패턴(AIza) 없음", leaks.length === 0, `HTML ${html.length}건, 응답 ${bodies.length}건 검사${leaks.length ? " 유출: " + leaks.join(",") : ""}`);
  if (page.errors.length) console.log("page errors:", page.errors.slice(0, 3));
} catch (e) {
  rec("실행 오류", false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser.close();
  mkdirSync(FINAL, { recursive: true });
  for (const f of readdirSync(WORK).filter((f) => f.endsWith(".png"))) copyFileSync(resolve(WORK, f), resolve(FINAL, "ai-gemini-" + f));
  const md = `# AI Gemini e2e 보고\n\n계정: ${email} / 앱: ${APP}\n\n| 항목 | 결과 | 상세 |\n|---|---|---|\n${res.map((r) => `| ${r.n} | ${r.pass ? "PASS" : "FAIL"} | ${r.d.replace(/\|/g, "/")} |`).join("\n")}\n\n스크린샷: .nomad/e2e/ai-gemini-*.png\n`;
  writeFileSync(resolve(FINAL, "AI_GEMINI_REPORT.md"), md);
}
