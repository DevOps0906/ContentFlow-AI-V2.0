// W8 browser e2e: team, auth, revenue, AI review, W1~W11, keyboard, save failure, 3 breakpoints.
// Prerequisites (see tests/e2e/README in the report): local Supabase, WordPress dev container,
// `node tests/e2e/start-server.mjs <wp-cred-file>` running (fake AI + next dev on 3392).
//   node tests/e2e/w8.mjs <wp-cred-file> [outDir]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 3392}`;
const AI = `http://127.0.0.1:${process.env.E2E_AI_PORT ?? 4791}`;
const WP = "http://127.0.0.1:8081";
const MAIL = "http://127.0.0.1:60324";
// Work outside the watched project tree (writes inside it make next dev reload the page);
// the report, screenshots and downloads are copied to FINAL at the end.
const FINAL = resolve(process.argv[3] ?? resolve(root, ".nomad/logs/w8"));
const OUT = resolve(process.env.E2E_WORK ?? resolve(process.env.TEMP ?? "/tmp", "w8-run-" + Date.now().toString(36)));
const SHOTS = resolve(OUT, "shots");
const FILES = resolve(OUT, "files");
const DL = resolve(OUT, "downloads");
for (const d of [OUT, SHOTS, FILES, DL]) mkdirSync(d, { recursive: true });
const [wpUser, wpPass] = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/);
const wpAuth = "Basic " + Buffer.from(`${wpUser}:${wpPass}`).toString("base64");

const stamp = Date.now().toString(36);
const emailA = `w8a-${stamp}@example.test`;
const emailB = `w8b-${stamp}@example.test`;
const PW_A = "w8-Passw0rd-A!";
const PW_A2 = "w8-Passw0rd-A2!";
const PW_B = "w8-Passw0rd-B!";

// ---- result collection ---------------------------------------------------------------------
const results = [];
const ctx = {};
async function step(flow, name, fn, { needs = [] } = {}) {
  const missing = needs.filter((k) => !ctx[k]);
  if (missing.length) {
    results.push({ flow, name, status: "SKIP", detail: `선행 실패: ${missing.join(", ")}` });
    console.log(`SKIP ${flow} | ${name}`);
    return;
  }
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ flow, name, status: "PASS", detail: detail ?? "", ms: Date.now() - t });
    console.log(`PASS ${flow} | ${name}`);
  } catch (e) {
    results.push({ flow, name, status: "FAIL", detail: String(e?.message ?? e).slice(0, 400), ms: Date.now() - t });
    console.log(`FAIL ${flow} | ${name} :: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---- helpers -------------------------------------------------------------------------------
function sql(q) {
  const out = execFileSync("docker", ["exec", "supabase_db_ContentFlow-AI-V2.0", "psql", "-U", "postgres", "-tAc", q], { encoding: "utf8" });
  return out.trim();
}
const sqlJson = (q) => JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${q}) t`) || "[]");
async function wp(path, init = {}) {
  const res = await fetch(`${WP}/wp-json/wp/v2${path}`, {
    ...init,
    headers: { Authorization: wpAuth, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const aiMode = (mode) => fetch(`${AI}/__mode`, { method: "POST", body: JSON.stringify({ mode }) });
const wsOf = (email) =>
  sql(`select m.workspace_id from memberships m join auth.users u on u.id = m.user_id where u.email = '${email}' and m.role = 'owner' limit 1`);

async function signup(page, email, password) {
  await page.goto(`${APP}/login`);
  await page.clickText("계정이 없나요? 가입하기");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.clickText("가입하기", { selector: "button[type=submit]" });
  await page.waitFor(`location.pathname === "/"`, 30000, "redirect after signup");
}
async function login(page, email, password) {
  await page.goto(`${APP}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
}
async function openArticle(page, id) {
  await page.goto(`${APP}/content/${id}`, { settle: 1200 });
  await page.waitFor(`!!document.querySelector("#title") && document.querySelector("#title").value !== undefined`, 30000, "editor");
  await page.waitText("진행 상태");
}
const statusOf = async (page, id) => (await page.api("GET", `/api/articles/${id}`)).data?.article?.status;
const alertText = (page) =>
  page.eval(`[...document.querySelectorAll('[role=alert]')].map((e) => e.innerText).join(" | ")`);
const statusText = (page) =>
  page.eval(`[...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(" | ")`);

/** Drives an article through the API (same checks as the UI) up to `target`. */
async function articleTo(page, base, target) {
  const steps = {
    approval_pending: ["approval_pending"],
    approved: ["approval_pending", "review", "approved"],
    export_ready: ["approval_pending", "review", "approved", "export_ready"],
  }[target];
  let a = base;
  const put = async (status) => {
    const r = await page.api("PUT", `/api/articles/${a.id}`, { ...a, status, updatedAt: new Date().toISOString() });
    ok(r.status === 200, `PUT ${status}: ${r.status} ${JSON.stringify(r.data)}`);
    a = r.data.article;
  };
  await put("drafting");
  for (const s of steps) {
    if (s === "review") {
      const r = await page.api("PATCH", `/api/articles/${a.id}/review`, { evidenceStatus: "ok", rightsStatus: "ok" });
      ok(r.status === 200, `review PATCH ${r.status} ${JSON.stringify(r.data)}`);
      a = r.data.article;
    } else if (s === "approval_pending") {
      let r = await page.api("PUT", `/api/articles/${a.id}`, { ...a, status: "approval_pending", updatedAt: new Date().toISOString() });
      if (r.status !== 200) {
        await put("qa_pending");
        r = await page.api("PUT", `/api/articles/${a.id}`, { ...a, status: "approval_pending", updatedAt: new Date().toISOString() });
      }
      ok(r.status === 200, `PUT approval_pending: ${r.status} ${JSON.stringify(r.data)}`);
      a = r.data.article;
    } else await put(s);
  }
  return a;
}
// The article is created from the default template (T01): every required heading must be present.
function cleanBody(kw) {
  return [
    "## 핵심 답변",
    `${kw} 오류가 발생하는 상황을 정리했습니다. 공식 문서의 절차를 따라 재현했습니다.`,
    "## 대상과 적용 조건",
    "포트가 이미 다른 프로세스에서 사용 중일 때 발생합니다.",
    "## 단계별 안내",
    "사용 중인 프로세스를 종료하거나 다른 포트를 지정합니다.",
    "## 주의 사항",
    "서버를 다시 실행해 정상 응답을 확인합니다.",
    "## FAQ",
    "자주 묻는 질문은 공식 문서에서 확인할 수 있습니다.",
    "## 출처",
    "공식 문서를 참고했습니다.",
  ].join("\n");
}

// ---- run -----------------------------------------------------------------------------------
const browser = await launchChrome({ port: 9333, userDataDir: resolve(OUT, "chrome-profile") });
let A, B;
try {
  A = await browser.newPage({ width: 1280, downloadPath: DL });
  B = await browser.newPage({ width: 1280 });

  // ===== 인증 =====
  await step("인증", "가입 화면: 짧은 비밀번호 거절(실패 경로)", async () => {
    await A.goto(`${APP}/login`);
    await A.clickText("계정이 없나요? 가입하기");
    await A.fill("#email", emailA);
    await A.fill("#password", "short");
    await A.click("button[type=submit]");
    await A.waitFor(`!!document.querySelector('[role=alert]')`, 15000, "signup error");
    const msg = await alertText(A);
    ok(await A.eval(`location.pathname === "/login"`), "이동하면 안 됨");
    return msg;
  });
  await step("인증", "가입(A) → 대시보드 이동", async () => {
    await signup(A, emailA, PW_A);
    ctx.A = true;
    await A.api("GET", "/api/session");
    ctx.wsA = wsOf(emailA);
    ok(ctx.wsA, "A 워크스페이스 없음");
    return `workspace ${ctx.wsA}`;
  });
  await step("인증", "로그아웃 → 틀린 비밀번호 로그인 거절", async () => {
    await A.clickText("로그아웃");
    await A.waitFor(`location.pathname === "/login"`, 20000, "login page");
    await login(A, emailA, "wrong-password-1");
    await A.waitFor(`!!document.querySelector('[role=alert]')`, 15000, "login error");
    const msg = await alertText(A);
    ok(await A.eval(`location.pathname === "/login"`), "로그인되면 안 됨");
    return msg;
  }, { needs: ["A"] });
  await step("인증", "올바른 비밀번호 로그인", async () => {
    await login(A, emailA, PW_A);
    await A.waitFor(`location.pathname === "/"`, 20000, "dashboard");
    const s = await A.api("GET", "/api/session");
    ok(s.data?.user?.email === emailA && s.data?.user?.role === "owner", JSON.stringify(s.data));
    return "role=owner";
  }, { needs: ["A"] });
  await step("인증", "로그인 없이 API 접근 거절", async () => {
    const r = await B.eval(`fetch("${APP}/api/articles").then(r => r.status)`).catch(async () => {
      await B.goto(`${APP}/login`);
      return B.eval(`fetch("/api/articles").then(r => r.status)`);
    });
    ok(r === 401, `status ${r}`);
    return `401`;
  });

  await step("인증", "가입 직후 동시 요청 5건 → 개인 워크스페이스 1개(경합 재현)", async () => {
    const C = await browser.newPage({ width: 1280 });
    const emailC = `w8c-${stamp}@example.test`;
    await C.goto(`${APP}/login`);
    const r = await C.api("POST", "/api/auth/signup", { email: emailC, password: PW_B });
    ok(r.status === 200, `signup ${r.status}`);
    // Several tabs/components asking at once on the first visit (the dashboard does this too).
    await C.eval(`Promise.all(Array.from({ length: 5 }, () => fetch("/api/session").then((r) => r.status)))`);
    const n = Number(sql(`select count(*) from memberships m join auth.users u on u.id = m.user_id where u.email = '${emailC}' and m.role = 'owner'`));
    ok(n === 1, `소유 워크스페이스 ${n}개 생성됨 (apps/web/src/lib/supabase.ts activeWorkspace 첫 로그인 분기)`);
    return "1개";
  });

  // ===== W9 블로그 계정 =====
  await step("W9 블로그 계정", "설정에서 계정 추가 → 목록 표시", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitFor(`!!document.querySelector("#blog-name")`, 30000, "blog form");
    await A.fill("#blog-name", "W8 워드프레스");
    await A.fill("#blog-platform", "wordpress");
    await A.fill("#blog-domain", "w8-blog.example.test");
    await A.clickText("계정 추가");
    await A.waitText("w8-blog.example.test");
    const r = await A.api("GET", "/api/blogs");
    const blog = (r.data?.blogs ?? []).find((b) => b.domain === "w8-blog.example.test");
    ok(blog, JSON.stringify(r.data).slice(0, 200));
    ctx.blogId = blog.id;
    return blog.id;
  }, { needs: ["A"] });
  await step("W9 블로그 계정", "빈 주소 저장 거절(실패 경로)", async () => {
    await A.fill("#blog-name", "주소 없음");
    await A.fill("#blog-domain", "");
    await A.clickText("계정 추가");
    await A.waitFor(`[...document.querySelectorAll('[role=alert]')].some(e => e.innerText.trim())`, 10000, "error");
    return await alertText(A);
  }, { needs: ["blogId"] });

  // ===== 키워드 → 아이디어 글 (W7 브리프 포함) =====
  const kw = `W8 포트 오류 ${stamp}`;
  await step("키워드→글", "키워드 CSV 가져오기", async () => {
    const f = resolve(FILES, "keywords.csv");
    writeFileSync(f, `키워드,검색의도,우선순위,메모\n${kw},문제 해결,1,e2e\n`);
    await A.goto(`${APP}/keywords`, { settle: 1200 });
    await A.waitFor(`!document.body.innerText.includes("불러오는 중")`, 20000, "keywords loaded");
    await A.upload("#keyword-csv", [f]);
    await A.waitText("1개 추가");
    await A.waitText(kw);
    ctx.keyword = true;
  }, { needs: ["A"] });
  await step("키워드→글", "글 만들기 → 아이디어 단계 글 생성", async () => {
    await A.clickText(`${kw} 글 만들기`);
    await A.waitText("아이디어 단계로 만들었어요");
    const href = await A.eval(`document.querySelector('.keywords-created a').getAttribute('href')`);
    ctx.id1 = href.split("/").pop();
    ok((await statusOf(A, ctx.id1)) === "idea", "status != idea");
    return ctx.id1;
  }, { needs: ["keyword"] });
  await step("W7 브리프", "자료 조사 → 브리프, 브리프 없이 초안 시작 거절", async () => {
    await openArticle(A, ctx.id1);
    await A.clickText("자료 조사 시작");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "researching", 15000, "researching");
    await A.clickText("브리프 작성 시작");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "briefing", 15000, "briefing");
    await A.clickText("초안 작성 시작");
    await A.waitFor(`!!document.querySelector('ul[role=alert]')`, 10000, "brief errors");
    const msg = await alertText(A);
    ok((await statusOf(A, ctx.id1)) === "briefing", "brief 없이 전이됨");
    return msg;
  }, { needs: ["id1"] });
  await step("W7 브리프", "브리프·근거·블로그 계정 입력 후 초안 작성 시작", async () => {
    await A.fill("#title", `${kw} 해결 가이드`);
    await A.fill("#brief-purpose", "포트 충돌 오류를 스스로 해결하게 돕는다");
    await A.fill("#brief-audience", "Windows 입문 개발자");
    await A.fill("#source", "https://nextjs.org/docs");
    await A.clickText("초안 작성 시작");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "drafting", 15000, "drafting");
    if (ctx.blogId) {
      await A.fill("#blog-account", ctx.blogId);
      await A.waitText("블로그 계정을 바꿨어요");
      const a = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
      ok(a.blogId === ctx.blogId, `blogId ${a.blogId}`);
    }
    ctx.drafting = true;
  }, { needs: ["id1"] });

  // ===== AI 초안 (W1) =====
  await step("AI·W1", "AI 초안 생성(가짜 서버) → 본문 채움·모델 표시", async () => {
    await A.clickText("AI 초안 생성");
    const dialog = await A.eval(`!!document.querySelector('[role=dialog]')`);
    if (dialog) await A.clickText("AI 초안으로 교체");
    await A.waitText("AI 초안을 채웠어요");
    const body = await A.eval(`document.querySelector('#body').value`);
    ok(body.includes("[확인 필요]") && body.includes("##"), "본문 미반영");
    ok(await A.hasText("fake-writer"), "모델명 미표시");
    return `본문 ${body.length}자`;
  }, { needs: ["drafting"] });
  await step("AI·W1", "AI 실패(가짜 500) → 오류 표시, 본문 유지", async () => {
    const before = await A.eval(`document.querySelector('#body').value`);
    await aiMode("fail");
    try {
      await A.clickText("AI 초안 생성");
      await A.waitFor(`!!document.querySelector('[role=dialog]')`, 5000, "overwrite dialog");
      await A.clickText("AI 초안으로 교체");
      await A.waitFor(`!!document.querySelector('ul[role=alert]')`, 20000, "ai error");
    } finally {
      await aiMode("ok");
    }
    const after = await A.eval(`document.querySelector('#body').value`);
    ok(before === after, "실패 후 본문이 바뀜");
    return await alertText(A);
  }, { needs: ["drafting"] });
  await step("AI·W1", "agent_runs 기록(성공·실패, 토큰·비용)", async () => {
    const rows = sqlJson(`select task, model, status, tokens_in, tokens_out, cost_estimate, cost_currency from agent_runs where workspace_id = '${ctx.wsA}' order by created_at`);
    ok(rows.length >= 2, `rows ${rows.length}`);
    const okRow = rows.find((r) => r.status === "succeeded" || r.status === "success" || r.status === "ok");
    const failRow = rows.find((r) => r !== okRow && r.status !== okRow?.status);
    ok(okRow && okRow.tokens_in === 120 && okRow.tokens_out === 340, `ok row ${JSON.stringify(okRow)}`);
    ok(okRow.cost_estimate !== null && okRow.cost_currency === "USD", "비용 미계산");
    ok(failRow && failRow.tokens_in === null, `fail row ${JSON.stringify(failRow)}`);
    return JSON.stringify(rows);
  }, { needs: ["drafting"] });

  // ===== 저장 실패 =====
  await step("저장 실패", "임시 저장 500 → 오류 표시·입력 유지·미저장 표시", async () => {
    await A.fill("#title", `${kw} 해결 가이드 (수정)`);
    const unroute = await A.route(`${APP}/api/articles/*`, (req) =>
      req.method === "PUT" ? { status: 500, body: { error: "E2E 가짜 저장 실패" } } : undefined,
    );
    try {
      await A.clickText("임시 저장");
      await A.waitText("E2E 가짜 저장 실패");
    } finally {
      await unroute();
    }
    ok((await A.eval(`document.querySelector('#title').value`)).includes("(수정)"), "입력 유실");
    ok(await A.hasText("저장하지 않은 변경 있음"), "미저장 표시 없음");
    const stored = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    ok(!stored.title.includes("(수정)"), "서버에 저장됨");
    await A.screenshot(resolve(SHOTS, "save-failure-500-1280.png"), { full: false });
    return "alert 표시";
  }, { needs: ["drafting"] });
  await step("저장 실패", "네트워크 단절 → 오류 표시, 복구 후 저장 성공", async () => {
    const unroute = await A.route(`${APP}/api/articles/*`, (req) => (req.method === "PUT" ? "fail" : undefined));
    let msg;
    try {
      await A.clickText("임시 저장");
      await A.waitFor(`!!document.querySelector('ul[role=alert]')`, 10000, "network error");
      msg = await alertText(A);
    } finally {
      await unroute();
    }
    await A.clickText("임시 저장");
    await A.waitFor(async () => (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article.title.includes("(수정)"), 15000, "saved");
    ok(!(await A.hasText("저장하지 않은 변경 있음")), "저장 후에도 미저장 표시");
    return msg;
  }, { needs: ["drafting"] });

  // ===== 검수·승인 =====
  await step("검수·승인", "[확인 필요] 남은 채 검수 요청 → 수정 필요", async () => {
    await A.clickText("검수 요청", { selector: ".editor-actions button" });
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "needs_revision", 15000, "needs_revision");
    return "needs_revision";
  }, { needs: ["drafting"] });
  await step("검수·승인", "본문 정리 → 검수 요청 → 승인 대기", async () => {
    await A.fill("#body", cleanBody(kw));
    // Editing a needs_revision article already shows it as drafting; review is requested directly.
    await A.clickText("검수 요청", { selector: ".editor-actions button" });
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "approval_pending", 15000, "approval_pending");
    ctx.pending1 = true;
  }, { needs: ["drafting"] });
  await step("AI 검수", "AI 교차 검수 → 참고 의견 표시, 상태 불변", async () => {
    await A.reload();
    await A.waitText("진행 상태");
    await A.clickText("AI 교차 검수");
    await A.waitText("AI 교차 검수 의견 (참고용)");
    ok(await A.hasText("근거 문서 링크가 본문에 없습니다."), "의견 미표시");
    ok(await A.hasText("fake-reviewer"), "검수 모델 미표시");
    ok((await statusOf(A, ctx.id1)) === "approval_pending", "AI 검수가 상태를 바꿈");
    return "findings 2";
  }, { needs: ["pending1"] });
  await step("AI 검수", "AI 검수 실패 → 오류 표시", async () => {
    await aiMode("fail");
    try {
      await A.clickText("AI 교차 검수");
      await A.waitFor(`[...document.querySelectorAll('.qa-panel [role=alert]')].some(e => e.innerText.trim())`, 20000, "review error");
    } finally {
      await aiMode("ok");
    }
    return await A.eval(`document.querySelector('.qa-panel [role=alert]').innerText`);
  }, { needs: ["pending1"] });
  await step("검수·승인", "근거·권리 미검토면 승인 버튼 비활성", async () => {
    await A.reload();
    await A.waitText("진행 상태");
    const s = await A.buttonState("검토 후 승인");
    ok(s === "disabled", `button ${s}`);
    return s;
  }, { needs: ["pending1"] });
  await step("키보드", "근거·권리 select와 확인 체크박스를 키보드로 조작 → Enter로 승인", async () => {
    await A.fill("#evidenceStatus", "ok");
    await A.waitFor(async () => (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article.evidenceStatus === "ok", 10000, "evidence ok");
    await A.fill("#rightsStatus", "ok");
    await A.waitFor(async () => (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article.rightsStatus === "ok", 10000, "rights ok");
    await A.eval(`document.querySelector('.approval-label input').focus()`);
    await A.key(" ");
    ok(await A.eval(`document.querySelector('.approval-label input').checked`), "Space로 체크 안 됨");
    await A.key("Tab");
    // Walk forward until the approve button has focus.
    for (let i = 0; i < 6 && !(await A.focused()).includes("검토 후 승인"); i++) await A.key("Tab");
    const f = await A.focused();
    ok(f.includes("검토 후 승인"), `focus=${f}`);
    await A.key("Enter");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "approved", 15000, "approved");
    ctx.approved1 = true;
    return "approved";
  }, { needs: ["pending1"] });
  await step("W4 승인 해시", "승인 후 편집하면 화면에서 승인 해제(미저장)·내보내기 숨김", async () => {
    await A.fill("#title", `${kw} 해결 가이드 (승인 후 수정)`);
    ok(await A.hasText("저장하지 않은 변경 있음"), "dirty 표시 없음");
    ok((await A.buttonState("HTML 내보내기")) === "missing", "내보내기 노출");
    await A.reload();
    await A.waitText("진행 상태");
    ok((await statusOf(A, ctx.id1)) === "approved", "새로고침 후 승인 유지 안 됨");
    return "편집 취소 후 approved 유지";
  }, { needs: ["approved1"] });
  await step("W4 승인 해시", "전달 검사 RPC 통과", async () => {
    const r = await A.api("POST", `/api/articles/${ctx.id1}/delivery-check`, {});
    ok(r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
    return JSON.stringify(r.data).slice(0, 160);
  }, { needs: ["approved1"] });
  await step("W4 승인 해시", "HTML 내보내기 → export_ready·파일 다운로드", async () => {
    const before = A.downloads.length;
    await A.clickText("HTML 내보내기");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "export_ready", 15000, "export_ready");
    await A.waitFor(() => A.downloads.length > before, 15000, "download");
    const html = readdirSync(DL).find((f) => f.includes(ctx.id1));
    ok(html, "파일 없음");
    const text = readFileSync(resolve(DL, html), "utf8");
    ok(!/<script/i.test(text.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")), "script 포함");
    ctx.export1 = true;
    return html;
  }, { needs: ["approved1"] });

  // ===== W2 WordPress =====
  await step("W2 WordPress", "초안 보내기 → draft_created, 원격 slug=cf-<id>·draft", async () => {
    await A.clickText("WordPress 초안 보내기");
    await A.waitText("WordPress에 초안으로 만들었어요", 30000);
    ok((await statusOf(A, ctx.id1)) === "draft_created", "status");
    const r = await wp(`/posts?slug=cf-${ctx.id1}&status=any&context=edit`);
    ok(r.data?.length === 1 && r.data[0].status === "draft", JSON.stringify(r.data).slice(0, 200));
    ctx.wpPost1 = r.data[0].id;
    return `post ${ctx.wpPost1}`;
  }, { needs: ["export1"] });
  await step("W2 WordPress", "발행 기록: 상태 이력·전달 시도 표시", async () => {
    const r = await A.api("GET", `/api/articles/${ctx.id1}/history`);
    ok(r.status === 200, `${r.status}`);
    const s = JSON.stringify(r.data);
    ok(s.includes("draft_created") && s.includes("wordpress"), s.slice(0, 300));
    await A.reload();
    await A.waitText("발행 기록");
    const panel = await A.eval(`[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.innerText === '발행 기록')?.innerText || ''`);
    ok(panel.length > 10, "패널 비어 있음");
    const db = sqlJson(`select channel, attempt, failure_type from delivery_attempts where article_id = '${ctx.id1}'`);
    ok(db.length >= 1 && db[0].failure_type === null, JSON.stringify(db));
    return panel.replace(/\s+/g, " ").slice(0, 140);
  }, { needs: ["wpPost1"] });
  await step("W2 WordPress", "slug 선조회: 원격에 같은 slug 초안이 있으면 새로 만들지 않고 갱신", async () => {
    const base = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    const id2 = crypto.randomUUID();
    const a2 = await articleTo(A, { ...base, id: id2, title: `${kw} 선조회 확인`, keywordId: undefined, status: "drafting", publishedUrl: undefined, remote: undefined }, "export_ready");
    ctx.id2 = a2.id;
    const pre = await wp("/posts", { method: "POST", body: JSON.stringify({ title: "이전 시도에서 남은 초안", slug: `cf-${id2}`, status: "draft", content: "old" }) });
    ok(pre.status === 201, `wp pre ${pre.status}`);
    await openArticle(A, id2);
    await A.clickText("WordPress 초안 보내기");
    await A.waitText("WordPress에 초안으로 갱신했어요", 30000);
    const r = await wp(`/posts?slug=cf-${id2}&status=any&context=edit`);
    ok(r.data.length === 1, `원격 ${r.data.length}개`);
    ok(r.data[0].id === pre.data.id, "다른 글 생성");
    ok(r.data[0].slug === `cf-${id2}`, `slug ${r.data[0].slug}`);
    ok(r.data[0].title.raw === `${kw} 선조회 확인`, `title ${r.data[0].title.raw}`);
    return `post ${pre.data.id} 갱신, slug 유지`;
  }, { needs: ["export1"] });
  await step("W2 WordPress", "원격 글이 게시 상태면 덮어쓰지 않고 publish_failed(실패 경로)", async () => {
    const base = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    const id3 = crypto.randomUUID();
    await articleTo(A, { ...base, id: id3, title: `${kw} 원격 게시됨`, keywordId: undefined, status: "drafting", publishedUrl: undefined, remote: undefined }, "export_ready");
    const pre = await wp("/posts", { method: "POST", body: JSON.stringify({ title: "운영자가 이미 게시", slug: `cf-${id3}`, status: "publish", content: "live" }) });
    ok(pre.status === 201, `wp pre ${pre.status}`);
    await openArticle(A, id3);
    await A.clickText("WordPress 초안 보내기");
    await A.waitText("원격 글이 초안이 아닙니다", 30000);
    ok((await statusOf(A, id3)) === "publish_failed", "status");
    const after = await wp(`/posts/${pre.data.id}?context=edit`);
    ok(after.data.status === "publish" && after.data.content.raw === "live", "원격 글이 바뀜");
    const db = sqlJson(`select failure_type from delivery_attempts where article_id = '${id3}'`);
    ok(db.some((d) => d.failure_type === "remote_state"), JSON.stringify(db));
    ok(await A.hasText("WordPress 초안 다시 보내기"), "재시도 버튼 없음");
    return "remote_state 기록";
  }, { needs: ["export1"] });
  await step("W3 공개 URL", "잘못된 URL은 게시 완료 버튼 비활성, http(s) URL로 published", async () => {
    await openArticle(A, ctx.id1);
    await A.fill("#published-url", "ftp://example.test/post");
    ok((await A.buttonState("게시 완료 확인")) === "disabled", "ftp 허용");
    await A.fill("#published-url", "https://w8-blog.example.test/port-error");
    await A.clickText("게시 완료 확인");
    await A.waitFor(async () => (await statusOf(A, ctx.id1)) === "published", 15000, "published");
    const a = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    ok(a.publishedUrl === "https://w8-blog.example.test/port-error", a.publishedUrl);
    ctx.published1 = true;
    return a.publishedUrl;
  }, { needs: ["wpPost1"] });
  await step("W3 공개 URL", "DB 트리거: 게시 외 상태에서 published_url 변경 거절", async () => {
    const a = (await A.api("GET", `/api/articles/${ctx.id2}`)).data.article;
    const r = await A.api("PUT", `/api/articles/${ctx.id2}`, { ...a, publishedUrl: "https://evil.example.test/x" });
    const after = (await A.api("GET", `/api/articles/${ctx.id2}`)).data.article;
    ok(r.status >= 400 || !after.publishedUrl, `status ${r.status} url ${after.publishedUrl}`);
    return `HTTP ${r.status}`;
  }, { needs: ["id2"] });
  await step("W3 티스토리", "티스토리 패키지 다운로드 → 수동 게시 대기 확인", async () => {
    const base = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    const id4 = crypto.randomUUID();
    await articleTo(A, { ...base, id: id4, platform: "tistory", title: `${kw} 티스토리`, keywordId: undefined, status: "drafting", publishedUrl: undefined, remote: undefined }, "export_ready");
    await openArticle(A, id4);
    const before = A.downloads.length;
    await A.clickText("티스토리 패키지 받기");
    await A.waitFor(() => A.downloads.length > before, 15000, "zip download");
    await A.waitFor(`!!document.querySelector('[role=dialog]')`, 10000, "manual dialog");
    await A.key("Escape");
    ok(!(await A.eval(`!!document.querySelector('[role=dialog]')`)), "Escape로 안 닫힘");
    ok((await statusOf(A, id4)) === "export_ready", "다운로드만으로 상태 변경");
    const zip = readdirSync(DL).find((f) => f.endsWith(".zip"));
    ok(zip, "zip 없음");
    return zip;
  }, { needs: ["export1"] });

  // ===== 팀 =====
  await step("팀", "A가 B를 검수자로 초대(메일 미발송 안내)", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitFor(`!!document.querySelector("#invite-email")`, 30000, "invite form");
    await A.fill("#invite-email", emailB);
    await A.fill("#invite-role", "reviewer");
    await A.click("#invite-go");
    await A.waitText("님을 초대했어요");
    await A.waitText(`${emailB} · 검수자 · 대기 중`);
    ctx.invited = true;
  }, { needs: ["A"] });
  await step("팀", "B 가입 → 수락 전에는 A의 글 접근 차단(교차 워크스페이스)", async () => {
    await signup(B, emailB, PW_B);
    ctx.B = true;
    const r = await B.api("GET", `/api/articles/${ctx.id1}`);
    ok(r.status === 404 || r.status === 403, `status ${r.status}`);
    const list = await B.api("GET", "/api/articles");
    ok(!(list.data?.articles ?? []).some((a) => a.id === ctx.id1), "목록에 노출");
    return `HTTP ${r.status}`;
  }, { needs: ["invited"] });
  await step("팀", "B: 받은 초대 수락 → 워크스페이스 전환 표시·역할 검수자", async () => {
    await B.goto(`${APP}/settings`, { settle: 1500 });
    await B.waitText("받은 초대");
    await B.clickText("수락", { selector: '[aria-label="받은 초대"] button' });
    // The accept reloads /settings; the invitation box is gone afterwards.
    await B.waitFor(`location.pathname === "/settings" && !document.querySelector('[aria-label="받은 초대"]') && !!document.querySelector("#ws-switch")`, 30000, "reload after accept");
    await B.waitText("내 역할");
    const role = (await B.api("GET", "/api/session")).data?.user?.role;
    ok(role === "reviewer", `role ${role}`);
    ctx.accepted = true;
    return role;
  }, { needs: ["B"] });
  await step("팀", "검수자 B: 원고 수정 불가(입력 비활성·API 403)", async () => {
    await openArticle(B, ctx.id2);
    ok(await B.eval(`document.querySelector('#title').disabled`), "제목 편집 가능");
    ok(await B.hasText("검수자 권한이라 내용을 수정할 수 없어요"), "안내 없음");
    const a = (await B.api("GET", `/api/articles/${ctx.id2}`)).data.article;
    const r = await B.api("PUT", `/api/articles/${ctx.id2}`, { ...a, title: "검수자가 바꾼 제목" });
    ok(r.status === 403 || r.status === 400 || r.status === 409, `PUT ${r.status}`);
    const after = (await B.api("GET", `/api/articles/${ctx.id2}`)).data.article;
    ok(after.title !== "검수자가 바꾼 제목", "변경됨");
    return `PUT ${r.status}`;
  }, { needs: ["accepted"] });
  await step("팀", "A가 B를 읽기 전용으로 변경 → B 원가 입력 폼 숨김", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitFor(`!!document.querySelector('select[aria-label="${emailB} 역할"]')`, 20000, "role select");
    await A.fill(`select[aria-label="${emailB} 역할"]`, "viewer");
    await A.waitFor(`document.querySelector('select[aria-label="${emailB} 역할"]')?.value === "viewer"`, 15000, "role select value");
    await A.waitFor(async () => sql(`select m.role from memberships m join auth.users u on u.id = m.user_id where u.email = '${emailB}' and m.workspace_id = '${wsOf(emailA)}'`) === "viewer", 15000, "DB role viewer");
    await B.goto(`${APP}/analytics`, { settle: 2000 });
    await B.waitText("원가는 소유자·관리자만 기록할 수 있어요", 30000);
    ok(!(await B.eval(`!!document.querySelector('#cost-amount')`)), "원가 입력 노출");
    return "viewer";
  }, { needs: ["accepted"] });
  await step("팀", "B 워크스페이스 전환 → 자기 워크스페이스(소유자, 글 0)", async () => {
    await B.goto(`${APP}/settings`, { settle: 1500 });
    await B.waitFor(`!!document.querySelector("#ws-switch")`, 20000, "ws switch");
    const own = await B.eval(`[...document.querySelectorAll('#ws-switch option')].find(o => o.innerText.includes('소유자'))?.value`);
    ok(own, "자기 워크스페이스 없음");
    await B.fill("#ws-switch", own);
    await B.waitFor(async () => (await B.api("GET", "/api/session")).data?.user?.role === "owner", 20000, "owner");
    const list = await B.api("GET", "/api/articles");
    ok((list.data?.articles ?? []).length === 0, `글 ${list.data?.articles?.length}`);
    return "owner, 0건";
  }, { needs: ["accepted"] });

  // ===== 수익 (W6 보강) =====
  await step("수익", "가져오기 전 N/A 표시(가짜 0 금지)", async () => {
    await B.goto(`${APP}/analytics`, { settle: 2000 });
    await B.waitText("보고서를 가져오면 성장이 보입니다.", 30000);
    const v = await B.eval(`document.querySelector('.stat-card .stat-value').innerText`);
    ok(v.includes("N/A"), `값 ${v}`);
    return v;
  }, { needs: ["B"] });
  const rev1 = resolve(FILES, "revenue-1.csv");
  const rev2 = resolve(FILES, "revenue-overlap.csv");
  writeFileSync(rev1, "date,page,revenue,pageviews\n2026-10-01,https://w8-blog.example.test/port-error,1.25,500\n2026-10-02,https://w8-blog.example.test/port-error,0.75,300\n");
  writeFileSync(rev2, "date,page,revenue,pageviews\n2026-10-02,https://w8-blog.example.test/port-error,0.75,300\n2026-10-03,https://w8-blog.example.test/port-error,0.5,200\n");
  await step("수익", "CSV 가져오기 → 2행 추가·RPM 계산·글 연결", async () => {
    await A.goto(`${APP}/analytics`, { settle: 2000 });
    await A.waitFor(`!!document.querySelector('#rev-timezone')`, 30000, "revenue form");
    await A.fill("#rev-source", "AdSense");
    await A.fill("#rev-timezone", "Asia/Seoul");
    await A.upload('input[aria-label="수익 보고서 CSV 파일 선택"]', [rev1]);
    await A.waitText("2행 추가", 20000);
    await A.waitText("페이지별 수익");
    const cards = await A.eval(`[...document.querySelectorAll('.stat-card')].map(c => c.innerText.replace(/\\s+/g,' ')).join(' / ')`);
    ok(!cards.split(" / ")[0].includes("N/A"), cards);
    ctx.revenue = true;
    return cards.slice(0, 200);
  }, { needs: ["A"] });
  await step("수익", "같은 파일 재가져오기 → 0행 추가·중복 건너뜀", async () => {
    await A.upload('input[aria-label="수익 보고서 CSV 파일 선택"]', [rev1]);
    await A.waitText("0행 추가", 20000);
    const rows = (await A.api("GET", "/api/revenue")).data.rows.length;
    ok(rows === 2, `rows ${rows}`);
    return await statusText(A);
  }, { needs: ["revenue"] });
  await step("수익", "부분 중첩 파일 거절(실패 경로)", async () => {
    await A.upload('input[aria-label="수익 보고서 CSV 파일 선택"]', [rev2]);
    await A.waitText("일부만 겹쳐", 20000);
    const rows = (await A.api("GET", "/api/revenue")).data.rows.length;
    ok(rows === 2, `rows ${rows}`);
    return await alertText(A);
  }, { needs: ["revenue"] });
  await step("수익", "블로그 필터: 계정별 분류", async () => {
    const opts = await A.eval(`[...document.querySelectorAll('section[aria-label="블로그 계정 필터"] select option')].map(o => o.innerText)`);
    ok(opts.some((o) => o.includes("W8 워드프레스")), JSON.stringify(opts));
    return opts.join(",");
  }, { needs: ["revenue", "blogId"] });

  // ===== W6 원가·개선 큐 =====
  await step("W6 원가", "소액 원가 기록 → 정밀도 유지 합계, AI 추정 별도", async () => {
    await A.waitFor(`!!document.querySelector('#cost-amount')`, 20000, "cost form");
    await A.fill("#cost-amount", "0.0123");
    await A.fill("#cost-currency", "USD");
    await A.fill("#cost-note", "W8 API 원가");
    await A.clickText("원가 기록");
    await A.waitText("W8 API 원가");
    const sec = await A.eval(`[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.innerText === '제작 원가').innerText`);
    ok(sec.includes("0.0123"), "소액이 반올림됨");
    ok(sec.includes("AI 호출") && /회/.test(sec), "AI 추정 없음");
    ctx.cost = true;
    return sec.replace(/\s+/g, " ").slice(0, 200);
  }, { needs: ["A"] });
  await step("저장 실패", "원가 저장 500 → 메시지·입력 유지", async () => {
    await A.fill("#cost-amount", "5");
    await A.fill("#cost-note", "실패해야 하는 원가");
    const unroute = await A.route(`${APP}/api/costs*`, (req) => (req.method === "POST" ? { status: 500, body: { error: "E2E 원가 저장 실패" } } : undefined));
    try {
      await A.clickText("원가 기록");
      await A.waitText("E2E 원가 저장 실패");
    } finally {
      await unroute();
    }
    ok((await A.eval(`document.querySelector('#cost-amount').value`)) === "5", "금액 유실");
    return "입력 유지";
  }, { needs: ["cost"] });
  await step("키보드", "원가 삭제 대화상자: Enter 열기·포커스 가둠·Escape 닫기·포커스 복귀", async () => {
    await A.eval(`document.querySelector('button[aria-label$="원가 삭제"]').focus()`);
    await A.key("Enter");
    await A.waitFor(`!!document.querySelector('[role=dialog]')`, 5000, "dialog");
    const f1 = await A.focused();
    const inside = async () => A.eval(`!!document.activeElement.closest('[role=dialog]')`);
    ok(await inside(), `초기 포커스 ${f1}`);
    for (let i = 0; i < 4; i++) {
      await A.key("Tab");
      ok(await inside(), "Tab이 대화상자 밖으로 나감");
    }
    await A.key("Tab", { shift: true });
    ok(await inside(), "Shift+Tab이 밖으로 나감");
    await A.key("Escape");
    ok(!(await A.eval(`!!document.querySelector('[role=dialog]')`)), "Escape로 안 닫힘");
    const f2 = await A.focused();
    ok(f2.includes("원가 삭제"), `복귀 포커스 ${f2}`);
    ok(await A.hasText("W8 API 원가"), "취소했는데 삭제됨");
    return `초기=${f1}`;
  }, { needs: ["cost"] });
  await step("W6 개선 큐", "글 선택 시 공개 URL 자동 입력 → 개선 작업 추가", async () => {
    await A.waitFor(`!!document.querySelector('#improve-article option[value="${ctx.id1}"]')`, 20000, "article option");
    await A.fill("#improve-article", ctx.id1);
    const url = await A.eval(`document.querySelector('#improve-url').value`);
    ok(url === "https://w8-blog.example.test/port-error", `url ${url}`);
    const who = await A.eval(`[...document.querySelectorAll('#improve-assignee option')].map((o) => o.value).find(Boolean)`);
    ok(who, "담당자 선택지 없음");
    await A.fill("#improve-assignee", who);
    await A.fill("#improve-evidence", "CTR 0.8%로 관측");
    const today = new Date().toISOString().slice(0, 10);
    await A.fill("#improve-from", "2026-10-01");
    await A.fill("#improve-to", "2026-10-31");
    await A.fill("#improve-review", today);
    await A.clickText("개선 작업 추가");
    const sel = `[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.innerText === '개선 큐')?.querySelector('[role=status]')?.innerText || ''`;
    const msg = await A.waitFor(sel, 15000, "improvement message");
    ok(msg.includes("개선 큐에 추가했어요."), `메시지: ${msg}`);
    return url;
  }, { needs: ["published1"] });

  // ===== W11 성과 기록 =====
  await step("W11 성과", "블로그지수 기록 → 추이·목록 표시, 비공식 안내", async () => {
    await A.waitFor(`!!document.querySelector('#metric-name')`, 20000, "metric form");
    if (ctx.blogId) await A.fill("#metric-blog", ctx.blogId);
    await A.fill("#metric-name", "블로그지수");
    await A.fill("#metric-value", "42");
    await A.fill("#metric-evidence", "https://tool.example.test/report");
    await A.eval(`document.querySelector('#metric-value').closest('form').requestSubmit()`);
    await A.waitFor(async () => (await A.api("GET", "/api/blog-metrics")).data?.rows?.some((r) => String(r.value) === "42"), 15000, "metric saved");
    const secExpr = `[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.innerText.startsWith('기록 목록'))?.innerText || ''`;
    await A.waitFor(`(${secExpr}).includes('42')`, 15000, "기록 목록 갱신").catch(() => {});
    const sec = await A.eval(secExpr);
    ok(sec.includes("42"), sec.slice(0, 120));
    ok(await A.hasText("공식"), "비공식 안내 없음");
    return sec.replace(/\s+/g, " ").slice(0, 160);
  }, { needs: ["A"] });
  await step("W11 성과", "값 없이 저장 거절(실패 경로)", async () => {
    await A.fill("#metric-name", "방문자 수");
    await A.fill("#metric-value", "");
    await A.eval(`document.querySelector('#metric-value').closest('form').requestSubmit()`);
    await sleep(800);
    const r = (await A.api("GET", "/api/blog-metrics")).data;
    const n = JSON.stringify(r).split("방문자 수").length - 1;
    ok(n === 0, "빈 값 저장됨");
    return "저장 안 됨";
  }, { needs: ["A"] });

  // ===== W10 트렌드 =====
  await step("W10 트렌드", "직접 입력 2건 → 기회 점수·순위, 누락 입력은 N/A", async () => {
    await A.goto(`${APP}/trends`, { settle: 2000 });
    await A.waitFor(`!!document.querySelector('#trend-keyword') && !document.body.innerText.includes('불러오는 중')`, 30000, "trend form");
    if (ctx.blogId) await A.fill("#trend-blog", ctx.blogId);
    await A.fill("#trend-source", "블랙키위");
    const add = async (k, v, g, d) => {
      await A.fill("#trend-keyword", k);
      await A.fill("#trend-form-category", "개발");
      await A.fill("#trend-volume", v);
      await A.fill("#trend-growth", g);
      await A.fill("#trend-documents", d);
      await A.eval(`document.querySelector('#trend-keyword').closest('form').requestSubmit()`);
      await A.waitText("저장했어요.");
      await A.eval(`(() => { const p = [...document.querySelectorAll('[role=alert]')].find(e => e.innerText.includes('저장했어요')); if (p) p.textContent = ''; })()`);
    };
    await add(`트렌드A ${stamp}`, "12000", "35", "4000");
    await add(`트렌드B ${stamp}`, "3000", "5", "");
    await A.waitText(`트렌드B ${stamp}`);
    const table = await A.eval(`[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.innerText.startsWith('키워드 순위'))?.innerText || ''`);
    ok(table.includes(`트렌드A ${stamp}`) && table.includes("N/A"), table.slice(0, 200));
    ctx.trends = true;
    return table.replace(/\s+/g, " ").slice(0, 200);
  }, { needs: ["A"] });
  await step("W10 트렌드", "같은 값 재입력 → 기존 값 유지(중복)", async () => {
    await A.fill("#trend-keyword", `트렌드A ${stamp}`);
    await A.fill("#trend-form-category", "개발");
    await A.fill("#trend-volume", "12000");
    await A.fill("#trend-growth", "35");
    await A.fill("#trend-documents", "4000");
    await A.eval(`document.querySelector('#trend-keyword').closest('form').requestSubmit()`);
    await A.waitText("기존 값을 유지했어요");
  }, { needs: ["trends"] });
  await step("W10 트렌드", "순위표에서 글 만들기 → 아이디어 글", async () => {
    await A.clickText("글 만들기", { selector: ".trend-actions button" });
    await A.waitText("아이디어 단계로 만들었어요");
    return "created";
  }, { needs: ["trends"] });

  // ===== W5 사이트 점검 =====
  await step("W5 사이트 점검", "첫 항목 확인 기록 → 기록 요약 갱신", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitFor(`!!document.querySelector('.site-check form')`, 30000, "site check form");
    const id = await A.eval(`document.querySelector('.site-check select').id`);
    const opt = await A.eval(`[...document.querySelector('.site-check select').options].map(o => o.value).find(v => v !== document.querySelector('.site-check select').value)`);
    await A.fill(`#${id}`, opt);
    await A.fill(`#${id.replace(/-status$/, "-url")}`, "https://w8-blog.example.test/privacy");
    await A.fill(`#${id.replace(/-status$/, "-note")}`, "W8 확인");
    await A.eval(`document.querySelector('.site-check form').requestSubmit()`);
    await A.waitText("기록했어요.");
    await A.waitText("기록 1/");
    ctx.site = { id };
    return `${id}=${opt}`;
  }, { needs: ["A"] });
  await step("저장 실패", "사이트 점검 저장 500 → 오류·입력 유지", async () => {
    const id = ctx.site.id;
    await A.fill(`#${id.replace(/-status$/, "-note")}`, "W8 실패 재시도");
    const unroute = await A.route(`${APP}/api/site-checks*`, (req) => (req.method === "POST" ? { status: 500, body: { error: "E2E 점검 저장 실패" } } : undefined));
    try {
      await A.eval(`document.querySelector('.site-check form').requestSubmit()`);
      await A.waitText("E2E 점검 저장 실패");
    } finally {
      await unroute();
    }
    ok((await A.eval(`document.querySelector('#${id.replace(/-status$/, "-note")}').value`)) === "W8 실패 재시도", "입력 유실");
  }, { needs: ["site"] });

  // ===== 키보드 (탐색) =====
  await step("키보드", "첫 Tab = 본문 건너뛰기 링크, Enter로 main 이동", async () => {
    await A.goto(`${APP}/`, { settle: 1500 });
    await A.eval(`document.activeElement && document.activeElement.blur()`);
    await A.key("Tab");
    const f = await A.focused();
    ok(/main-content|건너뛰|바로가기/.test(f), `first focus ${f}`);
    await A.key("Enter");
    await sleep(300);
    ok(await A.eval(`location.hash === "#main-content"`), "이동 안 됨");
    return f;
  }, { needs: ["A"] });
  await step("키보드", "Tab으로 주 메뉴 '콘텐츠' 도달 → Enter로 이동", async () => {
    await A.goto(`${APP}/`, { settle: 1500 });
    await A.eval(`document.activeElement && document.activeElement.blur()`);
    let f = "";
    for (let i = 0; i < 15; i++) {
      await A.key("Tab");
      f = await A.focused();
      if (/^A 콘텐츠$/.test(f) || f.startsWith("A 콘텐츠")) break;
    }
    ok(f.startsWith("A 콘텐츠"), `focus ${f}`);
    const visible = await A.eval(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return s.outlineStyle !== "none" || s.boxShadow !== "none"; })()`);
    await A.key("Enter");
    await A.waitFor(`location.pathname === "/content"`, 15000, "/content");
    return `포커스 표시 ${visible ? "있음" : "없음(확인 필요)"}`;
  }, { needs: ["A"] });
  await step("키보드", "모바일(375) 메뉴 버튼 Enter로 열기·닫기", async () => {
    await A.viewport(375, 812);
    await A.goto(`${APP}/`, { settle: 1500 });
    await A.eval(`document.querySelector('button[aria-label="메뉴 열기"]').focus()`);
    await A.key("Enter");
    await A.waitFor(`!!document.querySelector('button[aria-label="메뉴 닫기"]')`, 5000, "menu open");
    const navVisible = await A.eval(`(() => { const r = document.querySelector('nav[aria-label="주 메뉴"]').getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.width > 0; })()`);
    ok(navVisible, "메뉴가 화면 밖");
    await A.screenshot(resolve(SHOTS, "mobile-menu-open-375.png"), { full: false });
    await A.key("Escape");
    await sleep(200);
    const closedByEsc = await A.eval(`!!document.querySelector('button.mobile-menu[aria-label="메뉴 열기"]')`);
    if (!closedByEsc) {
      await A.eval(`document.querySelector('button.mobile-menu').focus()`);
      await A.key("Enter");
    }
    await A.viewport(1280, 900);
    return closedByEsc ? "Escape로 닫힘" : "Escape 미지원, 버튼으로 닫힘";
  }, { needs: ["A"] });

  // ===== W9 보관 계정 · 설정 대상 표시 =====
  await step("W9 블로그 계정", "보관한 계정에는 새 연결 409(글·성과), 복원 후 연결 가능", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitFor(`!!document.querySelector("#blog-name")`, 30000, "blog form");
    await A.fill("#blog-name", "W8 보관용");
    await A.fill("#blog-platform", "wordpress");
    await A.fill("#blog-domain", "w8-archive.example.test");
    await A.clickText("계정 추가");
    await A.waitText("w8-archive.example.test");
    const blog = ((await A.api("GET", "/api/blogs")).data?.blogs ?? []).find((b) => b.domain === "w8-archive.example.test");
    ok(blog, "계정 생성 실패");
    await A.clickText("W8 보관용 보관", { selector: "button" });
    await A.waitText("블로그 계정을 보관했어요.");
    ok((await A.api("GET", "/api/blogs")).data.blogs.find((b) => b.id === blog.id).status === "archived", "보관 안 됨");
    const art = (await A.api("GET", `/api/articles/${ctx.id1}`)).data.article;
    const put = await A.api("PUT", `/api/articles/${ctx.id1}`, { ...art, blogId: blog.id, updatedAt: new Date().toISOString() });
    ok(put.status === 409, `글 연결 status ${put.status} ${JSON.stringify(put.data).slice(0, 120)}`);
    const metric = await A.api("POST", "/api/blog-metrics", { rows: [{ blogId: blog.id, tool: "other", metric: "w8", scope: "site", dimension: "", value: 1, valueLabel: null, unit: "", measuredOn: "2026-10-01", evidenceUrl: null, memo: "" }] });
    ok(metric.status === 409, `성과 기록 status ${metric.status}`);
    ok(String(put.data?.error).includes("보관된 블로그 계정"), String(put.data?.error));
    await A.clickText("W8 보관용 복원", { selector: "button" });
    await A.waitText("블로그 계정을 복원했어요.");
    const back = await A.api("PUT", `/api/articles/${ctx.id1}`, { ...art, blogId: blog.id, updatedAt: new Date().toISOString() });
    ok(back.status === 200, `복원 후 연결 status ${back.status} ${JSON.stringify(back.data).slice(0, 120)}`);
    await A.api("PUT", `/api/articles/${ctx.id1}`, { ...back.data.article, blogId: ctx.blogId, updatedAt: new Date().toISOString() });
    return "409/409 → 복원 후 200";
  }, { needs: ["published1"] });
  await step("설정", "Supabase 대상 'Docker 로컬 Supabase' 표시", async () => {
    await A.goto(`${APP}/settings`, { settle: 1500 });
    await A.waitText("Docker 로컬 Supabase", 20000);
    return "표시됨";
  }, { needs: ["A"] });

  // ===== 3구간 화면 =====
  const pages = [
    ["dashboard", "/"],
    ["content", "/content"],
    ["editor", ctx.id1 ? `/content/${ctx.id1}` : "/content/new"],
    ["keywords", "/keywords"],
    ["trends", "/trends"],
    ["templates", "/templates"],
    ["analytics", "/analytics"],
    ["settings", "/settings"],
  ];
  for (const w of [500, 768, 1000, 1440]) {
    await step("3구간 화면", `${w}px 8개 화면 스크린샷·가로 넘침 검사`, async () => {
      await A.viewport(w, w < 768 ? 812 : 900);
      const over = [];
      for (const [name, path] of pages) {
        await A.goto(`${APP}${path}`, { settle: 1800 });
        const o = await A.overflow();
        if (o.over) over.push(`${name}(${o.sw}>${o.w}, 사용자 가로 스크롤 ${o.scrollable ? "가능" : "불가"}: ${o.wide.join(" ")})`);
        await A.screenshot(resolve(SHOTS, `${name}-${w}.png`));
      }
      ok(over.length === 0, `가로 넘침: ${over.join("; ")}`);
      return `shots/${"*"}-${w}.png`;
    }, { needs: ["A"] });
  }
  await step("3구간 화면", "로그인 화면 500/768/1000/1440", async () => {
    const C = await browser.newPage({ width: 500 });
    const over = [];
    for (const w of [500, 768, 1000, 1440]) {
      await C.viewport(w, 900);
      await C.goto(`${APP}/login`, { settle: 800 });
      const o = await C.overflow();
      if (o.over) over.push(`${w}:${o.sw}`);
      await C.screenshot(resolve(SHOTS, `login-${w}.png`));
    }
    ok(over.length === 0, over.join(","));
  });
  await A.viewport(1280, 900);

  // ===== 비밀번호 복구 =====
  await step("인증", "비밀번호 재설정 메일 → 링크 → 새 비밀번호 → 재로그인", async () => {
    await A.clickText("로그아웃");
    await A.waitFor(`location.pathname === "/login"`, 20000, "login");
    // Client handlers attach after hydration: retry the mode switch until the heading changes.
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      await A.clickText("비밀번호를 잊으셨나요?");
      if (await A.hasText("재설정 링크를 보내드려요")) break;
    }
    await A.fill("#email", emailA);
    await A.click("button[type=submit]");
    await A.waitFor(`!!document.querySelector("[role=status]:not(.feedback-region [role=status]), [role=alert]")`, 45000, `reset response (화면: ${await A.eval("location.pathname + ' ' + document.querySelector('h1')?.innerText")})`);
    ok(await A.hasText("재설정 메일을 보냈어요"), "응답: " + (await alertText(A)));
    let link;
    await A.waitFor(async () => {
      const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent("to:" + emailA)}`)).json();
      const m = list.messages?.[0];
      if (!m) return false;
      const msg = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      link = /href="([^"]+)"/.exec(msg.HTML ?? "")?.[1]?.replace(/&amp;/g, "&") ?? /(http\S+verify\S+)/.exec(msg.Text ?? "")?.[1];
      return !!link;
    }, 30000, "reset mail");
    await A.goto(link, { settle: 1500 });
    try {
      await A.waitFor(`location.pathname === "/reset" && location.origin === "${APP}"`, 15000, "redirect to /reset");
    } catch {
      ctx.resetRedirectBug = `${await A.eval("location.href")} (기대 ${APP}/reset)`;
      await A.screenshot(resolve(SHOTS, "reset-redirect-wrong-origin.png"), { full: false });
      await A.goto(`${APP}/reset`, { settle: 1000 }); // 이후 흐름은 같은 세션 쿠키로 계속 검증
    }
    await A.fill("#new-password", PW_A2);
    await A.fill("#new-password-again", PW_A2);
    await A.click("button[type=submit]");
    await A.waitFor(`!!document.querySelector('[role=status]:not(.feedback-region [role=status])') || !!document.querySelector('[role=alert]')`, 15000, "reset result");
    ok(!(await A.eval(`!!document.querySelector('[role=alert]')`)), await alertText(A));
    await A.api("POST", "/api/auth/logout");
    await login(A, emailA, PW_A2);
    await A.waitFor(`location.pathname === "/"`, 20000, "login with new password");
    return "새 비밀번호 로그인" + (ctx.resetRedirectBug ? " (메일 링크 리다이렉트 이상 우회)" : "");
  }, { needs: ["A"] });
  await step("인증", "메일 링크 콜백이 앱 주소(127.0.0.1)로 돌아온다", async () => {
    ok(!ctx.resetRedirectBug, "콜백 후 이동한 곳: " + ctx.resetRedirectBug);
  }, { needs: ["A"] });

  ctx.consoleErrors = { A: A.errors.slice(0, 10), B: B.errors.slice(0, 10), dialogs: A.dialogs };
} finally {
  await browser.close();
}

// ---- report --------------------------------------------------------------------------------
const count = (s) => results.filter((r) => r.status === s).length;
const lines = [
  `# W8 브라우저 e2e 결과 (${new Date().toISOString()})`,
  "",
  `환경: next dev 127.0.0.1:${new URL(APP).port} · 로컬 Supabase(60321) · WordPress 컨테이너(8081) · 가짜 AI(${new URL(AI).port}) · 헤드리스 Chrome(CDP)`,
  `사용자: A=${emailA}, B=${emailB} (테스트 전용)`,
  `합계: PASS ${count("PASS")} · FAIL ${count("FAIL")} · SKIP ${count("SKIP")}`,
  "",
  "| 흐름 | 시나리오 | 결과 | 근거/오류 |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.flow} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
  "",
  `스크린샷: ${resolve(FINAL, "shots")}`,
  `브라우저 예외: ${JSON.stringify(ctx.consoleErrors ?? {}).slice(0, 800)}`,
];
writeFileSync(resolve(OUT, "results.md"), lines.join("\n"));
writeFileSync(resolve(OUT, "results.json"), JSON.stringify({ results, ctx }, null, 2));
for (const d of ["shots", "files", "downloads", "results.md", "results.json"])
  cpSync(resolve(OUT, d), resolve(FINAL, d), { recursive: true });
console.log(`\nPASS ${count("PASS")} FAIL ${count("FAIL")} SKIP ${count("SKIP")} -> ${resolve(FINAL, "results.md")}`);
process.exit(count("FAIL") ? 1 : 0);
